//! Orquestación del Context Engine 2.0 dentro de `Studio` (1.0.11, fase 2).
//!
//! - Prepara los dos planes de cada envío (sesión reanudada y sesión nueva) con memoria, historial y
//!   presupuesto adaptable (`context::build`).
//! - Sigue la entrega de cada turno: **preparado** → **enviado** → **confirmado**. Solo una entrega
//!   confirmada avanza el cursor de la sesión (`provider_sessions.last_seq`) y marca como recibidas las
//!   revisiones de memoria. Una entrega enviada sin confirmar queda **incierta**: el cursor no avanza y
//!   el siguiente turno la reenvía avisando de un posible duplicado, sin repetir la tarea. Una entrega
//!   rechazada por el proveedor (o que nunca salió) queda **no enviada**.
//! - Compactación nativa explícita de cada proveedor y estado del contexto para el compositor.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

use super::context::{self, AttachmentStatus, ContextInput, ContextPlan, ContextPrefs, NativeWindow};
use super::{claude, codex, Run, Studio};
use crate::db::memory::{Delivery, Memory};
use crate::db::{Conversation, Message, ProviderSession};
use crate::util::now_ms;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    #[default]
    Prepared,
    Sent,
    Confirmed,
}

type Revisions = Vec<(String, i64)>;

/// Qué se preparó para un turno y hasta dónde se sabe que llegó.
#[derive(Default)]
pub struct DeliveryTrack {
    pub stage: Stage,
    pub resume: bool,
    pub user_message_id: String,
    pub user_seq: i64,
    pub fresh: (Revisions, Revisions),
    pub resumed: Option<(Revisions, Revisions)>,
}

impl DeliveryTrack {
    pub fn new(user: &Message, resume: Option<&ContextPlan>, fresh: &ContextPlan) -> Self {
        DeliveryTrack {
            stage: Stage::Prepared,
            resume: resume.is_some(),
            user_message_id: user.id.clone(),
            user_seq: user.seq,
            fresh: (fresh.memories.clone(), fresh.retracted.clone()),
            resumed: resume.map(|p| (p.memories.clone(), p.retracted.clone())),
        }
    }
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

/// Ventana nativa conocida para una sesión: solo datos que comunicó el proveedor en esa misma sesión.
pub fn native_window(history: &[Message], agent: &str, session: Option<&ProviderSession>) -> (NativeWindow, Value) {
    let Some(session) = session else { return (NativeWindow::default(), Value::Null) };
    let last = history.iter().rev().find(|m| {
        m.role == "assistant" && m.agent.as_deref() == Some(agent) && m.status != "running"
            && m.usage["sessionId"].as_str() == Some(session.session_id.as_str())
    });
    let compaction = &session.native_context["compaction"];
    let compacted_at = (compaction["state"] == "completed").then(|| compaction["at"].as_i64()).flatten();
    let Some(m) = last else {
        let tokens = compacted_at.and(compaction["postTokens"].as_i64());
        return (NativeWindow { context_window: None, context_tokens: tokens, max_output: None },
            json!({ "model": Value::Null, "updatedAt": compacted_at, "source": if tokens.is_some() { "compaction" } else { "none" } }));
    };
    let pos = |v: &Value| v.as_i64().filter(|n| *n > 0);
    let window = pos(&m.usage["contextWindow"]);
    let max_output = pos(&m.usage["maxOutputTokens"]);
    let finished = m.completed_at.unwrap_or(m.created_at);
    let (tokens, source, updated) = match compacted_at {
        // Tras una compactación posterior al último turno, solo vale lo que comunicó el proveedor al compactar.
        Some(at) if at > finished => (compaction["postTokens"].as_i64(), "compaction", at),
        _ => (pos(&m.usage["contextTokens"]), "provider", finished),
    };
    (
        NativeWindow { context_window: window, context_tokens: tokens, max_output },
        json!({ "model": m.model, "updatedAt": updated, "source": if tokens.is_some() { source } else { "none" } }),
    )
}

impl Studio {
    pub(super) fn context_memories(&self, conv: &Conversation) -> Result<Vec<Memory>> {
        self.db.memories_for_context(&conv.id)
    }

    fn context_deliveries(&self, conv: &Conversation, agent: &str, session: &str, account: Option<&str>) -> Result<HashMap<String, Delivery>> {
        let mut delivered = self.db.memory_deliveries(&conv.id, agent, session, account)?;
        let native = &conv.origin["native"][agent];
        let cut = (native["state"] == "pending" && native["sessionId"].as_str() == Some(session))
            .then(|| native["lastSeq"].as_i64()).flatten();
        if self.db.legacy_withdrawal_pending(&conv.id, agent, session, account, cut)? {
            delivered.insert(crate::db::instructions::RETIREMENT_KEY.into(), Delivery { revision: 1, state: "confirmed".into() });
        }
        Ok(delivered)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_deliveries(&self, run: &Run, session: &str, account: Option<&str>, memories: &[(String, i64)], retracted: &[(String, i64)], confirmed: bool) {
        let ordinary: Vec<_> = retracted.iter().filter(|(id, _)| !id.starts_with(crate::db::instructions::CONTEXT_PREFIX)).cloned().collect();
        let _ = self.db.record_memory_deliveries(&run.conversation_id, &run.agent, session, account, &run.message_id, memories, &ordinary, confirmed);
        if confirmed && retracted.iter().any(|(id, _)| id == crate::db::instructions::RETIREMENT_KEY) {
            let _ = self.db.confirm_legacy_withdrawal(&run.conversation_id, &run.agent, session, account, &run.message_id);
        }
    }

    fn invalidate_deliveries(&self, conversation_id: &str, agent: &str, session: &str) {
        let _ = self.db.invalidate_memory_deliveries(conversation_id, agent, session);
    }

    /// Planes de contexto para un envío: con la sesión existente (si la hay) y para una sesión nueva.
    pub(super) fn context_plans(
        &self, conv: &Conversation, agent: &str, history: &[Message], session: Option<&ProviderSession>, user_text: &str, root: &str,
    ) -> Result<(Option<ContextPlan>, ContextPlan)> {
        let prefs = self.effective_prefs(conv);
        let memories = self.context_memories(conv)?;
        let check = self.attachment_checker(root);
        let (window, _) = native_window(history, agent, session);
        let none = HashMap::new();
        let resume = match session {
            Some(s) => {
                let delivered = self.context_deliveries(conv, agent, &s.session_id, s.account_id.as_deref())?;
                Some(context::build(&ContextInput {
                    history, target_agent: agent, seen_until: Some(s.last_seq), uncertain_from: s.uncertain_seq,
                    memories: &memories, delivered: &delivered, prefs: &prefs, native: window, user_text,
                    rebuilt: false, attachment_status: Some(&check),
                }))
            }
            None => None,
        };
        // Una sesión nueva solo conoce la ventana del modelo; su ocupación todavía no existe.
        let fresh_window = NativeWindow { context_window: window.context_window, context_tokens: None, max_output: window.max_output };
        let fresh = context::build(&ContextInput {
            history, target_agent: agent, seen_until: None, uncertain_from: None, memories: &memories, delivered: &none,
            // Sin la sesión anterior (o en una bifurcación o importación que no pudo continuar de forma
            // nativa) la sesión nueva se presenta como reconstruida, nunca como la original.
            prefs: &prefs, native: fresh_window, user_text, rebuilt: session.is_some() || conv.origin["native"][agent].is_object(),
            attachment_status: Some(&check),
        });
        Ok((resume, fresh))
    }

    /// Preferencias efectivas de una conversación: las suyas si eligió un modo; si no, las globales
    /// de Ajustes → Contexto y memoria (`context.enabled`, `context.mode`).
    pub fn effective_prefs(&self, conv: &Conversation) -> ContextPrefs {
        let mut prefs = ContextPrefs::from_value(&conv.context_prefs);
        if conv.context_prefs["mode"].is_string() {
            return prefs;
        }
        let enabled = self.setting_bool("context.enabled", true);
        let global = self.db.get_setting("context.mode").and_then(|v| serde_json::from_value::<context::Mode>(v).ok())
            .filter(|m| matches!(m, context::Mode::Auto | context::Mode::Economy | context::Mode::Full))
            .unwrap_or_default();
        prefs.mode = if enabled { global } else { context::Mode::Off };
        prefs
    }

    fn resend_after_compaction(&self) -> bool {
        self.setting_bool("context.resendAfterCompaction", true)
    }

    fn attachment_checker(&self, root: &str) -> impl Fn(&str) -> AttachmentStatus {
        let root = normalize(root);
        let cache = self.app.path().app_cache_dir().ok().map(|p| normalize(&p.to_string_lossy()));
        move |path: &str| {
            if !Path::new(path).exists() {
                return AttachmentStatus::Missing;
            }
            let p = normalize(path);
            let inside = |base: &str| p == base || p.starts_with(&format!("{base}/"));
            // Las capturas de Live Preview viven en la caché de Duovra y siguen siendo de este espacio.
            if inside(&root) || cache.as_deref().is_some_and(inside) {
                AttachmentStatus::Available
            } else {
                AttachmentStatus::OutsideWorkspace
            }
        }
    }

    // ---------- Seguimiento de la entrega ----------

    pub fn context_chosen(&self, run: &Run, resume: bool) {
        let mut d = run.delivery.lock();
        d.resume = resume && d.resumed.is_some();
    }

    pub fn context_sent(&self, run: &Run) {
        // Revisiones y comandos del proveedor no llevan el contexto compartido (fase 5).
        if run.review.is_some() || run.raw_prompt.is_some() { return; }
        let mut d = run.delivery.lock();
        if d.stage == Stage::Prepared {
            d.stage = Stage::Sent;
        }
    }

    pub fn context_confirmed(&self, run: &Run) {
        if run.review.is_some() || run.raw_prompt.is_some() { return; }
        run.delivery.lock().stage = Stage::Confirmed;
    }

    /// El proveedor rechazó el turno antes de aceptarlo: el contexto no llegó.
    pub fn context_rejected(&self, run: &Run) {
        let mut d = run.delivery.lock();
        if d.stage == Stage::Sent {
            d.stage = Stage::Prepared;
        }
    }

    /// Cierre de la entrega al terminar el turno (llamado desde `finish`).
    pub(super) fn settle_delivery(&self, run: &Run, session: Option<&str>, assistant_seq: Option<i64>) {
        let (stage, user_id, user_seq, memories, retracted) = {
            let d = run.delivery.lock();
            if d.user_message_id.is_empty() {
                return;
            }
            let (m, r) = if d.resume { d.resumed.clone().unwrap_or_default() } else { d.fresh.clone() };
            (d.stage, d.user_message_id.clone(), d.user_seq, m, r)
        };
        let account = run.account_id.as_deref();
        let state = match (stage, session) {
            (Stage::Confirmed, Some(sid)) => {
                if let Some(seq) = assistant_seq {
                    let _ = self.db.upsert_provider_session(&run.conversation_id, &run.agent, sid, seq, account);
                }
                self.record_deliveries(run, sid, account, &memories, &retracted, true);
                let _ = self.db.purge_memory_tombstones(&run.conversation_id);
                "confirmed"
            }
            (Stage::Confirmed, None) => "confirmed",
            (Stage::Sent, Some(sid)) => {
                let _ = self.db.mark_session_uncertain(&run.conversation_id, &run.agent, sid, account, user_seq);
                self.record_deliveries(run, sid, account, &memories, &retracted, false);
                "uncertain"
            }
            (Stage::Sent, None) => "uncertain",
            (Stage::Prepared, _) => "notSent",
        };
        if let Ok(msg) = self.db.get_message(&user_id) {
            let mut note = if msg.context_note.is_object() { msg.context_note } else { json!({}) };
            note["state"] = json!(state);
            note["settledAt"] = json!(now_ms());
            self.set_context_note(&user_id, &note);
        }
    }

    // ---------- Compactación nativa ----------

    /// Una compactación observada durante un turno (automática del proveedor).
    pub fn native_compacted(&self, run: &Run, detail: Value) {
        let Some(sid) = run.state.lock().session_id.clone() else { return };
        let mut c = detail;
        c["state"] = json!("completed");
        c["at"] = json!(now_ms());
        let _ = self.db.patch_native_context(&run.conversation_id, &run.agent, &sid, &json!({ "compaction": c }));
        if self.resend_after_compaction() {
            self.invalidate_deliveries(&run.conversation_id, &run.agent, &sid);
        }
    }

    /// Avanza el estado de una compactación en curso (nunca retrocede).
    pub fn compaction_progress(&self, conversation_id: &str, agent: &str, state: &str) {
        const ORDER: [&str; 4] = ["requested", "accepted", "started", "running"];
        let rank = |s: &str| ORDER.iter().position(|x| *x == s).unwrap_or(0);
        {
            let mut map = self.compactions.lock();
            let Some(entry) = map.get_mut(conversation_id) else { return };
            if entry.0 != agent || rank(&entry.1) >= rank(state) {
                return;
            }
            entry.1 = state.to_owned();
        }
        self.emit(json!({ "type": "compaction", "conversationId": conversation_id, "agent": agent, "state": state }));
    }

    pub fn compaction_finished(&self, conversation_id: &str, agent: &str, session_id: &str, state: &str, error: Option<String>, detail: Value) {
        self.compactions.lock().remove(conversation_id);
        let mut record = detail.clone();
        record["state"] = json!(state);
        record["at"] = json!(now_ms());
        record["error"] = json!(error);
        if !session_id.is_empty() {
            let _ = self.db.patch_native_context(conversation_id, agent, session_id, &json!({ "compaction": record }));
            if state == "completed" && self.resend_after_compaction() {
                self.invalidate_deliveries(conversation_id, agent, session_id);
            }
        }
        self.emit(json!({
            "type": "compaction", "conversationId": conversation_id, "agent": agent, "state": state,
            "error": error, "detail": detail,
        }));
    }

    pub fn compacting(&self, conversation_id: &str) -> bool {
        self.compactions.lock().contains_key(conversation_id)
    }

    /// Compacta la sesión nativa del agente en esta conversación. Solo con la conversación inactiva;
    /// no toca el historial visible de Duovra, ni la otra sesión, ni archivos del proyecto.
    pub async fn compact_native(self: &Arc<Self>, conversation_id: &str, agent: &str) -> Result<()> {
        if !super::AGENTS.contains(&agent) {
            bail!("Agente desconocido: {agent}");
        }
        let conv = self.db.get_conversation(conversation_id)?;
        let account = self.active_account(agent);
        let account_id = account.as_ref().map(|a| a.id.clone());
        let session = self.db.get_provider_session(&conv.id, agent)?
            .filter(|s| s.account_id == account_id)
            .ok_or_else(|| anyhow!("Este agente todavía no tiene una sesión nativa en esta conversación con la cuenta activa."))?;
        let root = self.db.conversation_root(&conv.id)?;
        {
            let _gate = self.lifecycle.lock();
            if self.conv_runs.lock().contains_key(&conv.id) || self.steering.lock().contains(&conv.id) {
                bail!("Hay una ejecución activa en esta conversación: espera a que termine antes de compactar.");
            }
            let mut map = self.compactions.lock();
            if map.contains_key(&conv.id) {
                bail!("Ya hay una compactación en curso en esta conversación.");
            }
            map.insert(conv.id.clone(), (agent.to_owned(), "requested".to_owned()));
        }
        self.emit(json!({ "type": "compaction", "conversationId": conv.id, "agent": agent, "state": "requested" }));
        let config_dir = account.and_then(|a| a.config_dir);
        let result = match agent {
            "codex" => codex::compact(self.clone(), &conv.id, &session.session_id, config_dir, &root).await,
            _ => {
                let model = conv.agent_prefs["claude"]["model"].as_str().map(str::to_owned)
                    .or_else(|| self.db.list_messages(&conv.id).ok()?.into_iter().rev()
                        .find(|m| m.role == "assistant" && m.agent.as_deref() == Some("claude")).and_then(|m| m.model));
                match model {
                    Some(model) => claude::compact(self.clone(), conv.id.clone(), session.session_id.clone(), config_dir, PathBuf::from(&root), model).await,
                    None => Err(anyhow!("No se conoce el modelo de la sesión de Claude Code.")),
                }
            }
        };
        if let Err(e) = &result {
            self.compaction_finished(&conv.id, agent, &session.session_id, "failed", Some(format!("{e:#}")), json!({}));
        }
        result
    }

    // ---------- Estado para el compositor ----------

    /// Estado del contexto de una conversación para el agente seleccionado. Se calcula bajo demanda
    /// (al abrir el indicador o tras un turno), nunca mientras el usuario escribe.
    pub fn context_status(&self, conversation_id: &str, agent: &str, include_block: bool) -> Result<Value> {
        if !super::AGENTS.contains(&agent) {
            bail!("Agente desconocido: {agent}");
        }
        let conv = self.db.get_conversation(conversation_id)?;
        let history = self.db.list_messages(&conv.id)?;
        let account_id = self.active_account(agent).map(|a| a.id);
        let stored = self.db.get_provider_session(&conv.id, agent)?;
        let session = stored.clone().filter(|s| s.account_id == account_id);
        let (window, meta) = native_window(&history, agent, session.as_ref());
        let percent = match (window.context_tokens, window.context_window) {
            (Some(t), Some(w)) if w > 0 && meta["source"] != "none" => Some(((t as f64 / w as f64) * 1000.0).round() / 10.0),
            _ => None,
        };
        let root = self.db.conversation_root(&conv.id).unwrap_or_default();
        let pending_session = if stored.is_none() {
            super::pending_fork(&conv.origin["native"][agent], account_id.as_deref()).map(|f| ProviderSession {
                conversation_id: conv.id.clone(), agent: agent.to_owned(), session_id: f.session_id,
                last_seq: f.last_seq, account_id: account_id.clone(), uncertain_seq: None, native_context: json!({}),
            })
        } else { None };
        let (resume, fresh) = self.context_plans(&conv, agent, &history, session.as_ref().or(pending_session.as_ref()), "", &root)?;
        let plan = resume.as_ref().unwrap_or(&fresh);
        let memories = self.db.list_memories(&conv.id, false)?;
        let mut by_category: HashMap<&str, usize> = HashMap::new();
        for m in &memories {
            *by_category.entry(m.category.as_str()).or_default() += 1;
        }
        let active = self.compactions.lock().get(&conv.id).cloned();
        Ok(json!({
            "conversationId": conv.id,
            "agent": agent,
            "native": {
                "hasSession": session.is_some(),
                "otherAccount": stored.is_some() && session.is_none(),
                "model": meta["model"],
                "contextTokens": window.context_tokens,
                "contextWindow": window.context_window,
                "percent": percent,
                "source": meta["source"],
                "updatedAt": meta["updatedAt"],
                "compaction": session.as_ref().map(|s| s.native_context["compaction"].clone()).unwrap_or(Value::Null),
                "uncertain": session.as_ref().is_some_and(|s| s.uncertain_seq.is_some()),
            },
            "activeCompaction": active.map(|(a, state)| json!({ "agent": a, "state": state })),
            "shared": {
                "prefs": self.effective_prefs(&conv),
                "override": conv.context_prefs["mode"].is_string(),
                "memories": memories.len(),
                "pinned": memories.iter().filter(|m| m.priority > 0).count(),
                "instructions": memories.iter().filter(|m| m.is_instruction()).count(),
                "byCategory": by_category,
                "next": plan.note,
                "block": if include_block { json!(plan.shared) } else { Value::Null },
            },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(seq: i64, usage: Value, completed: i64) -> Message {
        Message {
            id: format!("m{seq}"), conversation_id: "c".into(), seq, role: "assistant".into(), agent: Some("claude".into()),
            model: Some("claude-haiku-5-5".into()), effort: None, content: "x".into(), items: json!([]), status: "done".into(),
            error: None, usage, context_note: Value::Null, attachments: json!([]), created_at: completed - 10, completed_at: Some(completed),
        }
    }

    fn session(sid: &str, native: Value) -> ProviderSession {
        ProviderSession { conversation_id: "c".into(), agent: "claude".into(), session_id: sid.into(), last_seq: 2, account_id: None, uncertain_seq: None, native_context: native }
    }

    #[test]
    fn ventana_nativa_solo_de_la_misma_sesion() {
        let h = vec![
            assistant(2, json!({ "sessionId": "s1", "contextTokens": 50_000, "contextWindow": 200_000, "maxOutputTokens": 32_000 }), 100),
            assistant(4, json!({ "sessionId": "s0", "contextTokens": 9, "contextWindow": 9 }), 200),
        ];
        let (w, meta) = native_window(&h, "claude", Some(&session("s1", json!({}))));
        assert_eq!((w.context_tokens, w.context_window, w.max_output), (Some(50_000), Some(200_000), Some(32_000)));
        assert_eq!(meta["source"], "provider");
        // Sin datos comunicados en esta sesión no hay porcentaje ni estimación.
        let (none, meta) = native_window(&h, "claude", Some(&session("s9", json!({}))));
        assert_eq!(none, NativeWindow::default());
        assert_eq!(meta["source"], "none");
        assert_eq!(native_window(&h, "claude", None).0, NativeWindow::default());
    }

    #[test]
    fn compactacion_posterior_sustituye_la_ocupacion() {
        let h = vec![assistant(2, json!({ "sessionId": "s1", "contextTokens": 150_000, "contextWindow": 200_000 }), 100)];
        let claude = session("s1", json!({ "compaction": { "state": "completed", "at": 500, "postTokens": 13_186 } }));
        let (w, meta) = native_window(&h, "claude", Some(&claude));
        assert_eq!(w.context_tokens, Some(13_186));
        assert_eq!(meta["source"], "compaction");
        // Codex no comunica la ocupación tras compactar: queda desconocida, no se estima.
        let codex = session("s1", json!({ "compaction": { "state": "completed", "at": 500 } }));
        assert_eq!(native_window(&h, "claude", Some(&codex)).0.context_tokens, None);
        // Una compactación fallida no cambia nada.
        let failed = session("s1", json!({ "compaction": { "state": "failed", "at": 500 } }));
        assert_eq!(native_window(&h, "claude", Some(&failed)).0.context_tokens, Some(150_000));
    }
}
