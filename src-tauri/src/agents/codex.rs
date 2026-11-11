//! Adaptador de Codex mediante el protocolo oficial Codex App Server (`codex app-server`).
//!
//! JSON-RPC 2.0 sin cabecera `jsonrpc`, un mensaje JSON por línea sobre stdio.
//! Un único proceso de App Server atiende todas las conversaciones; cada conversación usa su
//! propio hilo (`thread`) y cada envío es un turno (`turn/start`). Los permisos llegan como
//! peticiones del servidor y se responden cuando el usuario decide en la interfaz.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use super::{Control, PendingApproval, Run, RunJob, Studio};
use crate::util::hidden_command;

pub struct CodexServer {
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    thread_runs: Mutex<HashMap<String, String>>,
    loaded: Mutex<HashSet<String>>,
    /// Política de aprobación y sandbox con la que se cargó cada hilo.
    applied: Mutex<HashMap<String, (String, String)>>,
    /// Totales de tokens por hilo, para calcular el consumo de cada turno.
    totals: Mutex<HashMap<String, Value>>,
    baselines: Mutex<HashMap<String, Value>>,
    pub config_dir: Option<String>,
    pub info: Mutex<Value>,
    alive: AtomicBool,
    _child: Mutex<Option<Child>>,
}

impl CodexServer {
    pub async fn spawn(studio: Arc<Studio>, config_dir: Option<String>) -> Result<Arc<Self>> {
        let exe = studio.executable("codex")?;
        let mut cmd = hidden_command(&exe);
        cmd.arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
            loaded: Mutex::new(HashSet::new()),
            applied: Mutex::new(HashMap::new()),
            totals: Mutex::new(HashMap::new()),
            baselines: Mutex::new(HashMap::new()),
            config_dir,
            info: Mutex::new(Value::Null),
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
            let server = server.clone();
            let studio = studio.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(msg) => handle_message(&studio, &server, msg).await,
                        Err(_) => continue,
                    }
                }
                let tail = last_err.lock().join("\n");
                server.on_exit(&studio, &tail).await;
            });
        }

        let init = server
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "duovra", "title": "Duovra", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": false, "requestAttestation": false }
                }),
            )
            .await
            .context("Codex App Server no respondió a initialize")?;
        *server.info.lock() = init;
        server.notify("initialized", Value::Null).await?;
        Ok(server)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    async fn on_exit(&self, studio: &Arc<Studio>, stderr_tail: &str) {
        self.alive.store(false, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Err("Codex App Server terminó".into()));
        }
        let runs: Vec<String> = self.thread_runs.lock().drain().map(|(_, r)| r).collect();
        let detail = if stderr_tail.trim().is_empty() { String::new() } else { format!("\n{stderr_tail}") };
        for run_id in runs {
            studio.fail(&run_id, &format!("Codex App Server terminó inesperadamente.{detail}"));
        }
        let mut slot = studio.codex.lock().await;
        if slot.as_ref().is_some_and(|s| std::ptr::eq(Arc::as_ptr(s), self)) {
            *slot = None;
        }
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
        self.write(&json!({ "id": id, "method": method, "params": params })).await?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(anyhow!("{method}: {e}")),
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
        let wanted = self.config_dir("codex");
        let mut slot = self.codex.lock().await;
        if let Some(s) = slot.as_ref() {
            if s.is_alive() && s.config_dir == wanted {
                return Ok(s.clone());
            }
        }
        let server = CodexServer::spawn(self.clone(), wanted).await?;
        *slot = Some(server.clone());
        Ok(server)
    }

    pub async fn restart_codex(&self) {
        *self.codex.lock().await = None;
    }
}

// ---------- Ejecución de un turno ----------

pub async fn execute(studio: Arc<Studio>, job: RunJob) -> Result<()> {
    let run = job.run.clone();
    let server = studio.codex_server().await?;
    let approval_policy = studio.setting_str("codex.approvalPolicy", "on-request");
    let sandbox = studio.setting_str("codex.sandbox", "workspace-write");
    let cwd = job.cwd.to_string_lossy().to_string();

    let mut thread_id: Option<String> = None;
    let mut use_resume = false;
    if let Some(sid) = &job.session_id {
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
                Ok(_) => {
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
                            "text": format!("No se pudo reanudar el hilo anterior de Codex ({e}). Se abre un hilo nuevo con el contexto compartido de la conversación."),
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
        server.loaded.lock().insert(id.clone());
        server.applied.lock().insert(id.clone(), (approval_policy.clone(), sandbox.clone()));
        thread_id = Some(id);
    }
    let thread_id = thread_id.unwrap();
    let plan = if use_resume { job.resume_plan.as_ref().unwrap_or(&job.fresh_plan) } else { &job.fresh_plan };
    if !use_resume && job.session_id.is_some() {
        studio.set_context_note(&job.user_message_id, &plan.note);
    }

    server.thread_runs.lock().insert(thread_id.clone(), run.id.clone());
    let baseline = server.totals.lock().get(&thread_id).cloned();
    match baseline {
        Some(b) => server.baselines.lock().insert(thread_id.clone(), b),
        None => server.baselines.lock().remove(&thread_id),
    };
    *run.control.lock() = Control::Codex { server: server.clone(), thread_id: thread_id.clone(), turn_id: None };
    studio.set_session(&run, &thread_id);

    if run.cancel_requested.load(Ordering::SeqCst) {
        server.thread_runs.lock().remove(&thread_id);
        studio.finish(&run.id, "interrupted");
        return Ok(());
    }

    let mut input = vec![json!({ "type": "text", "text": plan.prompt, "text_elements": [] })];
    for a in &job.attachments {
        if a["image"] == true {
            input.push(json!({ "type": "localImage", "path": a["path"] }));
        }
    }
    let mut params = json!({ "threadId": thread_id, "input": input, "model": run.model });
    if let Some(effort) = &run.effort {
        params["effort"] = json!(effort);
    }
    // Si los ajustes cambiaron desde que se cargó el hilo, se aplican a este turno y siguientes.
    let wanted = (approval_policy.clone(), sandbox.clone());
    if server.applied.lock().get(&thread_id) != Some(&wanted) {
        params["approvalPolicy"] = json!(approval_policy);
        params["sandboxPolicy"] = sandbox_policy(&sandbox);
        server.applied.lock().insert(thread_id.clone(), wanted);
    }
    let resp = match server.request("turn/start", params).await {
        Ok(r) => r,
        Err(e) => {
            server.thread_runs.lock().remove(&thread_id);
            return Err(e);
        }
    };
    if let Some(turn_id) = resp["turn"]["id"].as_str() {
        if let Control::Codex { turn_id: t, .. } = &mut *run.control.lock() {
            *t = Some(turn_id.to_string());
        }
        if run.cancel_requested.load(Ordering::SeqCst) {
            let _ = server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await;
        }
    }
    Ok(())
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
                    Err(err.get("message").and_then(Value::as_str).unwrap_or("error").to_string())
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
            let mut v = json!({ "id": id, "kind": "text", "status": done });
            if completed {
                v["text"] = item["text"].clone();
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
        "userMessage" | "hookPrompt" => return None,
        other => json!({ "id": id, "kind": "tool", "status": done, "tool": other, "input": Value::Null }),
    })
}

fn sub(a: &Value, b: Option<&Value>, key: &str) -> i64 {
    a[key].as_i64().unwrap_or(0) - b.map(|b| b[key].as_i64().unwrap_or(0)).unwrap_or(0)
}

fn handle_notification(studio: &Arc<Studio>, server: &Arc<CodexServer>, method: &str, params: Value) {
    if method == "account/rateLimits/updated" {
        studio.emit(json!({ "type": "rateLimits", "agent": "codex", "data": params }));
        return;
    }
    let Some(run) = server.run_for(studio, &params) else { return };
    match method {
        "turn/started" => {
            if let Some(turn_id) = params["turn"]["id"].as_str() {
                if let Control::Codex { turn_id: t, .. } = &mut *run.control.lock() {
                    *t = Some(turn_id.to_string());
                }
            }
        }
        "item/started" | "item/completed" => {
            if let Some(item) = normalize_item(&params["item"], method == "item/completed") {
                studio.item(&run, item);
            }
        }
        "item/agentMessage/delta" => {
            if let (Some(item), Some(delta)) = (params["itemId"].as_str(), params["delta"].as_str()) {
                studio.text_delta(&run, item, "text", delta);
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
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
        "thread/tokenUsage/updated" => {
            let thread = params["threadId"].as_str().unwrap_or_default().to_string();
            let total = params["tokenUsage"]["total"].clone();
            let last = params["tokenUsage"]["last"].clone();
            let baseline = {
                let mut b = server.baselines.lock();
                b.entry(thread.clone())
                    .or_insert_with(|| {
                        let keys = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];
                        let mut v = json!({});
                        for k in keys {
                            v[k] = json!(sub(&total, Some(&last), k));
                        }
                        v
                    })
                    .clone()
            };
            server.totals.lock().insert(thread, total.clone());
            studio.set_usage(
                &run,
                json!({
                    "source": "codex",
                    "inputTokens": sub(&total, Some(&baseline), "inputTokens"),
                    "cachedInputTokens": sub(&total, Some(&baseline), "cachedInputTokens"),
                    "outputTokens": sub(&total, Some(&baseline), "outputTokens"),
                    "reasoningTokens": sub(&total, Some(&baseline), "reasoningOutputTokens"),
                    "contextTokens": last["inputTokens"],
                    "contextWindow": params["tokenUsage"]["modelContextWindow"],
                }),
            );
        }
        "error" => {
            let message = params["error"]["message"].as_str().unwrap_or("Error de Codex").to_string();
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
            studio.item(
                &run,
                json!({ "id": format!("reroute-{}", crate::util::now_ms()), "kind": "notice", "status": "completed",
                        "text": format!("Codex cambió el modelo de este turno: {}", params) }),
            );
        }
        "turn/completed" => {
            let turn = &params["turn"];
            let status = match turn["status"].as_str() {
                Some("completed") => "done",
                Some("interrupted") => "interrupted",
                _ => "failed",
            };
            if let Some(msg) = turn["error"]["message"].as_str() {
                run.state.lock().error = Some(msg.to_string());
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
    let info = match method {
        "item/commandExecution/requestApproval" => json!({
            "agent": "codex", "kind": "command", "itemId": params["itemId"],
            "command": params["command"], "cwd": params["cwd"], "reason": params["reason"],
            "options": ["accept", "acceptForSession", "decline"],
        }),
        "item/fileChange/requestApproval" => {
            let changes = params["itemId"]
                .as_str()
                .and_then(|i| run.state.lock().get(i).map(|v| v["changes"].clone()))
                .unwrap_or(Value::Null);
            json!({
                "agent": "codex", "kind": "file_change", "itemId": params["itemId"],
                "reason": params["reason"], "grantRoot": params["grantRoot"], "changes": changes,
                "options": ["accept", "acceptForSession", "decline"],
            })
        }
        _ => json!({
            "agent": "codex", "kind": "permissions", "itemId": params["itemId"],
            "reason": params["reason"], "permissions": params["permissions"], "cwd": params["cwd"],
            "options": ["accept", "acceptForSession", "decline"],
        }),
    };
    studio.request_approval(
        &run,
        PendingApproval::Codex { run_id: run.id.clone(), server: server.clone(), rpc_id: id, method: method.to_string(), params },
        info,
    );
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

pub async fn list_models(studio: &Arc<Studio>) -> Result<Value> {
    let server = studio.codex_server().await?;
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
                }));
            }
        }
        cursor = resp["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(json!({ "source": "Codex App Server · model/list", "models": all }))
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
    }

    #[test]
    fn respuestas_de_permiso() {
        assert_eq!(approval_response("item/commandExecution/requestApproval", &Value::Null, "accept")["decision"], "accept");
        assert_eq!(approval_response("item/fileChange/requestApproval", &Value::Null, "otra")["decision"], "decline");
        let p = json!({"permissions": {"network": {"enabled": true}, "fileSystem": null}});
        let r = approval_response("item/permissions/requestApproval", &p, "acceptForSession");
        assert_eq!(r["scope"], "session");
        assert!(r["permissions"].get("fileSystem").is_none());
    }
}
