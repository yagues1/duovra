//! Adaptador de Codex mediante el protocolo oficial Codex App Server (`codex app-server`).
//!
//! JSON-RPC 2.0 sin cabecera `jsonrpc`, un mensaje JSON por línea sobre stdio.
//! Un proceso de App Server por perfil atiende sus conversaciones; cada conversación usa su
//! propio hilo (`thread`) y cada envío es un turno (`turn/start`). Los permisos llegan como
//! peticiones del servidor y se responden cuando el usuario decide en la interfaz.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use super::{provider_diagnostic, Control, PendingApproval, Run, RunJob, Studio};
use super::insights;
use super::interact::{self, Native};
use crate::util::hidden_command;

#[derive(Debug)]
pub struct RpcError {
    code: i64,
    message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = provider_diagnostic(&self.message, "Codex rechazó la operación.");
        write!(f, "{message} ({})", self.code)
    }
}
impl std::error::Error for RpcError {}

type PendingRpc = oneshot::Sender<Result<Value, RpcError>>;

pub struct CodexServer {
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, PendingRpc>>,
    thread_runs: Mutex<HashMap<String, String>>,
    closed_turns: Mutex<HashSet<String>>,
    steer_supported: AtomicBool,
    /// Métodos que reconoce el servidor instalado (sondeo sin efectos en `initialize`); `None` si no se pudo leer.
    pub methods: Mutex<Option<Vec<String>>>,
    /// Modos de colaboración que publica `collaborationMode/list` (fase 4). Vacío si no hay modo plan.
    pub collaboration: Mutex<Vec<String>>,
    loaded: Mutex<HashSet<String>>,
    /// Política de aprobación y sandbox con la que se cargó cada hilo.
    applied: Mutex<HashMap<String, (String, String)>>,
    pub info: Mutex<Value>,
    /// Compactaciones nativas en curso (`thread/compact/start`): hilo → seguimiento (1.0.11).
    compacting: Mutex<HashMap<String, Compaction>>,
    alive: AtomicBool,
    _child: Mutex<Option<Child>>,
}

impl CodexServer {
    pub async fn spawn(studio: Arc<Studio>, exe: PathBuf, config_dir: Option<String>) -> Result<Arc<Self>> {
        let mut cmd = hidden_command(&exe);
        cmd.arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &config_dir {
            cmd.env("CODEX_HOME", dir);
        }
        let mut child = cmd.spawn().with_context(|| format!("No se pudo iniciar {} app-server", exe.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("Sin stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Sin stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("Sin stderr"))?;

        let server = Arc::new(CodexServer {
            stdin: tokio::sync::Mutex::new(stdin),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            thread_runs: Mutex::new(HashMap::new()),
            closed_turns: Mutex::new(HashSet::new()),
            steer_supported: AtomicBool::new(false),
            methods: Mutex::new(None),
            collaboration: Mutex::new(Vec::new()),
            loaded: Mutex::new(HashSet::new()),
            applied: Mutex::new(HashMap::new()),
            info: Mutex::new(Value::Null),
            compacting: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            _child: Mutex::new(Some(child)),
        });

        // stderr: se descarta salvo las últimas líneas, útiles para diagnosticar.
        let last_err = Arc::new(Mutex::new(Vec::<String>::new()));
        {
            let last_err = last_err.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    let mut v = last_err.lock();
                    v.push(l);
                    if v.len() > 20 {
                        v.remove(0);
                    }
                }
            });
        }

        {
            let server: Weak<CodexServer> = Arc::downgrade(&server);
            let studio = Arc::downgrade(&studio);
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let (Some(studio), Some(server)) = (studio.upgrade(), server.upgrade()) else { break };
                    match serde_json::from_str::<Value>(&line) {
                        Ok(msg) => handle_message(&studio, &server, msg).await,
                        Err(_) => continue,
                    }
                }
                if let (Some(studio), Some(server)) = (studio.upgrade(), server.upgrade()) {
                    let tail = last_err.lock().join("\n");
                    server.on_exit(&studio, &tail).await;
                }
            });
        }

        let init = server
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "duovra", "title": "Duovra", "version": env!("CARGO_PKG_VERSION") },
                    // `experimentalApi` (1.0.11, fase 4): en Codex 0.169 es el único interruptor que admite
                    // `turn/start.collaborationMode` y `collaborationMode/list` (sin él, el App Server responde
                    // «requires experimentalApi capability»). Duovra solo usa de esa superficie el modo plan,
                    // `item/plan/delta` e `item/tool/requestUserInput`; no activa `features.*` ni otras opciones.
                    "capabilities": { "experimentalApi": true, "requestAttestation": false }
                }),
            )
            .await
            .context("Codex App Server no respondió a initialize")?;
        *server.info.lock() = init;
        server.notify("initialized", Value::Null).await?;
        // Consulta de capacidad local: IDs inexistentes. El servidor nunca puede enrutar
        // este RPC a un hilo, incluso si reconoce el método.
        let probe = "00000000-0000-4000-8000-000000000000";
        let result = server.request_timeout("turn/steer", json!({
            "threadId": probe, "expectedTurnId": probe,
            "input": [{"type":"text", "text":"", "text_elements":[]}],
        }), Duration::from_secs(4)).await;
        let supported = result.err().and_then(|error| error.downcast::<RpcError>().ok())
            .is_some_and(|error| error.message.to_ascii_lowercase().contains("thread not found"));
        server.steer_supported.store(supported, Ordering::SeqCst);
        // Lista de métodos del servidor instalado: un nombre inexistente con parámetros de tipo
        // inválido nunca se ejecuta; el App Server responde enumerando los métodos que reconoce.
        let listing = server.request_timeout("duovra/methodProbe", json!("duovra"), Duration::from_secs(4)).await;
        *server.methods.lock() = listing.err().and_then(|error| error.downcast::<RpcError>().ok())
            .and_then(|error| known_methods(&error.message));
        // Modos de colaboración (sin efectos y sin invocar modelos): confirma que el modo plan existe.
        if let Ok(list) = server.request_timeout("collaborationMode/list", json!({}), Duration::from_secs(4)).await {
            *server.collaboration.lock() = collaboration_modes(&list);
        }
        Ok(server)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn supports_steer(&self) -> bool {
        self.steer_supported.load(Ordering::SeqCst)
    }

    /// El App Server instalado publica el modo plan nativo (`collaborationMode/list`).
    pub fn supports_plan(&self) -> bool {
        let modes = self.collaboration.lock();
        modes.iter().any(|m| m == "plan") && modes.iter().any(|m| m == "default")
    }

    async fn on_exit(&self, studio: &Arc<Studio>, stderr_tail: &str) {
        self.alive.store(false, Ordering::SeqCst);
        self.pending.lock().clear();
        let compactions: Vec<(String, Compaction)> = self.compacting.lock().drain().collect();
        for (thread, c) in compactions {
            studio.compaction_finished(&c.conversation_id, "codex", &thread, "failed",
                Some("Codex App Server se cerró durante la compactación.".into()), json!({}));
        }
        let runs: Vec<String> = self.thread_runs.lock().drain().map(|(_, r)| r).collect();
        let message = provider_diagnostic(stderr_tail, "Codex App Server terminó sin confirmar el turno. Revisa la ejecución antes de reintentar.");
        for run_id in runs {
            studio.fail(&run_id, &message);
        }
        studio.codex.lock().await.retain(|_, server| !std::ptr::eq(Arc::as_ptr(server), self));
    }

    async fn write(&self, v: &Value) -> Result<()> {
        let mut line = serde_json::to_string(v)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_timeout(method, params, Duration::from_secs(90)).await
    }

    pub async fn request_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        if !self.is_alive() {
            return Err(anyhow!("Codex App Server no está en ejecución"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        if let Err(error) = self.write(&json!({ "id": id, "method": method, "params": params })).await {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(anyhow::Error::new(e).context(method.to_owned())),
            Ok(Err(_)) => Err(anyhow!("{method}: canal cerrado")),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(anyhow!("{method}: sin respuesta de Codex App Server"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let msg = if params.is_null() { json!({ "method": method }) } else { json!({ "method": method, "params": params }) };
        self.write(&msg).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write(&json!({ "id": id, "result": result })).await
    }

    async fn respond_error(&self, id: Value, message: &str) {
        let _ = self
            .write(&json!({ "id": id, "error": { "code": -32601, "message": message } }))
            .await;
    }

    fn run_for(&self, studio: &Studio, params: &Value) -> Option<Arc<Run>> {
        let thread = params.get("threadId")?.as_str()?;
        let run_id = self.thread_runs.lock().get(thread).cloned()?;
        studio.run(&run_id)
    }
}

impl Studio {
    /// Devuelve el App Server activo para la cuenta seleccionada, iniciándolo si hace falta.
    pub async fn codex_server(self: &Arc<Self>) -> Result<Arc<CodexServer>> {
        self.codex_server_for(self.config_dir("codex")).await
    }

    pub async fn codex_server_for(self: &Arc<Self>, config_dir: Option<String>) -> Result<Arc<CodexServer>> {
        let executable = self.executable("codex")?;
        let key = (executable.clone(), config_dir.clone());
        let mut servers = self.codex.lock().await;
        if let Some(server) = servers.get(&key).filter(|server| server.is_alive()) {
            return Ok(server.clone());
        }
        let server = CodexServer::spawn(self.clone(), executable, config_dir).await?;
        servers.insert(key, server.clone());
        Ok(server)
    }

    pub async fn restart_codex(&self) {
        self.codex.lock().await.retain(|_, server| !server.thread_runs.lock().is_empty());
    }
}

// ---------- Ejecución de un turno ----------

pub async fn execute(studio: Arc<Studio>, job: RunJob) -> Result<()> {
    let run = job.run.clone();
    let server = match job.codex_server {
        Some(server) => server,
        None => studio.codex_server_for(run.config_dir.clone()).await?,
    };
    let chosen = run.permissions.as_ref();
    let approval_policy = studio.permission(chosen.and_then(|p| p.approval.as_ref()), "codex.approvalPolicy", "on-request");
    let sandbox = studio.permission(chosen.and_then(|p| p.sandbox.as_ref()), "codex.sandbox", "workspace-write");
    let cwd = job.cwd.to_string_lossy().to_string();

    let mut thread_id: Option<String> = None;
    let mut established_model = None;
    let mut use_resume = false;
    let mut forked = false;
    if let Some(fork) = &job.fork {
        // Bifurcación nativa (1.0.11, fase 3): un hilo nuevo con el historial de origen hasta `lastTurnId`
        // (inclusive). El hilo de origen no se reanuda ni se modifica. Comprobado con Codex 0.169.0.
        let mut params = json!({
            "threadId": fork.session_id, "cwd": cwd, "approvalPolicy": approval_policy, "sandbox": sandbox, "excludeTurns": true,
        });
        if let Some(turn) = &fork.anchor {
            params["lastTurnId"] = json!(turn);
        }
        match server.request("thread/fork", params).await {
            Ok(response) => match response["thread"]["id"].as_str().filter(|id| *id != fork.session_id) {
                Some(id) => {
                    established_model = response["model"].as_str().map(str::to_owned);
                    server.loaded.lock().insert(id.to_owned());
                    server.applied.lock().insert(id.to_owned(), (approval_policy.clone(), sandbox.clone()));
                    // El hilo bifurcado contiene lo confirmado hasta el punto de corte: es la evidencia del cursor.
                    let _ = studio.db.upsert_provider_session(&run.conversation_id, "codex", id, fork.last_seq, run.account_id.as_deref());
                    let _ = studio.db.resolve_native_origin(&run.conversation_id, "codex", "native", Some(id), None);
                    thread_id = Some(id.to_owned());
                    use_resume = true;
                    forked = true;
                }
                None => {
                    let _ = studio.db.resolve_native_origin(&run.conversation_id, "codex", "rebuilt", None, Some("noThread"));
                }
            },
            Err(e) => {
                let _ = studio.db.resolve_native_origin(&run.conversation_id, "codex", "rebuilt", None, Some(&format!("{e:#}")));
                studio.item(&run, json!({
                    "id": "resume-notice", "kind": "notice", "status": "completed",
                    "text": format!("No se pudo bifurcar el hilo original de Codex ({e}). Duovra continúa en un hilo nuevo con el contexto compartido: no es una copia exacta."),
                }));
            }
        }
    }
    if let Some(sid) = job.session_id.as_ref().filter(|_| thread_id.is_none()) {
        if server.loaded.lock().contains(sid) {
            thread_id = Some(sid.clone());
            use_resume = true;
        } else {
            match server
                .request(
                    "thread/resume",
                    json!({ "threadId": sid, "cwd": cwd, "approvalPolicy": approval_policy, "sandbox": sandbox, "excludeTurns": true }),
                )
                .await
            {
                Ok(response) => {
                    established_model = response["model"].as_str().map(str::to_owned);
                    server.loaded.lock().insert(sid.clone());
                    server.applied.lock().insert(sid.clone(), (approval_policy.clone(), sandbox.clone()));
                    thread_id = Some(sid.clone());
                    use_resume = true;
                }
                Err(e) => {
                    studio.item(
                        &run,
                        json!({
                            "id": "resume-notice", "kind": "notice", "status": "completed",
                            "text": format!("No se pudo reanudar el hilo anterior de Codex ({e}). Duovra reconstruye un hilo nuevo con las instrucciones, la memoria y el historial compartidos: no es el hilo original y no se repite ningún mensaje."),
                        }),
                    );
                }
            }
        }
    }
    if thread_id.is_none() {
        let resp = server
            .request(
                "thread/start",
                json!({ "model": run.model, "cwd": cwd, "approvalPolicy": approval_policy, "sandbox": sandbox }),
            )
            .await?;
        let id = resp["thread"]["id"].as_str().ok_or_else(|| anyhow!("thread/start sin id"))?.to_string();
        established_model = resp["model"].as_str().map(str::to_owned);
        server.loaded.lock().insert(id.clone());
        server.applied.lock().insert(id.clone(), (approval_policy.clone(), sandbox.clone()));
        thread_id = Some(id);
    }
    let thread_id = thread_id.unwrap();
    let plan = if use_resume && job.resume_plan.is_some() { job.resume_plan.as_ref().unwrap() } else { &job.fresh_plan };
    studio.context_chosen(&run, use_resume && job.resume_plan.is_some());
    if !use_resume && (job.session_id.is_some() || job.fork.is_some()) {
        studio.set_context_note(&job.user_message_id, &plan.note);
    }

    let previous = studio.db.previous_metrics(&run.message_id, "codex").ok().flatten();
    let baseline = previous.filter(|p| {
        p["sessionId"].as_str() == Some(&thread_id) && p["previousStatus"] == "done"
    }).map(|p| p["threadTotal"].clone()).unwrap_or_default();
    run.state.lock().codex_usage = insights::CodexUsage::new(!use_resume, baseline);
    studio.update_insights(&run, json!({
        "continuity": if forked { "forked" } else if use_resume { "resumed" } else { "new" },
        "sessionModel": established_model,
    }));
    *run.control.lock() = Control::Codex { server: server.clone(), thread_id: thread_id.clone(), turn_id: None };
    studio.set_session(&run, &thread_id);

    if run.cancel_requested.load(Ordering::SeqCst) {
        server.thread_runs.lock().remove(&thread_id);
        studio.finish(&run.id, "interrupted");
        return Ok(());
    }

    if run.plan_mode && !server.supports_plan() {
        server.thread_runs.lock().remove(&thread_id);
        return Err(anyhow!("Esta versión de Codex no publica el modo plan nativo. Cambia a Construir para enviar el mensaje."));
    }
    let input = turn_input(&plan.prompt, &job.attachments);
    let mut params = json!({ "threadId": thread_id, "input": input, "model": run.model });
    // Modo de trabajo nativo (fase 4). El modo se guarda en el hilo, así que cada turno declara el suyo:
    // `default` al construir y `plan` al planificar, con el mismo modelo y esfuerzo elegidos (el modo
    // tiene prioridad sobre ellos). `developer_instructions: null` usa las instrucciones propias de Codex.
    if server.supports_plan() {
        params["collaborationMode"] = json!({
            "mode": if run.plan_mode { "plan" } else { "default" },
            "settings": { "model": run.model, "reasoning_effort": run.effective_effort, "developer_instructions": null },
        });
    }
    if let Some(effort) = &run.effective_effort {
        params["effort"] = json!(effort);
    }
    // Velocidad solo para este turno: no cambia el nivel del hilo ni la configuración del usuario.
    if let Some(speed) = &run.speed {
        params["serviceTierForTurn"] = json!(speed);
    }
    // Si los ajustes cambiaron desde que se cargó el hilo, se aplican a este turno y siguientes.
    let wanted = (approval_policy.clone(), sandbox.clone());
    let policy_changed = {
        let mut applied = server.applied.lock();
        let changed = applied.get(&thread_id) != Some(&wanted);
        if changed { applied.remove(&thread_id); }
        changed
    };
    if policy_changed {
        params["approvalPolicy"] = json!(approval_policy);
        params["sandboxPolicy"] = sandbox_policy(&sandbox);
    }
    server.thread_runs.lock().insert(thread_id.clone(), run.id.clone());
    studio.context_sent(&run);
    // Revisión nativa (fase 5): `review/start` inline en el mismo hilo. El App Server no admite
    // entrada propia ni cambios de modelo en la revisión: el contexto compartido no viaja.
    let (method, params) = match &run.review {
        Some(target) => ("review/start", json!({ "threadId": thread_id, "target": target, "delivery": "inline" })),
        None => ("turn/start", params),
    };
    let resp = match server.request(method, params).await {
        Ok(r) => r,
        Err(e) => {
            server.thread_runs.lock().retain(|thread, owner| thread != &thread_id || owner != &run.id);
            // Codex rechazó el turno: el contexto no llegó a la sesión y el cursor no avanza.
            studio.context_rejected(&run);
            return Err(e);
        }
    };
    let Some(turn_id) = resp["turn"]["id"].as_str() else {
        server.thread_runs.lock().retain(|thread, owner| thread != &thread_id || owner != &run.id);
        return Err(anyhow!("Codex no confirmó el inicio del turno. Revisa la ejecución antes de reintentar."));
    };
    if policy_changed && server.thread_runs.lock().get(&thread_id) == Some(&run.id) {
        server.applied.lock().insert(thread_id.clone(), wanted);
    }
    studio.update_insights(&run, json!({ "contextSent": true }));
    record_turn(&studio, &server, &run, &thread_id, turn_id);
    if run.cancel_requested.load(Ordering::SeqCst) {
        let _ = server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await;
    }
    Ok(())
}

// ---------- Compactación nativa (1.0.11) ----------

/// Seguimiento de un `thread/compact/start`. Comprobado con Codex 0.169.0: la respuesta (`{}`) solo
/// acepta la solicitud; la compactación real llega como un turno propio (`turn/started` →
/// `item/started|completed` de tipo `contextCompaction` → `turn/completed`).
struct Compaction {
    conversation_id: String,
    turn_id: Option<String>,
    item_done: bool,
}

/// Solicita la compactación nativa de un hilo inactivo. Devuelve al aceptarse la solicitud: el
/// resultado llega por eventos `compaction` cuando Codex completa (o no) su turno de compactación.
pub async fn compact(studio: Arc<Studio>, conversation_id: &str, thread_id: &str, config_dir: Option<String>, cwd: &str) -> Result<()> {
    let server = studio.codex_server_for(config_dir).await?;
    if server.thread_runs.lock().contains_key(thread_id) {
        return Err(anyhow!("Codex está trabajando en este hilo: espera a que termine antes de compactar."));
    }
    if !server.loaded.lock().contains(thread_id) {
        let approval = studio.setting_str("codex.approvalPolicy", "on-request");
        let sandbox = studio.setting_str("codex.sandbox", "workspace-write");
        server.request("thread/resume", json!({ "threadId": thread_id, "cwd": cwd, "approvalPolicy": approval, "sandbox": sandbox, "excludeTurns": true }))
            .await
            .map_err(|e| anyhow!("No se pudo reanudar el hilo de Codex para compactarlo: {e}"))?;
        server.loaded.lock().insert(thread_id.to_owned());
        server.applied.lock().insert(thread_id.to_owned(), (approval, sandbox));
    }
    server.compacting.lock().insert(thread_id.to_owned(), Compaction { conversation_id: conversation_id.to_owned(), turn_id: None, item_done: false });
    if let Err(e) = server.request("thread/compact/start", json!({ "threadId": thread_id })).await {
        server.compacting.lock().remove(thread_id);
        return Err(e);
    }
    studio.compaction_progress(conversation_id, "codex", "accepted");
    // Sin confirmación del proveedor en un plazo razonable, no se da por terminada.
    let (studio2, server2, thread) = (studio.clone(), server.clone(), thread_id.to_owned());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        let stale = server2.compacting.lock().remove(&thread);
        if let Some(c) = stale {
            studio2.compaction_finished(&c.conversation_id, "codex", &thread, "unknown",
                Some("Codex no confirmó el final de la compactación.".into()), json!({}));
        }
    });
    Ok(())
}

/// Eventos de un hilo en compactación. Devuelve `true` si el evento pertenece a una compactación.
fn compaction_event(studio: &Arc<Studio>, server: &CodexServer, method: &str, params: &Value) -> bool {
    let Some(thread) = params["threadId"].as_str() else { return false };
    let mut map = server.compacting.lock();
    let Some(c) = map.get_mut(thread) else { return false };
    let turn = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
    if c.turn_id.is_some() && turn.is_some() && c.turn_id.as_deref() != turn {
        return true;
    }
    match method {
        "turn/started" => {
            c.turn_id = turn.map(str::to_owned);
            let cid = c.conversation_id.clone();
            drop(map);
            studio.compaction_progress(&cid, "codex", "started");
        }
        "item/started" if params["item"]["type"] == "contextCompaction" => {
            let cid = c.conversation_id.clone();
            drop(map);
            studio.compaction_progress(&cid, "codex", "running");
        }
        "item/completed" if params["item"]["type"] == "contextCompaction" => c.item_done = true,
        "turn/completed" => {
            let c = map.remove(thread).expect("compactación presente");
            drop(map);
            let ok = params["turn"]["status"] == "completed" && c.item_done;
            let error = params["turn"]["error"]["message"].as_str().map(|m| provider_diagnostic(m, "Codex no pudo compactar el hilo."))
                .or_else(|| (!ok).then(|| "Codex terminó sin confirmar la compactación.".to_owned()));
            studio.compaction_finished(&c.conversation_id, "codex", thread, if ok { "completed" } else { "failed" }, error, json!({}));
        }
        _ => {}
    }
    true
}

pub fn turn_input(text: &str, attachments: &[Value]) -> Vec<Value> {
    let mut input = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
    input.extend(attachments.iter().filter(|file| file["image"] == true)
        .map(|file| json!({ "type": "localImage", "path": file["path"] })));
    input
}

fn record_turn(studio: &Studio, server: &CodexServer, run: &Run, thread_id: &str, id: &str) {
    if server.closed_turns.lock().contains(id) || run.is_finished() { return; }
    let mut control = run.control.lock();
    if let Control::Codex { turn_id, .. } = &mut *control {
        if turn_id.is_none() {
            *turn_id = Some(id.to_string());
            // Codex aceptó el turno: la entrada (con el contexto compartido) forma parte del hilo.
            studio.context_confirmed(run);
            studio.record_provider_turn(run, thread_id, id);
            studio.update_insights(run, json!({ "contextSent": true }));
            studio.run_ready(run, server.supports_steer());
        }
    }
}

fn sandbox_policy(mode: &str) -> Value {
    match mode {
        "read-only" => json!({ "type": "readOnly", "networkAccess": false }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false }),
    }
}

// ---------- Mensajes del servidor ----------

async fn handle_message(studio: &Arc<Studio>, server: &Arc<CodexServer>, msg: Value) {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let id = msg.get("id").cloned();
    match (method, id) {
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            if let Some(tx) = server.pending.lock().remove(&id) {
                let res = if let Some(err) = msg.get("error") {
                    Err(RpcError {
                        code: err["code"].as_i64().unwrap_or_default(),
                        message: err["message"].as_str().unwrap_or("Error de Codex").to_owned(),
                    })
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(res);
            }
        }
        (Some(method), Some(id)) => handle_server_request(studio, server, &method, id, msg.get("params").cloned().unwrap_or(Value::Null)).await,
        (Some(method), None) => handle_notification(studio, server, &method, msg.get("params").cloned().unwrap_or(Value::Null)),
        _ => {}
    }
}

fn status_of(s: Option<&str>) -> &'static str {
    match s {
        Some("inProgress") => "running",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("declined") => "declined",
        _ => "completed",
    }
}

/// Traduce un `ThreadItem` de Codex a la cronología normalizada.
pub fn normalize_item(item: &Value, completed: bool) -> Option<Value> {
    let id = item.get("id")?.as_str()?;
    let ty = item.get("type")?.as_str()?;
    let done = if completed { "completed" } else { "running" };
    Some(match ty {
        "agentMessage" => {
            // Respuesta que el proveedor indica ocultar o bloquear (`moderation.display`, 0.172):
            // nunca se muestra ni se guarda su texto.
            if hidden_by_provider(item) {
                return Some(json!({ "id": id, "kind": "notice", "status": done, "text": "Codex indica que esta respuesta no debe mostrarse." }));
            }
            let mut v = json!({ "id": id, "kind": "text", "status": done });
            if completed {
                v["text"] = item["text"].clone();
            }
            // `commentary` identifica las notas de trabajo; `final_answer`, la respuesta.
            if let Some(phase) = item["phase"].as_str() {
                v["phase"] = json!(phase);
            }
            v
        }
        "reasoning" => {
            let summary: Vec<String> = item["summary"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut v = json!({ "id": id, "kind": "reasoning", "status": done });
            if completed {
                v["text"] = json!(summary.join("\n\n"));
            }
            v
        }
        "commandExecution" => json!({
            "id": id, "kind": "command",
            "status": status_of(item["status"].as_str()),
            "command": item["command"], "cwd": item["cwd"],
            "output": if completed { item["aggregatedOutput"].clone() } else { Value::Null },
            "exitCode": item["exitCode"], "durationMs": item["durationMs"],
            // Clasificación que publica el propio App Server (lectura, listado, búsqueda).
            "actions": command_actions(&item["commandActions"]),
        }),
        "fileChange" => json!({
            "id": id, "kind": "file_change",
            "status": status_of(item["status"].as_str()),
            "changes": item["changes"].as_array().map(|a| a.iter().map(|c| json!({
                "path": c["path"], "kind": c["kind"]["type"], "diff": c["diff"],
            })).collect::<Vec<_>>()).unwrap_or_default(),
        }),
        "mcpToolCall" => json!({
            "id": id, "kind": "tool",
            "status": status_of(item["status"].as_str()),
            "tool": format!("{}/{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("?")),
            "input": item["arguments"],
            "result": if item["error"].is_null() { item["result"].clone() } else { item["error"].clone() },
        }),
        "webSearch" => json!({
            "id": id, "kind": "web_search", "status": done,
            "query": item.get("query").cloned().unwrap_or(Value::Null),
            "input": item.get("action").cloned().unwrap_or(Value::Null),
        }),
        "plan" => json!({ "id": id, "kind": "plan", "status": done, "text": item["text"] }),
        "contextCompaction" => json!({ "id": id, "kind": "notice", "status": done, "text": "Codex compactó el contexto del hilo." }),
        "enteredReviewMode" => json!({ "id": id, "kind": "notice", "status": done, "text": format!("Revisión de código iniciada: {}.", review_label(&item["review"])) }),
        "exitedReviewMode" => json!({ "id": id, "kind": "notice", "status": done, "text": "Revisión de código terminada. Codex no modifica archivos durante la revisión." }),
        "userMessage" | "hookPrompt" => return None,
        other => json!({ "id": id, "kind": "tool", "status": done, "tool": other, "input": Value::Null }),
    })
}

/// `moderation.display.mode` = `hide` o `block` (Codex 0.172): el texto no debe recuperarse.
pub fn hidden_by_provider(item: &Value) -> bool {
    matches!(item["moderation"]["display"]["mode"].as_str(), Some("hide" | "block"))
}

fn review_label(review: &Value) -> String {
    match review.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => crate::util::clip_middle(text, 160),
        None => "cambios del proyecto".into(),
    }
}

/// Conserva solo los campos descriptivos de `commandActions` (tipo, ruta, nombre o consulta).
fn command_actions(actions: &Value) -> Value {
    let Some(list) = actions.as_array().filter(|list| !list.is_empty()) else { return Value::Null };
    Value::Array(list.iter().filter_map(|action| {
        let kind = action["type"].as_str()?;
        let mut entry = json!({ "type": kind });
        for key in ["path", "name", "query"] {
            if let Some(value) = action[key].as_str().filter(|v| !v.is_empty()) {
                entry[key] = json!(value);
            }
        }
        Some(entry)
    }).collect())
}

fn project_agents(item: &Value, thread: &str) -> Value {
    let mut agents = serde_json::Map::new();
    let Some(item_id) = item["id"].as_str() else { return json!({}); };
    match item["type"].as_str() {
        Some("subAgentActivity") => {
            if let Some(id) = item["agentThreadId"].as_str().filter(|id| !id.is_empty() && *id != thread) {
                let mut agent = json!({
                    "id": id, "role": item["agentPath"], "model": item["model"],
                    "effort": item["reasoningEffort"], "itemId": item_id,
                });
                if let Some(status) = insights::status(&item["kind"]) { agent["status"] = json!(status); }
                agents.insert(id.to_owned(), agent);
            }
        }
        Some("collabAgentToolCall") if item["senderThreadId"].as_str() == Some(thread) => {
            let spawn = item["tool"] == "spawnAgent";
            if let Some(ids) = item["receiverThreadIds"].as_array() {
                for id in ids.iter().filter_map(Value::as_str).filter(|id| !id.is_empty() && *id != thread) {
                    let state = &item["agentsStates"][id];
                    if state["status"] == "notFound" || (!spawn && !state.is_object()) { continue; }
                    let mut agent = json!({ "id": id, "parentId": thread, "itemId": item_id });
                    if spawn {
                        agent["description"] = item["prompt"].clone();
                        agent["model"] = item["model"].clone();
                        agent["effort"] = item["reasoningEffort"].clone();
                    }
                    if let Some(status) = insights::status(&state["status"]) { agent["status"] = json!(status); }
                    if let Some(message) = state["message"].as_str() { agent["result"] = json!(message); }
                    agents.insert(id.to_owned(), agent);
                }
            }
        }
        _ => {}
    }
    for agent in agents.values_mut().filter_map(Value::as_object_mut) {
        agent.retain(|_, value| !value.is_null());
    }
    json!(agents)
}

fn handle_notification(studio: &Arc<Studio>, server: &Arc<CodexServer>, method: &str, params: Value) {
    if method == "account/rateLimits/updated" {
        studio.emit(json!({ "type": "rateLimits", "agent": "codex", "data": params }));
        return;
    }
    if compaction_event(studio, server, method, &params) {
        return;
    }
    let Some(run) = server.run_for(studio, &params) else { return };
    let thread = params["threadId"].as_str().unwrap_or_default();
    let event_turn = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
    let active_turn = match &*run.control.lock() {
        Control::Codex { turn_id, .. } => turn_id.clone(),
        _ => None,
    };
    if let Some(id) = event_turn {
        if server.closed_turns.lock().contains(id) { return; }
        if active_turn.as_deref().is_some_and(|active| active != id) { return; }
    }
    let verified = || active_turn.as_deref().zip(event_turn).is_some_and(|(active, id)| {
        active == id && studio.provider_identity(&run, thread, id)
    });
    match method {
        "turn/started" => {
            if let (Some(thread), Some(id)) = (params["threadId"].as_str(), event_turn) {
                record_turn(studio, server, &run, thread, id);
            }
        }
        "item/started" | "item/completed" => {
            let raw = &params["item"];
            // Plan propuesto en modo plan (fase 4): tarjeta de aprobación. Una lista de tareas
            // (`turn/plan/updated`) nunca se convierte en un plan pendiente.
            if raw["type"] == "plan" && run.plan_mode {
                if let Some(mut item) = normalize_item(raw, method == "item/completed") {
                    item["kind"] = json!("plan_proposal");
                    studio.item(&run, item);
                }
                let text = raw["text"].as_str().filter(|t| !t.trim().is_empty());
                if let (true, Some(id), Some(text)) = (method == "item/completed", raw["id"].as_str(), text) {
                    studio.open_interaction(&run, "plan", Some(id), interact::plan_payload(text, "plan", None), None);
                }
                return;
            }
            if matches!(raw["type"].as_str(), Some("collabAgentToolCall" | "subAgentActivity" | "contextCompaction")) && verified() {
                let agents = project_agents(raw, thread);
                if agents.as_object().is_some_and(|a| !a.is_empty()) {
                    studio.update_insights(&run, json!({ "subagents": agents }));
                }
                if raw["type"] == "contextCompaction" && method == "item/completed" {
                    studio.update_insights(&run, json!({ "compacted": true }));
                    studio.native_compacted(&run, json!({ "trigger": "auto" }));
                }
            }
            if let Some(item) = normalize_item(&params["item"], method == "item/completed") {
                studio.item(&run, item);
            }
        }
        "item/plan/delta" => {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                studio.text_delta(&run, item, if run.plan_mode { "plan_proposal" } else { "plan" }, delta);
            }
        }
        "item/agentMessage/delta" => {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                studio.text_delta(&run, item, "text", delta);
            }
        }
        // Solo el resumen que el proveedor publica para mostrarse. El contenido bruto del
        // razonamiento (`item/reasoning/textDelta`) no se presenta en la interfaz.
        "item/reasoning/summaryTextDelta" => {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                studio.text_delta(&run, item, "reasoning", delta);
            }
        }
        "item/reasoning/summaryPartAdded" => {
            if let Some(item) = params["itemId"].as_str() {
                if run.state.lock().get(item).is_some() {
                    studio.text_delta(&run, item, "reasoning", "\n\n");
                }
            }
        }
        "item/commandExecution/outputDelta" => {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                studio.output_delta(&run, item, delta);
            }
        }
        "turn/diff/updated" => {
            if let Some(diff) = params["diff"].as_str() {
                studio.item(&run, json!({ "id": "turn-diff", "kind": "diff", "status": "completed", "diff": diff }));
            }
        }
        "turn/plan/updated" if verified() => {
            if let Some(tasks) = insights::plan_steps(&params["plan"], "step") {
                studio.record_plan(&run, "Codex · turn/plan/updated", tasks, &params["explanation"]);
            }
        }
        "thread/compacted" if event_turn.is_some() && verified() => {
            studio.update_insights(&run, json!({ "compacted": true }));
        }
        "thread/tokenUsage/updated" if verified() => {
            let usage = run.state.lock().codex_usage.snapshot(&params["tokenUsage"], thread);
            if let Some(usage) = usage { studio.set_usage(&run, usage); }
        }
        "error" => {
            let message = provider_diagnostic(params["error"]["message"].as_str().unwrap_or_default(),
                "Codex informó de un error durante el turno.");
            if params["willRetry"] == true {
                studio.item(
                    &run,
                    json!({ "id": format!("retry-{}", crate::util::now_ms()), "kind": "notice", "status": "completed", "text": format!("Codex reintenta tras un error: {message}") }),
                );
            } else {
                run.state.lock().error = Some(message);
            }
        }
        "model/rerouted" => {
            if verified() {
                studio.update_insights(&run, json!({ "reroutedFrom": params["fromModel"], "reroutedTo": params["toModel"] }));
            }
            studio.item(
                &run,
                json!({ "id": format!("reroute-{}", crate::util::now_ms()), "kind": "notice", "status": "completed",
                        "text": format!("Codex cambió el modelo de este turno: {}", params) }),
            );
        }
        "turn/completed" => {
            let Some(id) = event_turn else { return };
            server.closed_turns.lock().insert(id.to_string());
            if let Some(thread) = params["threadId"].as_str() {
                studio.record_provider_turn(&run, thread, id);
            }
            let turn = &params["turn"];
            let status = match turn["status"].as_str() {
                Some("completed") => "done",
                Some("interrupted") => "interrupted",
                _ => "failed",
            };
            if let Some(msg) = turn["error"]["message"].as_str() {
                run.state.lock().error = Some(provider_diagnostic(msg, "Codex no pudo completar el turno. Revisa la ejecución antes de reintentar."));
            }
            if let Some(thread) = params["threadId"].as_str() {
                server.thread_runs.lock().remove(thread);
            }
            studio.finish(&run.id, status);
        }
        _ => {}
    }
}

async fn handle_server_request(studio: &Arc<Studio>, server: &Arc<CodexServer>, method: &str, id: Value, params: Value) {
    if method == "item/tool/requestUserInput" {
        return user_input_request(studio, server, id, params).await;
    }
    let supported = matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval"
    );
    if !supported {
        server.respond_error(id, "Duovra no admite esta petición").await;
        return;
    }
    let Some(run) = server.run_for(studio, &params) else {
        let _ = server.respond(id, approval_response(method, &params, "decline")).await;
        return;
    };
    let active_turn = match &*run.control.lock() {
        Control::Codex { turn_id, .. } => turn_id.clone(),
        _ => None,
    };
    if active_turn.as_deref().is_none_or(|turn| params["turnId"].as_str() != Some(turn)) {
        let _ = server.respond(id, approval_response(method, &params, "decline")).await;
        return;
    }
    let options = approval_options(&params);
    let info = match method {
        "item/commandExecution/requestApproval" => json!({
            "agent": "codex", "kind": "command", "itemId": params["itemId"],
            "command": params["command"], "cwd": params["cwd"], "reason": params["reason"],
            "options": options,
        }),
        "item/fileChange/requestApproval" => {
            let changes = params["itemId"]
                .as_str()
                .and_then(|i| run.state.lock().get(i).map(|v| v["changes"].clone()))
                .unwrap_or(Value::Null);
            json!({
                "agent": "codex", "kind": "file_change", "itemId": params["itemId"],
                "reason": params["reason"], "grantRoot": params["grantRoot"], "changes": changes,
                "options": options,
            })
        }
        _ => json!({
            "agent": "codex", "kind": "permissions", "itemId": params["itemId"],
            "reason": params["reason"], "permissions": params["permissions"], "cwd": params["cwd"],
            "options": options,
        }),
    };
    if !studio.request_approval(
        &run,
        PendingApproval::Codex {
            run_id: run.id.clone(), server: server.clone(), rpc_id: id.clone(), method: method.to_string(), params: params.clone(),
        },
        info,
    ) {
        let _ = server.respond(id, approval_response(method, &params, "cancel")).await;
    }
}

/// Preguntas de Codex (`item/tool/requestUserInput`, fase 4). Se vinculan al turno activo del hilo
/// y se responden con la estructura exacta de 0.169 (`ToolRequestUserInputResponse`).
async fn user_input_request(studio: &Arc<Studio>, server: &Arc<CodexServer>, id: Value, params: Value) {
    let empty = json!({ "answers": {} });
    let Some(run) = server.run_for(studio, &params) else {
        let _ = server.respond(id, empty).await;
        return;
    };
    let active_turn = match &*run.control.lock() {
        Control::Codex { turn_id, .. } => turn_id.clone(),
        _ => None,
    };
    if active_turn.as_deref().is_none_or(|turn| params["turnId"].as_str() != Some(turn)) {
        let _ = server.respond(id, empty).await;
        return;
    }
    let Some(payload) = interact::codex_questions(&params) else {
        server.respond_error(id, "Duovra no pudo leer las preguntas").await;
        return;
    };
    // Elemento propio de la cronología: no se confunde con el de la llamada a la herramienta.
    let item = format!("q:{}", params["itemId"].as_str().unwrap_or("pending"));
    studio.item(&run, json!({ "id": item, "kind": "question", "status": "running", "questions": payload["questions"] }));
    let native = Native::Codex { server: server.clone(), rpc_id: id.clone() };
    if studio.open_interaction(&run, "question", Some(&item), payload, Some(native)).is_none() {
        let _ = server.respond(id, empty).await;
    }
}

/// Modos que devuelve `collaborationMode/list` (`data[].mode`).
pub(super) fn collaboration_modes(list: &Value) -> Vec<String> {
    list["data"].as_array().into_iter().flatten().filter_map(|m| m["mode"].as_str()).map(str::to_owned).collect()
}

/// Extrae los métodos de un error `unknown variant `x`, expected one of `a`, `b`…` del App Server.
pub(super) fn known_methods(message: &str) -> Option<Vec<String>> {
    let (_, list) = message.split_once("expected one of")?;
    let methods: Vec<String> = list.split('`').skip(1).step_by(2).filter(|m| !m.is_empty()).map(str::to_owned).collect();
    (!methods.is_empty()).then_some(methods)
}

pub(super) fn approval_options(params: &Value) -> Vec<&'static str> {
    ["accept", "acceptForSession", "decline"].into_iter().filter(|&decision| {
        decision == "decline" || params["availableDecisions"].as_array()
            .is_none_or(|allowed| allowed.iter().any(|entry| entry.as_str() == Some(decision)))
    }).collect()
}

fn strip_nulls(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), strip_nulls(v))).collect()),
        other => other.clone(),
    }
}

/// Respuesta que espera Codex App Server para cada tipo de solicitud de permiso.
pub fn approval_response(method: &str, params: &Value, decision: &str) -> Value {
    let decision = match decision {
        "accept" | "acceptForSession" | "decline" | "cancel" => decision,
        _ => "decline",
    };
    if method == "item/permissions/requestApproval" {
        return match decision {
            "accept" => json!({ "permissions": strip_nulls(&params["permissions"]), "scope": "turn" }),
            "acceptForSession" => json!({ "permissions": strip_nulls(&params["permissions"]), "scope": "session" }),
            _ => json!({ "permissions": {}, "scope": "turn" }),
        };
    }
    json!({ "decision": decision })
}

// ---------- Consultas para ajustes ----------

pub async fn models_on(server: &CodexServer) -> Result<Value> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let resp = server.request("model/list", json!({ "cursor": cursor, "includeHidden": false })).await?;
        if let Some(arr) = resp["data"].as_array() {
            for m in arr {
                all.push(json!({
                    "id": m["model"], "label": m["displayName"], "description": m["description"],
                    "efforts": m["supportedReasoningEfforts"].as_array().map(|a| a.iter().map(|e| e["reasoningEffort"].clone()).filter(Value::is_string).collect::<Vec<_>>()).unwrap_or_default(),
                    "defaultEffort": m["defaultReasoningEffort"], "isDefault": m["isDefault"],
                    "inputModalities": m["inputModalities"], "notice": m["availabilityNux"]["message"],
                    "fast": fast_tier(m),
                    // Codex no usa alias: `model` es el identificador exacto.
                    "exact": m["model"], "upgrade": m["upgrade"], "specialty": m["modelSpecialty"],
                    "traits": { "multiAgent": m["multiAgentVersion"] },
                }));
            }
        }
        cursor = resp["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let version = server.info.lock()["userAgent"].as_str().and_then(user_agent_version);
    Ok(json!({ "source": "Codex App Server · model/list", "models": all, "version": version }))
}

/// Versión del App Server a partir de `userAgent` (`duovra/0.169.0 (Windows…)` → `0.169.0`).
pub(super) fn user_agent_version(agent: &str) -> Option<String> {
    let version = agent.split_whitespace().next()?.split_once('/')?.1;
    version.chars().next().filter(char::is_ascii_digit).map(|_| version.to_owned())
}

/// Nivel de servicio rápido que publica `model/list` (`serviceTiers`, p. ej. `priority` = «Fast»).
fn fast_tier(model: &Value) -> Value {
    model["serviceTiers"].as_array().and_then(|tiers| tiers.iter().find(|tier| {
        tier["name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case("fast"))
    })).and_then(|tier| {
        let id = tier["id"].as_str().filter(|id| !id.is_empty() && *id != "default")?;
        Some(json!({ "id": id, "label": "Rápido", "description": tier["description"] }))
    }).unwrap_or(Value::Null)
}

pub async fn account_status(studio: &Arc<Studio>) -> Result<Value> {
    let server = studio.codex_server().await?;
    let account = server.request("account/read", json!({})).await?;
    Ok(json!({ "account": account["account"], "requiresOpenaiAuth": account["requiresOpenaiAuth"], "server": *server.info.lock() }))
}

pub async fn rate_limits(studio: &Arc<Studio>) -> Result<Value> {
    let server = studio.codex_server().await?;
    server.request("account/rateLimits/read", json!({})).await
}

pub async fn start_login(studio: &Arc<Studio>) -> Result<Value> {
    let server = studio.codex_server().await?;
    server.request("account/login/start", json!({ "type": "chatgpt" })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_comando_y_cambios() {
        let cmd = json!({"type":"commandExecution","id":"i1","command":"ls","cwd":"C:/p","status":"completed","aggregatedOutput":"a","exitCode":0,"durationMs":5,"commandActions":[],"source":"agent","processId":null,"pluginId":null,"scriptPath":null});
        let n = normalize_item(&cmd, true).unwrap();
        assert_eq!(n["kind"], "command");
        assert_eq!(n["output"], "a");
        let fc = json!({"type":"fileChange","id":"i2","status":"inProgress","changes":[{"path":"a.ts","kind":{"type":"update","move_path":null},"diff":"@@"}]});
        let n = normalize_item(&fc, false).unwrap();
        assert_eq!(n["status"], "running");
        assert_eq!(n["changes"][0]["kind"], "update");
        assert!(normalize_item(&json!({"type":"userMessage","id":"u"}), true).is_none());
        let read = json!({"type":"commandExecution","id":"i3","command":"cat a.ts","status":"completed","commandActions":[{"type":"read","command":"cat a.ts","name":"a.ts","path":"C:/p/a.ts"}]});
        let n = normalize_item(&read, true).unwrap();
        assert_eq!(n["actions"][0]["type"], "read");
        assert_eq!(n["actions"][0]["name"], "a.ts");
        assert!(n["actions"][0].get("command").is_none());
        let note = json!({"type":"agentMessage","id":"m1","text":"Reviso","phase":"commentary"});
        assert_eq!(normalize_item(&note, true).unwrap()["phase"], "commentary");
        let empty = json!({"type":"reasoning","id":"r1","summary":[],"content":["privado"]});
        assert_eq!(normalize_item(&empty, true).unwrap()["text"], "");
    }

    #[test]
    fn modos_de_colaboracion() {
        // Respuesta real de Codex 0.169.0 (`collaborationMode/list`, sin invocar modelos).
        let list = json!({ "data": [
            { "name": "Plan", "mode": "plan", "model": null, "reasoning_effort": "medium" },
            { "name": "Default", "mode": "default", "model": null, "reasoning_effort": null },
        ] });
        assert_eq!(collaboration_modes(&list), ["plan", "default"]);
        assert!(collaboration_modes(&json!({})).is_empty());
    }

    #[test]
    fn nivel_rapido_del_catalogo() {
        let model = json!({"serviceTiers":[{"id":"priority","name":"Fast","description":"1.5x speed"}]});
        assert_eq!(fast_tier(&model)["id"], "priority");
        assert!(fast_tier(&json!({"serviceTiers":[]})).is_null());
        assert!(fast_tier(&json!({"serviceTiers":[{"id":"flex","name":"Flex"}]})).is_null());
    }

    #[test]
    fn metodos_conocidos_y_version() {
        let message = "Invalid request: unknown variant `duovra/methodProbe`, expected one of `initialize`, `thread/fork`, `model/list`";
        assert_eq!(known_methods(message).unwrap(), ["initialize", "thread/fork", "model/list"]);
        assert!(known_methods("Invalid request: invalid type: string").is_none());
        assert_eq!(user_agent_version("duovra/0.169.0 (Windows 10.0.26300; x86_64)").as_deref(), Some("0.169.0"));
        assert!(user_agent_version("codex").is_none());
    }

    #[test]
    fn respuestas_de_permiso() {
        assert_eq!(approval_response("item/commandExecution/requestApproval", &Value::Null, "accept")["decision"], "accept");
        assert_eq!(approval_response("item/fileChange/requestApproval", &Value::Null, "otra")["decision"], "decline");
        let p = json!({"permissions": {"network": {"enabled": true}, "fileSystem": null}});
        let r = approval_response("item/permissions/requestApproval", &p, "acceptForSession");
        assert_eq!(r["scope"], "session");
        assert!(r["permissions"].get("fileSystem").is_none());
        assert_eq!(approval_options(&json!({"availableDecisions":["accept","decline"]})), ["accept", "decline"]);
        assert_eq!(approval_options(&json!({"availableDecisions":[]})), ["decline"]);
        // Fase 5: revisión y respuestas ocultas por el proveedor.
        let entered = normalize_item(&json!({"type":"enteredReviewMode","id":"r1","review":"current changes"}), true).unwrap();
        assert_eq!(entered["kind"], "notice");
        assert!(entered["text"].as_str().unwrap().contains("current changes"));
        let hidden = json!({"type":"agentMessage","id":"m1","text":"secreto","moderation":{"moderated":true,"display":{"mode":"hide","version":1,"replacement":{"kind":"wellbeingPromptHelpline"}}}});
        assert!(hidden_by_provider(&hidden));
        let shown = normalize_item(&hidden, true).unwrap();
        assert_eq!(shown["kind"], "notice");
        assert!(!shown.to_string().contains("secreto"));
        assert!(!hidden_by_provider(&json!({"type":"agentMessage","moderation":{"display":{"mode":"show"}}})));
        // Fase 5: el error original queda en los detalles, pero nunca una credencial.
        let error = RpcError { code: 401, message: "Unauthorized: Bearer qa-canario sk-qa-secreto token=qa-token-1 1a2b3c4d5e6f7a8b9c0d1e2f3a4b".into() };
        let text = error.to_string();
        assert!(text.contains("vuelve a iniciar sesión"));
        assert!(text.contains("Detalle del proveedor: Unauthorized:"));
        for secret in ["qa-canario", "sk-qa-secreto", "qa-token-1", "1a2b3c4d5e6f7a8b9c0d1e2f3a4b"] {
            assert!(!text.contains(secret), "{text}");
        }
    }
}
