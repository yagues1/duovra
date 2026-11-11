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

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

use crate::db::Db;
use crate::util::new_id;

pub const AGENTS: [&str; 2] = ["claude", "codex"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub conversation_id: String,
    pub agent: String,
    pub model: String,
    pub effort: Option<String>,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
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
    pub state: Mutex<RunState>,
    pub control: Mutex<Control>,
    pub cancel_requested: AtomicBool,
    finished: AtomicBool,
}

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
}

pub struct Studio {
    pub app: AppHandle,
    pub db: Arc<Db>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
    conv_runs: Mutex<HashMap<String, String>>,
    approvals: Mutex<HashMap<String, PendingApproval>>,
    installing_update: Mutex<bool>,
    pub codex: tokio::sync::Mutex<Option<Arc<codex::CodexServer>>>,
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
            codex: tokio::sync::Mutex::new(None),
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

    // ---------- Envío ----------

    pub fn when_idle_for_update<T>(&self, action: impl FnOnce() -> T) -> Result<T> {
        let mut installing = self.installing_update.lock();
        if *installing || !self.runs.lock().is_empty() {
            return Err(anyhow!("Espera a que los agentes terminen o detén sus tareas antes de instalar."));
        }
        *installing = true;
        drop(installing);
        let result = action();
        *self.installing_update.lock() = false;
        Ok(result)
    }

    pub fn send(self: &Arc<Self>, req: SendRequest) -> Result<Value> {
        let installing = self.installing_update.lock();
        if *installing {
            return Err(anyhow!("La aplicación está iniciando el instalador de la actualización."));
        }
        if !AGENTS.contains(&req.agent.as_str()) {
            return Err(anyhow!("Agente desconocido: {}", req.agent));
        }
        if req.text.trim().is_empty() && req.attachments.is_empty() {
            return Err(anyhow!("El mensaje está vacío"));
        }
        if req.model.trim().is_empty() {
            return Err(anyhow!("Selecciona un modelo antes de enviar"));
        }
        if self.conv_runs.lock().contains_key(&req.conversation_id) {
            return Err(anyhow!("Ya hay un agente trabajando en esta conversación. Espera a que termine o detenlo."));
        }
        let conv = self.db.get_conversation(&req.conversation_id)?;
        let project = self.db.get_project(&conv.project_id)?;
        let cwd = PathBuf::from(&project.path);
        if !cwd.is_dir() {
            return Err(anyhow!("La carpeta del proyecto no existe: {}", project.path));
        }
        let history = self.db.list_messages(&conv.id)?;
        let account_id = self.active_account(&req.agent).map(|a| a.id);
        let session = self
            .db
            .get_provider_session(&conv.id, &req.agent)?
            .filter(|s| s.account_id == account_id);

        let attachments: Vec<Value> = req
            .attachments
            .iter()
            .map(|p| {
                let path = PathBuf::from(p);
                // Claude Code recibe las imágenes incrustadas en base64 hasta 5 MB. Por encima de
                // ese límite se descartaban sin aviso: ahora pasan como ruta, igual que el resto de
                // archivos, y la interfaz lo anuncia antes de enviar (AUD-005).
                let embeddable = is_image(&path)
                    && (req.agent != "claude" || std::fs::metadata(&path).map(|m| m.len() <= CLAUDE_IMAGE_MAX).unwrap_or(false));
                json!({
                    "path": p,
                    "name": path.file_name().and_then(|n| n.to_str()).unwrap_or(p),
                    "image": embeddable,
                })
            })
            .collect();
        let user_text = with_attachment_note(&req.text, &attachments);

        let resume_plan = session.as_ref().map(|s| {
            context::build_prompt(&history, &req.agent, Some(s.last_seq), &user_text, context::DEFAULT_BUDGET_CHARS)
        });
        let fresh_plan = context::build_prompt(&history, &req.agent, None, &user_text, context::DEFAULT_BUDGET_CHARS);
        let provisional_note = resume_plan.as_ref().map(|p| p.note.clone()).unwrap_or(fresh_plan.note.clone());

        let user_msg = self.db.insert_message(
            &new_id(),
            &conv.id,
            "user",
            Some(&req.agent),
            Some(&req.model),
            req.effort.as_deref(),
            &req.text,
            "done",
            &provisional_note,
            &Value::Array(attachments.clone()),
        )?;
        let assistant = self.db.insert_message(
            &new_id(),
            &conv.id,
            "assistant",
            Some(&req.agent),
            Some(&req.model),
            req.effort.as_deref(),
            "",
            "running",
            &Value::Null,
            &json!([]),
        )?;
        self.db.set_conversation_prefs(&conv.id, &req.agent, &req.model, req.effort.as_deref())?;
        self.db.touch_conversation(&conv.id)?;
        let mut renamed = None;
        if history.is_empty() && conv.title == "Nueva conversación" {
            let title = auto_title(&req.text);
            if !title.is_empty() {
                self.db.rename_conversation(&conv.id, &title)?;
                renamed = Some(title);
            }
        }

        let run = Arc::new(Run {
            id: new_id(),
            conversation_id: conv.id.clone(),
            message_id: assistant.id.clone(),
            agent: req.agent.clone(),
            model: req.model.clone(),
            effort: req.effort.clone(),
            account_id,
            state: Mutex::new(RunState::default()),
            control: Mutex::new(Control::None),
            cancel_requested: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
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
        };
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

        Ok(json!({
            "runId": run.id,
            "userMessage": user_msg,
            "assistantMessage": assistant,
            "renamedTitle": renamed,
        }))
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

    pub fn set_session(&self, run: &Run, session_id: &str) {
        run.state.lock().session_id = Some(session_id.to_string());
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
        run.state.lock().usage = usage.clone();
        self.emit(json!({ "type": "usage", "runId": run.id, "conversationId": run.conversation_id, "usage": usage }));
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

    pub fn request_approval(&self, run: &Run, pending: PendingApproval, info: Value) {
        let id = new_id();
        self.approvals.lock().insert(id.clone(), pending);
        self.emit(json!({
            "type": "approval", "runId": run.id, "conversationId": run.conversation_id,
            "approvalId": id, "approval": info,
        }));
    }

    pub async fn respond_approval(&self, approval_id: &str, decision: &str) -> Result<()> {
        let pending = self
            .approvals
            .lock()
            .remove(approval_id)
            .ok_or_else(|| anyhow!("La solicitud de permiso ya no está activa"))?;
        let run_id = pending.run_id().to_string();
        match pending {
            PendingApproval::Codex { server, rpc_id, method, params, .. } => {
                let result = codex::approval_response(&method, &params, decision);
                server.respond(rpc_id, result).await?;
            }
            PendingApproval::Claude { stdin, request_id, input, suggestions, .. } => {
                let response = match decision {
                    "accept" => json!({ "behavior": "allow", "updatedInput": input }),
                    "acceptForSession" => {
                        let mut r = json!({ "behavior": "allow", "updatedInput": input });
                        if suggestions.as_array().is_some_and(|a| !a.is_empty()) {
                            r["updatedPermissions"] = suggestions;
                        }
                        r
                    }
                    _ => json!({ "behavior": "deny", "message": "El usuario rechazó esta acción desde Duovra." }),
                };
                let line = json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": request_id, "response": response }
                });
                stdin.send(line.to_string()).map_err(|_| anyhow!("El proceso de Claude Code ya terminó"))?;
            }
        }
        self.emit(json!({ "type": "approvalResolved", "runId": run_id, "approvalId": approval_id, "decision": decision }));
        Ok(())
    }

    // ---------- Cancelación y cierre ----------

    pub async fn cancel(&self, run_id: &str) -> Result<()> {
        let run = self.run(run_id).ok_or_else(|| anyhow!("La ejecución ya terminó"))?;
        run.cancel_requested.store(true, Ordering::SeqCst);
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

    pub fn fail(&self, run_id: &str, error: &str) {
        if let Some(run) = self.run(run_id) {
            run.state.lock().error = Some(error.to_string());
        }
        self.finish(run_id, "failed");
    }

    /// Cierra la ejecución una sola vez: guarda el mensaje, la referencia de sesión y el consumo.
    pub fn finish(&self, run_id: &str, status: &str) {
        let Some(run) = self.run(run_id) else { return };
        if run.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let status = if run.cancel_requested.load(Ordering::SeqCst) && status != "failed" {
            "interrupted"
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
        let msg = self
            .db
            .finish_message(&run.message_id, &content, &items, status, error.as_deref(), &usage, exact.as_deref())
            .ok();
        if let (Some(sid), Some(m)) = (&session, &msg) {
            let _ = self
                .db
                .upsert_provider_session(&run.conversation_id, &run.agent, sid, m.seq, run.account_id.as_deref());
        }
        let n = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
        // Solo se registra consumo real: una ejecución que falla antes de llamar al modelo no cuenta.
        if !usage.is_null() && n("inputTokens") + n("outputTokens") > 0 {
            let model = resolved_model.unwrap_or_else(|| run.model.clone());
            let _ = self.db.log_usage(
                &run.conversation_id,
                &run.agent,
                &model,
                n("inputTokens"),
                n("cachedInputTokens"),
                n("outputTokens"),
                usage.get("costUsd").and_then(Value::as_f64),
            );
        }
        let _ = self.db.touch_conversation(&run.conversation_id);
        self.runs.lock().remove(run_id);
        self.conv_runs.lock().remove(&run.conversation_id);
        self.approvals.lock().retain(|_, p| p.run_id() != run_id);
        self.emit(json!({
            "type": "finished", "runId": run_id, "conversationId": run.conversation_id,
            "status": status, "message": msg,
        }));
    }

    pub fn shutdown(&self) {
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

pub struct RunJob {
    pub run: Arc<Run>,
    pub cwd: PathBuf,
    pub session_id: Option<String>,
    pub resume_plan: Option<context::ContextPlan>,
    pub fresh_plan: context::ContextPlan,
    pub user_message_id: String,
    pub attachments: Vec<Value>,
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
