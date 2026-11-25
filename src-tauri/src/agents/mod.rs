//! Capa común de agentes.
//!
//! Cada envío crea una *ejecución* (`Run`) con un mensaje de asistente en estado `running`.
//! Los adaptadores (`codex`, `claude`) traducen el protocolo de su proveedor a una cronología
//! normalizada de elementos (texto, razonamiento, comandos, cambios de archivos, herramientas)
//! y a eventos `run-event` para la interfaz. La persistencia y el cierre de la ejecución son
//! comunes, de modo que ambos proveedores dejan el historial en el mismo formato.

pub mod claude;
pub mod codex;
pub mod context;
mod insights;
pub mod queue;
mod steer;

use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

use crate::db::Db;
use crate::util::new_id;

pub const AGENTS: [&str; 2] = ["claude", "codex"];

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub conversation_id: String,
    pub agent: String,
    pub model: String,
    pub effort: Option<String>,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    /// Velocidad elegida antes del envío: `None` si el modelo no ofrece niveles de servicio,
    /// `"default"` para la estándar o el identificador del modo rápido que publica el proveedor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    /// Permisos elegidos en el compositor para este mensaje. `None` (encargos anteriores a la 1.0.9)
    /// usa los ajustes globales en el momento de ejecutar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
}

/// Modos de permisos que admite `claude --permission-mode` (Claude Code 2.1.325).
pub const CLAUDE_PERMISSION_MODES: [&str; 6] = ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
/// `SandboxMode` del protocolo app-server de Codex (0.169).
pub const CODEX_SANDBOXES: [&str; 3] = ["read-only", "workspace-write", "danger-full-access"];
/// `AskForApproval` simple del protocolo app-server de Codex (la variante `granular` no se expone).
pub const CODEX_APPROVALS: [&str; 3] = ["untrusted", "on-request", "never"];

/// Permisos de un turno. Claude solo usa `mode`; Codex, `sandbox` y `approval` por separado.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<String>,
}

impl Permissions {
    /// Rechaza valores desconocidos y la mezcla de opciones de un proveedor con el otro.
    pub fn validate(&self, agent: &str) -> Result<()> {
        let check = |value: &Option<String>, allowed: &[&str], what: &str| match value {
            Some(v) if !allowed.contains(&v.as_str()) => Err(anyhow!("{what} no admitido: {v}")),
            _ => Ok(()),
        };
        match agent {
            "claude" => {
                if self.sandbox.is_some() || self.approval.is_some() {
                    bail!("Claude Code no usa sandbox ni política de aprobación de Codex.");
                }
                check(&self.mode, &CLAUDE_PERMISSION_MODES, "Modo de permisos de Claude Code")
            }
            "codex" => {
                if self.mode.is_some() {
                    bail!("Codex no usa los modos de permisos de Claude Code.");
                }
                check(&self.sandbox, &CODEX_SANDBOXES, "Sandbox de Codex")?;
                check(&self.approval, &CODEX_APPROVALS, "Política de aprobación de Codex")
            }
            _ => Err(anyhow!("Agente desconocido: {agent}")),
        }
    }
}

impl SendRequest {
    fn validate(&self) -> Result<()> {
        if !AGENTS.contains(&self.agent.as_str()) {
            return Err(anyhow!("Agente desconocido: {}", self.agent));
        }
        if self.text.trim().is_empty() && self.attachments.is_empty() {
            return Err(anyhow!("El mensaje está vacío"));
        }
        if self.model.trim().is_empty() {
            return Err(anyhow!("Selecciona un modelo antes de enviar"));
        }
        if let Some(permissions) = &self.permissions {
            permissions.validate(&self.agent)?;
        }
        Ok(())
    }
}

/// Estado acumulado de una ejecución: la cronología que verá la interfaz y que se guarda.
#[derive(Default)]
pub struct RunState {
    pub items: Vec<Value>,
    index: HashMap<String, usize>,
    pub usage: Value,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub resolved_model: Option<String>,
    codex_usage: insights::CodexUsage,
    declined_claude_tools: HashSet<String>,
    last_flush: Option<Instant>,
}

impl RunState {
    /// Inserta o actualiza un elemento por `id`. Los campos nuevos sustituyen a los anteriores;
    /// los ausentes se conservan (por ejemplo, la salida acumulada por deltas).
    pub fn upsert(&mut self, item: Value) -> Value {
        let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(&i) = self.index.get(&id) {
            if let (Some(dst), Some(src)) = (self.items[i].as_object_mut(), item.as_object()) {
                for (k, v) in src {
                    if v.is_null() && dst.get(k).is_some_and(|x| !x.is_null()) {
                        continue;
                    }
                    dst.insert(k.clone(), v.clone());
                }
            }
            self.items[i].clone()
        } else {
            self.index.insert(id, self.items.len());
            self.items.push(item.clone());
            item
        }
    }

    pub fn get(&self, id: &str) -> Option<&Value> {
        self.index.get(id).map(|&i| &self.items[i])
    }

    /// Añade texto a un elemento (`text` o `reasoning`), creándolo si no existe.
    pub fn append_text(&mut self, id: &str, kind: &str, delta: &str) {
        if !self.index.contains_key(id) {
            self.upsert(json!({ "id": id, "kind": kind, "status": "running", "text": "" }));
        }
        let i = self.index[id];
        if let Some(obj) = self.items[i].as_object_mut() {
            let cur = obj.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
            obj.insert("text".into(), Value::String(cur + delta));
        }
    }

    pub fn append_output(&mut self, id: &str, delta: &str) {
        if let Some(&i) = self.index.get(id) {
            if let Some(obj) = self.items[i].as_object_mut() {
                let cur = obj.get("output").and_then(Value::as_str).unwrap_or_default().to_string();
                let mut next = cur + delta;
                // La salida en vivo se limita; el resultado final completo llega al completar.
                if next.len() > 200_000 {
                    let cut = next.len() - 150_000;
                    let cut = (cut..next.len()).find(|&c| next.is_char_boundary(c)).unwrap_or(cut);
                    next = next[cut..].to_string();
                }
                obj.insert("output".into(), Value::String(next));
            }
        }
    }

    /// Texto final visible del asistente: los bloques de texto en orden.
    pub fn content(&self) -> String {
        self.items
            .iter()
            .filter(|i| i.get("kind").and_then(Value::as_str) == Some("text"))
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Cierra los elementos que quedaron abiertos al terminar la ejecución.
    fn close_open_items(&mut self, status: &str) {
        for it in self.items.iter_mut() {
            if it.get("status").and_then(Value::as_str) == Some("running") {
                let next = if status == "done" { "completed" } else { "interrupted" };
                it["status"] = Value::String(next.into());
            }
        }
    }
}

pub enum Control {
    None,
    Codex {
        server: Arc<codex::CodexServer>,
        thread_id: String,
        turn_id: Option<String>,
    },
    Claude {
        stdin: UnboundedSender<String>,
        kill: Option<tokio::sync::oneshot::Sender<()>>,
    },
}

pub struct Run {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub agent: String,
    pub model: String,
    pub effort: Option<String>,
    pub account_id: Option<String>,
    pub config_dir: Option<String>,
    pub queue_entry: Option<String>,
    pub resolved_request_model: Option<String>,
    pub effective_effort: Option<String>,
    /// Velocidad pedida para este turno (ver `SendRequest::speed`).
    pub speed: Option<String>,
    /// Permisos de este turno (ver `SendRequest::permissions`).
    pub permissions: Option<Permissions>,
    pub state: Mutex<RunState>,
    pub control: Mutex<Control>,
    pub cancel_requested: AtomicBool,
    approval_io: tokio::sync::Mutex<()>,
    finished: AtomicBool,
    ready: AtomicBool,
    steerable: AtomicBool,
}

impl Run {
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
pub enum PendingApproval {
    Codex {
        run_id: String,
        server: Arc<codex::CodexServer>,
        rpc_id: Value,
        method: String,
        params: Value,
    },
    Claude {
        run_id: String,
        stdin: UnboundedSender<String>,
        request_id: String,
        tool_use_id: Option<String>,
        input: Value,
        suggestions: Value,
    },
}

impl PendingApproval {
    fn run_id(&self) -> &str {
        match self {
            PendingApproval::Codex { run_id, .. } | PendingApproval::Claude { run_id, .. } => run_id,
        }
    }

    fn allows(&self, decision: &str) -> bool {
        match self {
            Self::Codex { params, .. } => codex::approval_options(params).contains(&decision),
            Self::Claude { suggestions, .. } => match decision {
                "accept" | "decline" => true,
                "acceptForSession" => suggestions.as_array().is_some_and(|items| !items.is_empty()),
                _ => false,
            },
        }
    }
}

pub struct Studio {
    pub app: AppHandle,
    pub db: Arc<Db>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
    conv_runs: Mutex<HashMap<String, String>>,
    approvals: Mutex<HashMap<String, PendingApproval>>,
    installing_update: Mutex<bool>,
    lifecycle: Mutex<()>,
    preparing: Mutex<HashSet<String>>,
    capturing: Mutex<HashSet<String>>,
    steering: Mutex<HashSet<String>>,
    shutting_down: AtomicBool,
    pub codex: tokio::sync::Mutex<HashMap<(PathBuf, Option<String>), Arc<codex::CodexServer>>>,
    pub claude_info: Mutex<HashMap<String, Value>>,
}

impl Studio {
    pub fn new(app: AppHandle, db: Arc<Db>) -> Arc<Self> {
        Arc::new(Studio {
            app,
            db,
            runs: Mutex::new(HashMap::new()),
            conv_runs: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            installing_update: Mutex::new(false),
            lifecycle: Mutex::new(()),
            preparing: Mutex::new(HashSet::new()),
            capturing: Mutex::new(HashSet::new()),
            steering: Mutex::new(HashSet::new()),
            shutting_down: AtomicBool::new(false),
            codex: tokio::sync::Mutex::new(HashMap::new()),
            claude_info: Mutex::new(HashMap::new()),
        })
    }

    pub fn emit(&self, payload: Value) {
        let _ = self.app.emit("run-event", payload);
    }

    pub fn run(&self, run_id: &str) -> Option<Arc<Run>> {
        self.runs.lock().get(run_id).cloned()
    }

    pub fn active_runs(&self) -> Vec<Value> {
        self.runs
            .lock()
            .values()
            .map(|r| {
                let st = r.state.lock();
                json!({
                    "runId": r.id, "conversationId": r.conversation_id, "messageId": r.message_id,
                    "agent": r.agent, "model": r.model, "items": st.items,
                    "ready": r.ready.load(Ordering::SeqCst), "steerable": r.steerable.load(Ordering::SeqCst),
                })
            })
            .collect()
    }

    // ---------- Cuentas y ejecutables ----------

    pub fn active_account(&self, agent: &str) -> Option<crate::db::Account> {
        let id = self.db.get_setting_str(&format!("accounts.active.{agent}"))?;
        self.db.list_accounts().ok()?.into_iter().find(|a| a.id == id && a.agent == agent)
    }

    pub fn config_dir(&self, agent: &str) -> Option<String> {
        self.active_account(agent).and_then(|a| a.config_dir)
    }

    pub fn executable(&self, agent: &str) -> Result<PathBuf> {
        crate::detect::resolve_executable(agent, self.db.get_setting_str(&format!("agents.{agent}.path")))
            .ok_or_else(|| anyhow!("No se encontró la CLI de {}. Revisa Ajustes → Agentes.", context::agent_label(agent)))
    }

    pub fn setting_str(&self, key: &str, default: &str) -> String {
        self.db.get_setting_str(key).unwrap_or_else(|| default.to_string())
    }

    /// Permiso efectivo de un turno: el elegido en el mensaje o, si no lo trae, el ajuste global.
    pub fn permission(&self, chosen: Option<&String>, key: &str, default: &str) -> String {
        chosen.cloned().unwrap_or_else(|| self.setting_str(key, default))
    }

    pub fn setting_bool(&self, key: &str, default: bool) -> bool {
        self.db.get_setting(key).and_then(|v| v.as_bool()).unwrap_or(default)
    }

    // ---------- Envío ----------

    pub fn when_idle_for_update<T>(&self, action: impl FnOnce() -> T) -> Result<T> {
        self.when_idle_for("instalar", action)
    }

    /// Ejecuta `action` solo si no hay agentes trabajando; durante la acción no se aceptan envíos.
    pub fn when_idle_for<T>(&self, purpose: &str, action: impl FnOnce() -> T) -> Result<T> {
        let gate = self.lifecycle.lock();
        let mut installing = self.installing_update.lock();
        if *installing || !self.runs.lock().is_empty() || !self.preparing.lock().is_empty() || !self.steering.lock().is_empty() {
            return Err(anyhow!("Espera a que los agentes terminen o detén sus tareas antes de {purpose}."));
        }
        *installing = true;
        drop(installing);
        drop(gate);
        let result = action();
        *self.installing_update.lock() = false;
        Ok(result)
    }

    pub fn send(self: &Arc<Self>, req: SendRequest) -> Result<Value> {
        let _gate = self.lifecycle.lock();
        self.start_run(req, None, None)?.ok_or_else(|| anyhow!("No se pudo iniciar el mensaje."))
    }

    // El propietario del ciclo de vida mantiene lifecycle hasta registrar y anunciar el Run.
    fn start_run(
        self: &Arc<Self>, req: SendRequest, head: Option<&crate::db::queue::QueueEntry>,
        codex_server: Option<Arc<codex::CodexServer>>,
    ) -> Result<Option<Value>> {
        if *self.installing_update.lock() || self.shutting_down.load(Ordering::SeqCst) {
            return Err(anyhow!("La aplicación está cerrándose o iniciando el instalador de la actualización."));
        }
        req.validate()?;
        if self.conv_runs.lock().contains_key(&req.conversation_id) || self.steering.lock().contains(&req.conversation_id) {
            return Err(anyhow!("Ya hay un agente trabajando en esta conversación. Espera a que termine o detenlo."));
        }
        let conv = self.db.get_conversation(&req.conversation_id)?;
        let project = self.db.get_project(&conv.project_id)?;
        if head.is_some_and(|entry| entry.project_id != project.id) {
            return Err(anyhow!("El proyecto de este encargo cambió."));
        }
        // Directorio de la conversación: el principal o su worktree (nunca otro por error).
        let root = self.db.conversation_root(&conv.id)?;
        let cwd = PathBuf::from(&root);
        if !cwd.is_dir() {
            return Err(anyhow!("La carpeta del proyecto no existe: {}", root));
        }
        let history = self.db.list_messages(&conv.id)?;
        let (account_id, config_dir) = match head {
            Some(entry) => (entry.input.target.account_id.clone(), entry.input.target.config_dir.clone()),
            None => self.active_account(&req.agent).map(|a| (Some(a.id), a.config_dir)).unwrap_or_default(),
        };
        let session = self
            .db
            .get_provider_session(&conv.id, &req.agent)?
            .filter(|s| s.account_id == account_id);

        let attachments = match head {
            Some(entry) => entry.input.attachments.clone(),
            None => resolve_attachments(&req, &root)?,
        };
        let user_text = with_attachment_note(&req.text, &attachments);

        let resume_plan = session.as_ref().map(|s| {
            context::build_prompt(&history, &req.agent, Some(s.last_seq), &user_text, context::DEFAULT_BUDGET_CHARS)
        });
        let fresh_plan = context::build_prompt(&history, &req.agent, None, &user_text, context::DEFAULT_BUDGET_CHARS);
        let provisional_note = resume_plan.as_ref().map(|p| p.note.clone()).unwrap_or(fresh_plan.note.clone());

        let Some((user_msg, assistant)) = self.db.start_messages(&req, head, &provisional_note, &attachments)? else {
            return Ok(None);
        };
        if head.is_none() {
            let _ = self.db.set_conversation_prefs(&conv.id, &req.agent, &req.model, req.effort.as_deref());
        }
        let _ = self.db.touch_conversation(&conv.id);
        let title_source = if req.text.trim().is_empty() {
            attachments.first().and_then(|file| file["name"].as_str()).unwrap_or_default()
        } else {
            &req.text
        };
        let renamed = self.db.set_automatic_title(&conv.id, auto_title(title_source)).ok().flatten();

        let run = Arc::new(Run {
            id: new_id(),
            conversation_id: conv.id.clone(),
            message_id: assistant.id.clone(),
            agent: req.agent.clone(),
            model: req.model.clone(),
            effort: req.effort.clone(),
            account_id,
            config_dir,
            queue_entry: head.map(|entry| entry.id.clone()),
            resolved_request_model: head.and_then(|entry| entry.input.resolved_model.clone()),
            effective_effort: head.and_then(|entry| entry.input.effective_effort.clone()).or(req.effort.clone()),
            speed: req.speed.clone(),
            permissions: req.permissions.clone(),
            state: Mutex::new(RunState::default()),
            control: Mutex::new(Control::None),
            cancel_requested: AtomicBool::new(false),
            approval_io: tokio::sync::Mutex::new(()),
            finished: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            steerable: AtomicBool::new(false),
        });
        let account_label = run.account_id.as_ref().and_then(|id| {
            self.db.list_accounts().ok()?.into_iter().find(|a| &a.id == id).map(|a| a.label)
        });
        self.update_insights(&run, json!({
            "userMessageId": user_msg.id, "historyMessages": history.len(),
            "accountId": run.account_id, "accountLabel": account_label,
            "accountSource": if run.account_id.is_some() { "profile" } else { "cli" },
            "requestedModel": run.model, "requestedEffort": run.effective_effort,
            "requestedSpeed": run.speed,
        }));
        self.runs.lock().insert(run.id.clone(), run.clone());
        self.conv_runs.lock().insert(conv.id.clone(), run.id.clone());

        let job = RunJob {
            run: run.clone(),
            cwd,
            session_id: session.map(|s| s.session_id),
            resume_plan,
            fresh_plan,
            user_message_id: user_msg.id.clone(),
            attachments,
            codex_server,
        };
        let started = json!({
            "runId": run.id, "conversationId": conv.id, "userMessage": user_msg,
            "assistantMessage": assistant, "renamedTitle": renamed,
        });
        if head.is_some() {
            let mut event = started.clone();
            event["type"] = json!("started");
            self.emit(event);
            self.queue_changed(&conv.id);
        }
        let studio = self.clone();
        let agent = req.agent.clone();
        tauri::async_runtime::spawn(async move {
            let run_id = job.run.id.clone();
            let result = if agent == "codex" {
                codex::execute(studio.clone(), job).await
            } else {
                claude::execute(studio.clone(), job).await
            };
            if let Err(e) = result {
                studio.fail(&run_id, &format!("{e:#}"));
            }
        });

        Ok(Some(started))
    }

    /// Actualiza la nota de contexto del mensaje de usuario cuando el adaptador tuvo que
    /// abrir una sesión nueva (por ejemplo, si la sesión anterior ya no se podía reanudar).
    pub fn set_context_note(&self, user_message_id: &str, note: &Value) {
        let _ = self.db.update_context_note(user_message_id, note);
        self.emit(json!({ "type": "contextNote", "messageId": user_message_id, "note": note }));
    }

    // ---------- Eventos de progreso desde los adaptadores ----------

    pub fn item(&self, run: &Run, item: Value) {
        let merged = run.state.lock().upsert(item);
        self.emit(json!({ "type": "item", "runId": run.id, "conversationId": run.conversation_id, "item": merged }));
        self.maybe_flush(run, false);
    }

    pub fn text_delta(&self, run: &Run, item_id: &str, kind: &str, delta: &str) {
        run.state.lock().append_text(item_id, kind, delta);
        self.emit(json!({
            "type": "delta", "runId": run.id, "conversationId": run.conversation_id,
            "itemId": item_id, "kind": kind, "delta": delta,
        }));
        self.maybe_flush(run, false);
    }

    pub fn output_delta(&self, run: &Run, item_id: &str, delta: &str) {
        run.state.lock().append_output(item_id, delta);
        self.emit(json!({
            "type": "output", "runId": run.id, "conversationId": run.conversation_id,
            "itemId": item_id, "delta": delta,
        }));
    }

    pub fn run_ready(&self, run: &Run, steerable: bool) {
        if run.ready.swap(true, Ordering::SeqCst) { return; }
        run.steerable.store(steerable, Ordering::SeqCst);
        self.emit(json!({
            "type": "runReady", "runId": run.id, "conversationId": run.conversation_id, "steerable": steerable,
        }));
    }

    pub fn record_provider_turn(&self, run: &Run, session: &str, turn: &str) {
        self.update_insights(run, json!({ "providerTurnId": turn, "sessionId": session }));
        if let Some(entry) = run.queue_entry.as_deref() {
            let _ = self.db.record_queue_turn(entry, &run.message_id, session, turn);
        }
    }

    pub fn set_session(&self, run: &Run, session_id: &str) {
        run.state.lock().session_id = Some(session_id.to_string());
        self.update_insights(run, json!({ "sessionId": session_id }));
        // Se guarda en cuanto se conoce, para poder reanudar aunque la ejecución falle después.
        if let Ok(msg) = self.db.get_message(&run.message_id) {
            let _ = self.db.upsert_provider_session(
                &run.conversation_id,
                &run.agent,
                session_id,
                msg.seq,
                run.account_id.as_deref(),
            );
        }
        self.emit(json!({ "type": "session", "runId": run.id, "sessionId": session_id }));
    }

    pub fn set_usage(&self, run: &Run, usage: Value) {
        {
            let mut state = run.state.lock();
            if run.is_finished() || state.usage == usage { return; }
            state.usage = usage.clone();
            if let Err(err) = self.db.checkpoint_metrics(&run.message_id, &usage) {
                eprintln!("No se pudo guardar el uso de la ejecución: {err}");
            }
        }
        self.emit(json!({ "type": "usage", "runId": run.id, "conversationId": run.conversation_id, "usage": usage }));
        self.insights_changed(run);
    }

    fn insights_changed(&self, run: &Run) {
        let _ = self.app.emit("agent-insights", &run.message_id);
    }

    pub fn update_insights(&self, run: &Run, patch: Value) {
        match self.db.patch_insights(&run.message_id, &patch) {
            Ok(true) => self.insights_changed(run),
            Ok(false) => {}
            Err(err) => eprintln!("No se pudo guardar la actividad de la ejecución: {err}"),
        }
    }

    pub fn record_plan(&self, run: &Run, source: &str, tasks: Vec<Value>, explanation: &Value) {
        let plan = json!({ "source": source, "tasks": tasks, "explanation": explanation.as_str() });
        match self.db.append_plan(&run.message_id, &plan) {
            Ok(true) => self.insights_changed(run),
            Ok(false) => {}
            Err(err) => eprintln!("No se pudo guardar el plan: {err}"),
        }
    }

    pub fn provider_identity(&self, run: &Run, session: &str, id: &str) -> bool {
        let key = json!([run.agent, session, id]).to_string();
        match self.db.bind_insights(&run.message_id, &key) {
            Ok(bound) => bound,
            Err(err) => {
                eprintln!("No se pudo verificar la identidad de la ejecución: {err}");
                false
            }
        }
    }

    fn maybe_flush(&self, run: &Run, force: bool) {
        let (content, items) = {
            let mut st = run.state.lock();
            let due = st.last_flush.map_or(true, |t| t.elapsed() > Duration::from_millis(1500));
            if !force && !due {
                return;
            }
            st.last_flush = Some(Instant::now());
            (st.content(), Value::Array(st.items.clone()))
        };
        let _ = self.db.update_message_progress(&run.message_id, &content, &items);
    }

    // ---------- Aprobaciones ----------

    pub fn request_approval(&self, run: &Run, pending: PendingApproval, info: Value) -> bool {
        let mut approvals = self.approvals.lock();
        if run.is_finished() || run.cancel_requested.load(Ordering::SeqCst) {
            return false;
        }
        let id = new_id();
        approvals.insert(id.clone(), pending);
        self.emit(json!({
            "type": "approval", "runId": run.id, "conversationId": run.conversation_id,
            "approvalId": id, "approval": info,
        }));
        true
    }

    pub async fn respond_approval(&self, approval_id: &str, decision: &str) -> Result<()> {
        let run_id = self.approvals.lock().get(approval_id).map(|pending| pending.run_id().to_owned())
            .ok_or_else(|| anyhow!("La solicitud de permiso ya no está activa"))?;
        let run = self.run(&run_id).ok_or_else(|| anyhow!("La solicitud de permiso ya no está activa"))?;
        let _io = run.approval_io.lock().await;
        if run.is_finished() {
            return Err(anyhow!("La solicitud de permiso ya no está activa"));
        }
        let decision = if run.cancel_requested.load(Ordering::SeqCst) { "cancel" } else { decision };
        let pending = {
            let mut approvals = self.approvals.lock();
            let entry = approvals.get(approval_id)
                .ok_or_else(|| anyhow!("La solicitud de permiso ya no está activa"))?;
            if decision != "cancel" && !entry.allows(decision) {
                return Err(anyhow!("La solicitud no admite esa decisión."));
            }
            approvals.remove(approval_id).expect("solicitud presente")
        };
        let response = match pending.clone() {
            PendingApproval::Codex { server, rpc_id, method, params, .. } => {
                let result = codex::approval_response(&method, &params, decision);
                server.respond(rpc_id, result).await
            }
            PendingApproval::Claude { stdin, request_id, tool_use_id, input, suggestions, .. } => {
                let response = match decision {
                    "accept" => json!({ "behavior": "allow", "updatedInput": input }),
                    "acceptForSession" => {
                        let mut r = json!({ "behavior": "allow", "updatedInput": input });
                        if suggestions.as_array().is_some_and(|a| !a.is_empty()) {
                            r["updatedPermissions"] = suggestions;
                        }
                        r
                    }
                    _ => {
                        if let Some(id) = tool_use_id {
                            run.state.lock().declined_claude_tools.insert(id);
                        }
                        json!({ "behavior": "deny", "message": "El usuario rechazó esta acción desde Duovra." })
                    }
                };
                let line = json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": request_id, "response": response }
                });
                stdin.send(line.to_string()).map_err(|_| anyhow!("El proceso de Claude Code ya terminó"))
            }
        };
        if let Err(err) = response {
            let mut approvals = self.approvals.lock();
            if !run.is_finished() && !run.cancel_requested.load(Ordering::SeqCst) {
                approvals.insert(approval_id.to_owned(), pending);
            }
            return Err(err);
        }
        self.emit(json!({ "type": "approvalResolved", "runId": run_id, "approvalId": approval_id, "decision": decision }));
        Ok(())
    }

    // ---------- Cancelación y cierre ----------

    pub async fn cancel(&self, run_id: &str) -> Result<()> {
        let run = self.run(run_id).ok_or_else(|| anyhow!("La ejecución ya terminó"))?;
        {
            let _io = run.approval_io.lock().await;
            run.cancel_requested.store(true, Ordering::SeqCst);
        }
        // Las solicitudes de permiso pendientes se rechazan: el agente no debe quedarse esperando.
        let pending: Vec<String> = self
            .approvals
            .lock()
            .iter()
            .filter(|(_, p)| p.run_id() == run_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in pending {
            let _ = self.respond_approval(&id, "cancel").await;
        }
        enum Action {
            Codex(Arc<codex::CodexServer>, String, Option<String>),
            Claude(UnboundedSender<String>),
            None,
        }
        let action = match &*run.control.lock() {
            Control::Codex { server, thread_id, turn_id } => Action::Codex(server.clone(), thread_id.clone(), turn_id.clone()),
            Control::Claude { stdin, .. } => Action::Claude(stdin.clone()),
            Control::None => Action::None,
        };
        match action {
            Action::Codex(server, thread_id, Some(turn_id)) => {
                server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await?;
            }
            Action::Codex(_, _, None) | Action::None => {
                // Todavía no hay turno: el adaptador comprobará la bandera antes de empezarlo.
            }
            Action::Claude(stdin) => {
                let req = json!({ "type": "control_request", "request_id": new_id(), "request": { "subtype": "interrupt" } });
                let _ = stdin.send(req.to_string());
                // Si la CLI no confirma la interrupción, se termina el proceso.
                let run = run.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    if !run.finished.load(Ordering::SeqCst) {
                        if let Control::Claude { kill, .. } = &mut *run.control.lock() {
                            if let Some(k) = kill.take() {
                                let _ = k.send(());
                            }
                        }
                    }
                });
            }
        }
        Ok(())
    }

    pub fn fail(self: &Arc<Self>, run_id: &str, error: &str) {
        if let Some(run) = self.run(run_id) {
            run.state.lock().error = Some(error.to_string());
        }
        self.finish(run_id, "failed");
    }

    /// Cierra la ejecución una sola vez: guarda el mensaje, la referencia de sesión y el consumo.
    pub fn finish(self: &Arc<Self>, run_id: &str, status: &str) {
        let _gate = self.lifecycle.lock();
        let Some(run) = self.run(run_id) else { return };
        if run.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let status = if run.cancel_requested.load(Ordering::SeqCst) {
            "cancelled"
        } else {
            status
        };
        let (content, items, usage, session, error, resolved_model) = {
            let mut st = run.state.lock();
            st.close_open_items(status);
            (
                st.content(),
                Value::Array(st.items.clone()),
                st.usage.clone(),
                st.session_id.clone(),
                st.error.clone(),
                st.resolved_model.clone(),
            )
        };
        // El modelo exacto: si el proveedor resolvió un alias (p. ej. `haiku` → `claude-haiku-5-5`),
        // se guarda el resuelto y el alias elegido queda en `usage.requestedModel`.
        let mut usage = usage;
        let exact = resolved_model.clone().filter(|m| m != &run.model);
        if exact.is_some() {
            if usage.is_null() {
                usage = json!({});
            }
            usage["requestedModel"] = json!(run.model);
        }
        // El modo rápido queda registrado con el turno que lo pidió.
        if run.speed.as_deref().is_some_and(|speed| speed != "default") {
            if usage.is_null() {
                usage = json!({});
            }
            usage["fast"] = json!(true);
        }
        let saved = self.db.finish_run(
            &run.conversation_id, &run.message_id, run.queue_entry.as_deref(),
            &content, &items, status, error.as_deref(), &usage, exact.as_deref(),
        );
        if let Err(err) = &saved {
            let _ = self.db.storage_pause(&run.conversation_id, &run.message_id);
            self.emit(json!({
                "type": "queueError", "conversationId": run.conversation_id,
                "message": format!("No se pudo guardar el resultado. Reinicia Duovra para revisarlo: {err}"),
            }));
        }
        let msg = saved.ok();
        if let (Some(sid), Some(m)) = (&session, &msg) {
            let _ = self
                .db
                .upsert_provider_session(&run.conversation_id, &run.agent, sid, m.seq, run.account_id.as_deref());
        }
        let _ = self.db.touch_conversation(&run.conversation_id);
        self.runs.lock().remove(run_id);
        self.conv_runs.lock().remove(&run.conversation_id);
        self.approvals.lock().retain(|_, p| p.run_id() != run_id);
        self.emit(json!({
            "type": "finished", "runId": run_id, "conversationId": run.conversation_id,
            "status": if msg.is_some() { status } else { "interrupted" }, "message": msg,
        }));
        self.queue_changed(&run.conversation_id);
        if status == "done" && msg.is_some() {
            self.kick_queue(&run.conversation_id);
        }
    }

    pub fn shutdown(&self) {
        let _gate = self.lifecycle.lock();
        self.shutting_down.store(true, Ordering::SeqCst);
        let runs: Vec<Arc<Run>> = self.runs.lock().values().cloned().collect();
        for run in runs {
            if let Control::Claude { kill, .. } = &mut *run.control.lock() {
                if let Some(k) = kill.take() {
                    let _ = k.send(());
                }
            }
        }
    }
}

fn provider_diagnostic(detail: &str, fallback: &str) -> String {
    let detail = detail.to_ascii_lowercase();
    if ["not logged in", "unauthorized", "authentication", "invalid api key", "401", "session expired"]
        .iter().any(|pattern| detail.contains(pattern)) {
        "La sesión del proveedor no está disponible. Comprueba la cuenta en Ajustes y vuelve a iniciar sesión.".into()
    } else if ["model_not_found", "invalid_model", "model not found", "model is not available", "unsupported model"]
        .iter().any(|pattern| detail.contains(pattern)) {
        "El proveedor no admite el modelo seleccionado. Actualiza el catálogo y elige un modelo disponible.".into()
    } else if ["connection", "network", "dns", "timed out", "offline"]
        .iter().any(|pattern| detail.contains(pattern)) {
        "El proveedor no pudo conectarse. Comprueba la red antes de volver a intentarlo.".into()
    } else {
        fallback.to_owned()
    }
}

pub struct RunJob {
    pub run: Arc<Run>,
    pub cwd: PathBuf,
    pub session_id: Option<String>,
    pub resume_plan: Option<context::ContextPlan>,
    pub fresh_plan: context::ContextPlan,
    pub user_message_id: String,
    pub attachments: Vec<Value>,
    pub codex_server: Option<Arc<codex::CodexServer>>,
}

fn resolve_attachments(req: &SendRequest, project_path: &str) -> Result<Vec<Value>> {
    let mut attachments: Vec<Value> = req.attachments.iter().map(|p| {
        let path = PathBuf::from(p);
        // Los archivos grandes siguen disponibles como referencia de ruta.
        let embeddable = is_image(&path)
            && (req.agent != "claude" || std::fs::metadata(&path).is_ok_and(|m| m.len() <= CLAUDE_IMAGE_MAX));
        json!({
            "path": p,
            "name": path.file_name().and_then(|n| n.to_str()).unwrap_or(p),
            "image": embeddable,
        })
    }).collect();
    attachments.extend(crate::workspace::Workspace::references(project_path, &req.text)?);
    Ok(attachments)
}

/// Tamaño máximo de imagen que se incrusta en el mensaje de Claude Code (ver claude::image_block).
pub const CLAUDE_IMAGE_MAX: u64 = 5 * 1024 * 1024;

pub fn is_image(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp")
    )
}

/// Los archivos que no son imágenes se pasan como rutas: ambos agentes pueden leerlos con sus
/// propias herramientas, sin que la aplicación copie su contenido en el mensaje.
fn with_attachment_note(text: &str, attachments: &[Value]) -> String {
    let files: Vec<&str> = attachments
        .iter()
        .filter(|a| a["image"] != true)
        .filter_map(|a| a["path"].as_str())
        .collect();
    if files.is_empty() {
        return text.to_string();
    }
    let mut s = text.to_string();
    s.push_str("\n\nAttached files (read them from disk if needed):\n");
    for f in files {
        s.push_str(&format!("- {f}\n"));
    }
    s
}

fn auto_title(text: &str) -> String {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let mut t: String = first.chars().take(56).collect();
    if first.chars().count() > 56 {
        t = t.trim_end().to_string() + "…";
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permisos_validos_solo_para_su_proveedor() {
        let claude = Permissions { mode: Some("plan".into()), ..Default::default() };
        let codex = Permissions { sandbox: Some("read-only".into()), approval: Some("never".into()), ..Default::default() };
        assert!(claude.validate("claude").is_ok());
        assert!(codex.validate("codex").is_ok());
        assert!(claude.validate("codex").is_err());
        assert!(codex.validate("claude").is_err());
        assert!(Permissions { mode: Some("yolo".into()), ..Default::default() }.validate("claude").is_err());
        assert!(Permissions { approval: Some("on-failure".into()), ..Default::default() }.validate("codex").is_err());
        // Un encargo anterior a la 1.0.9 (sin permisos) sigue siendo válido y usa los ajustes globales.
        let old: SendRequest = serde_json::from_value(json!({
            "conversationId": "c", "agent": "codex", "model": "m", "effort": null, "text": "hola", "attachments": []
        })).unwrap();
        assert!(old.permissions.is_none() && old.validate().is_ok());
    }

    #[test]
    fn upsert_conserva_salida_acumulada() {
        let mut st = RunState::default();
        st.upsert(json!({"id":"c1","kind":"command","status":"running","command":"ls"}));
        st.append_output("c1", "a\n");
        st.append_output("c1", "b\n");
        st.upsert(json!({"id":"c1","status":"completed","exitCode":0,"output":null}));
        let it = st.get("c1").unwrap();
        assert_eq!(it["output"], "a\nb\n");
        assert_eq!(it["status"], "completed");
    }

    #[test]
    fn contenido_une_bloques_de_texto() {
        let mut st = RunState::default();
        st.append_text("t1", "text", "Hola");
        st.append_text("t1", "text", " mundo");
        st.upsert(json!({"id":"r","kind":"reasoning","text":"pienso"}));
        st.append_text("t2", "text", "Fin");
        assert_eq!(st.content(), "Hola mundo\n\nFin");
    }

    #[test]
    fn titulo_automatico() {
        assert_eq!(auto_title("\n  Arregla el login  \nmás"), "Arregla el login");
        assert!(auto_title(&"a".repeat(80)).ends_with('…'));
    }
}
