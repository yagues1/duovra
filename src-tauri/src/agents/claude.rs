//! Adaptador de Claude Code mediante su modo no interactivo documentado (`claude -p`).
//!
//! Se ejecuta la CLI instalada por el usuario, con su propia autenticación y configuración
//! (CLAUDE.md, ajustes, hooks y plugins). La aplicación nunca lee ni reutiliza tokens: solo
//! lanza el ejecutable oficial con `--input-format stream-json --output-format stream-json`
//! y `--permission-prompts host --permission-prompt-tool stdio`, de modo que las solicitudes de
//! permiso llegan a la interfaz como `control_request` (`can_use_tool`) y el usuario decide.
//!
//! Cada envío es un proceso: el primero crea la sesión y los siguientes la reanudan con
//! `--resume <session_id>`.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::{Control, PendingApproval, Run, RunJob, Studio};
use crate::util::{hidden_command, new_id};

const CLOSE: &str = "\u{0}__close__";

fn claude_home(config_dir: Option<&str>) -> Option<PathBuf> {
    config_dir.map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
}

/// Comprueba si la sesión sigue en disco antes de intentar reanudarla.
pub fn session_exists(config_dir: Option<&str>, session_id: &str) -> bool {
    let Some(projects) = claude_home(config_dir).map(|h| h.join("projects")) else { return false };
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .map(|rd| rd.flatten().any(|e| e.path().join(&file).is_file()))
        .unwrap_or(false)
}

fn image_block(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 > super::CLAUDE_IMAGE_MAX {
        return None;
    }
    let media = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }
    }))
}

pub async fn execute(studio: Arc<Studio>, job: RunJob) -> Result<()> {
    let run = job.run.clone();
    let exe = studio.executable("claude")?;
    let config_dir = studio.config_dir("claude");
    let resumable = job
        .session_id
        .clone()
        .filter(|sid| session_exists(config_dir.as_deref(), sid));
    let plan = if resumable.is_some() { job.resume_plan.as_ref().unwrap_or(&job.fresh_plan) } else { &job.fresh_plan };
    if job.session_id.is_some() && resumable.is_none() {
        studio.set_context_note(&job.user_message_id, &plan.note);
        studio.item(
            &run,
            json!({ "id": "resume-notice", "kind": "notice", "status": "completed",
                    "text": "La sesión anterior de Claude Code ya no está disponible. Se abre una sesión nueva con el contexto compartido de la conversación." }),
        );
    }

    let permission_mode = studio.setting_str("claude.permissionMode", "manual");
    let mut cmd = hidden_command(&exe);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompts",
        "host",
        // Sin esta opción, `host` no tiene a quién preguntar en modo -p y la CLI deniega sola
        // (comprobado con la 2.1.316). `stdio` es el canal que usa el Agent SDK oficial.
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        &permission_mode,
        "--model",
        &run.model,
    ]);
    if let Some(effort) = &run.effort {
        cmd.args(["--effort", effort]);
    }
    if let Some(sid) = &resumable {
        cmd.args(["--resume", sid]);
    }
    if let Some(dir) = &config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.current_dir(&job.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().with_context(|| format!("No se pudo iniciar {}", exe.display()))?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("Sin stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("Sin stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("Sin stderr"))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    *run.control.lock() = Control::Claude { stdin: tx.clone(), kill: Some(kill_tx) };

    // Escritor de stdin: una línea JSON por mensaje; CLOSE cierra la entrada y la CLI termina.
    tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if line == CLOSE {
                break;
            }
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
        let _ = stdin.shutdown().await;
    });

    let stderr_tail = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    {
        let tail = stderr_tail.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut v = tail.lock();
                v.push(l);
                if v.len() > 30 {
                    v.remove(0);
                }
            }
        });
    }

    let mut content = vec![json!({ "type": "text", "text": plan.prompt })];
    for a in &job.attachments {
        if a["image"] == true {
            if let Some(b) = a["path"].as_str().and_then(|p| image_block(Path::new(p))) {
                content.push(b);
            }
        }
    }
    let user = json!({
        "type": "user",
        "session_id": "",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null
    });
    tx.send(user.to_string()).map_err(|_| anyhow!("No se pudo escribir en Claude Code"))?;

    let resumed = resumable.is_some();
    let reader = {
        let studio = studio.clone();
        let run = run.clone();
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut parser = StreamParser { resumed, ..Default::default() };
            let mut lines = BufReader::new(stdout).lines();
            let mut got_result = false;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if parser.handle(&studio, &run, &tx, msg) {
                    got_result = true;
                    let _ = tx.send(CLOSE.to_string());
                }
            }
            got_result
        })
    };
    drop(tx);

    tokio::select! {
        _ = child.wait() => {}
        _ = kill_rx => { let _ = child.kill().await; }
    }
    let got_result = tokio::time::timeout(Duration::from_secs(5), reader)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);
    *run.control.lock() = Control::None;

    if got_result {
        let failed = run.state.lock().error.is_some();
        studio.finish(&run.id, if failed { "failed" } else { "done" });
    } else if run.cancel_requested.load(Ordering::SeqCst) {
        studio.finish(&run.id, "interrupted");
    } else {
        let tail = stderr_tail.lock().join("\n");
        let msg = if tail.trim().is_empty() {
            "Claude Code terminó sin devolver un resultado.".to_string()
        } else {
            format!("Claude Code terminó sin devolver un resultado:\n{tail}")
        };
        studio.fail(&run.id, &msg);
    }
    Ok(())
}

/// Convierte los mensajes `stream-json` de Claude Code en la cronología normalizada.
#[derive(Default)]
struct StreamParser {
    /// El proceso reanudó una sesión existente (`--resume`).
    resumed: bool,
    current_msg: Option<String>,
    /// Bloques ya emitidos por streaming parcial (id de mensaje → índices).
    streamed: HashMap<String, HashSet<u64>>,
    block_kind: HashMap<String, String>,
}

impl StreamParser {
    /// Devuelve `true` al recibir el mensaje `result`.
    fn handle(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, tx: &mpsc::UnboundedSender<String>, msg: Value) -> bool {
        match msg["type"].as_str() {
            Some("system") => match msg["subtype"].as_str() {
                Some("init") => {
                    if let Some(sid) = msg["session_id"].as_str() {
                        studio.set_session(run, sid);
                    }
                    if let Some(m) = msg["model"].as_str() {
                        run.state.lock().resolved_model = Some(m.to_string());
                        studio.emit(json!({ "type": "model", "runId": run.id, "model": m }));
                    }
                }
                Some("compact_boundary") => studio.item(
                    run,
                    json!({ "id": new_id(), "kind": "notice", "status": "completed", "text": "Claude Code compactó el contexto de la sesión." }),
                ),
                Some("api_retry") => studio.item(
                    run,
                    json!({ "id": new_id(), "kind": "notice", "status": "completed",
                            "text": format!("Claude Code reintenta la petición a la API (intento {}).", msg["attempt"]) }),
                ),
                _ => {}
            },
            Some("stream_event") => self.stream_event(studio, run, &msg["event"]),
            Some("assistant") => self.assistant(studio, run, &msg["message"]),
            Some("user") => self.tool_results(studio, run, &msg["message"]),
            Some("control_request") => self.control_request(studio, run, tx, &msg),
            Some("result") => {
                self.result(studio, run, &msg);
                return true;
            }
            _ => {}
        }
        false
    }

    fn stream_event(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, ev: &Value) {
        match ev["type"].as_str() {
            Some("message_start") => {
                self.current_msg = ev["message"]["id"].as_str().map(str::to_string);
            }
            Some("content_block_start") => {
                let (Some(msg), Some(idx)) = (self.current_msg.clone(), ev["index"].as_u64()) else { return };
                let block = &ev["content_block"];
                let id = format!("{msg}:{idx}");
                let kind = match block["type"].as_str() {
                    Some("text") => "text",
                    Some("thinking") | Some("redacted_thinking") => "reasoning",
                    _ => return,
                };
                self.streamed.entry(msg).or_default().insert(idx);
                self.block_kind.insert(id.clone(), kind.to_string());
                studio.item(run, json!({ "id": id, "kind": kind, "status": "running", "text": "" }));
            }
            Some("content_block_delta") => {
                let (Some(msg), Some(idx)) = (self.current_msg.clone(), ev["index"].as_u64()) else { return };
                let id = format!("{msg}:{idx}");
                let delta = &ev["delta"];
                let text = match delta["type"].as_str() {
                    Some("text_delta") => delta["text"].as_str(),
                    Some("thinking_delta") => delta["thinking"].as_str(),
                    _ => None,
                };
                if let (Some(t), Some(kind)) = (text, self.block_kind.get(&id).cloned()) {
                    studio.text_delta(run, &id, &kind, t);
                }
            }
            Some("content_block_stop") => {
                let (Some(msg), Some(idx)) = (self.current_msg.clone(), ev["index"].as_u64()) else { return };
                let id = format!("{msg}:{idx}");
                if self.block_kind.contains_key(&id) {
                    studio.item(run, json!({ "id": id, "status": "completed" }));
                }
            }
            _ => {}
        }
    }

    fn assistant(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, message: &Value) {
        let msg_id = message["id"].as_str().unwrap_or_default().to_string();
        let Some(blocks) = message["content"].as_array() else { return };
        let streamed = self.streamed.get(&msg_id).cloned().unwrap_or_default();
        for (i, b) in blocks.iter().enumerate() {
            match b["type"].as_str() {
                Some("tool_use") => {
                    if let Some(id) = b["id"].as_str() {
                        studio.item(run, normalize_tool(id, b["name"].as_str().unwrap_or("Tool"), &b["input"]));
                    }
                }
                // Sin streaming parcial (o si faltó algún evento), el texto llega aquí completo.
                Some("text") if streamed.is_empty() => {
                    studio.item(run, json!({ "id": format!("{msg_id}:t{i}"), "kind": "text", "status": "completed", "text": b["text"] }));
                }
                Some("thinking") if streamed.is_empty() => {
                    studio.item(run, json!({ "id": format!("{msg_id}:r{i}"), "kind": "reasoning", "status": "completed", "text": b["thinking"] }));
                }
                _ => {}
            }
        }
    }

    fn tool_results(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, message: &Value) {
        let Some(blocks) = message["content"].as_array() else { return };
        for b in blocks {
            if b["type"] != "tool_result" {
                continue;
            }
            let Some(id) = b["tool_use_id"].as_str() else { continue };
            let text = tool_result_text(&b["content"]);
            let is_error = b["is_error"] == true;
            let kind = run.state.lock().get(id).and_then(|v| v["kind"].as_str().map(str::to_string));
            let field = if kind.as_deref() == Some("command") { "output" } else { "result" };
            let mut upd = json!({ "id": id, "status": if is_error { "failed" } else { "completed" } });
            upd[field] = json!(text);
            studio.item(run, upd);
        }
    }

    fn control_request(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, tx: &mpsc::UnboundedSender<String>, msg: &Value) {
        let request_id = msg["request_id"].as_str().unwrap_or_default().to_string();
        let req = &msg["request"];
        if req["subtype"] != "can_use_tool" {
            let resp = json!({
                "type": "control_response",
                "response": { "subtype": "error", "request_id": request_id, "error": "Duovra no admite esta petición" }
            });
            let _ = tx.send(resp.to_string());
            return;
        }
        let tool = req["tool_name"].as_str().unwrap_or("Herramienta");
        let input = req["input"].clone();
        let tool_use_id = req["tool_use_id"].as_str().map(str::to_string);
        let preview = normalize_tool(tool_use_id.as_deref().unwrap_or("pending"), tool, &input);
        let suggestions = req.get("permission_suggestions").cloned().unwrap_or(Value::Null);
        let info = json!({
            "agent": "claude",
            "kind": preview["kind"],
            "tool": tool,
            "itemId": tool_use_id,
            "command": preview.get("command").cloned().unwrap_or(Value::Null),
            "changes": preview.get("changes").cloned().unwrap_or(Value::Null),
            "input": input,
            "reason": req.get("decision_reason").cloned().or_else(|| req.get("description").cloned()).unwrap_or(Value::Null),
            "options": if suggestions.as_array().is_some_and(|a| !a.is_empty()) { json!(["accept", "acceptForSession", "decline"]) } else { json!(["accept", "decline"]) },
        });
        studio.request_approval(
            run,
            PendingApproval::Claude { run_id: run.id.clone(), stdin: tx.clone(), request_id, input, suggestions },
            info,
        );
    }

    fn result(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, msg: &Value) {
        let u = &msg["usage"];
        let n = |k: &str| u[k].as_i64().unwrap_or(0);
        let model = run.state.lock().resolved_model.clone();
        let context_window = model
            .as_deref()
            .and_then(|m| msg["modelUsage"][m]["contextWindow"].as_i64())
            .or_else(|| {
                msg["modelUsage"].as_object().and_then(|o| o.values().find_map(|v| v["contextWindow"].as_i64()))
            });
        studio.set_usage(
            run,
            json!({
                "source": "claude",
                "inputTokens": n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
                "cachedInputTokens": n("cache_read_input_tokens"),
                "outputTokens": n("output_tokens"),
                "costUsd": turn_cost(studio, run, self.resumed, msg),
                "costKind": "estimate",
                "sessionId": msg["session_id"],
                "sessionCostUsd": msg["total_cost_usd"],
                "contextWindow": context_window,
                "durationMs": msg["duration_ms"],
                "turns": msg["num_turns"],
            }),
        );
        let ok = msg["subtype"] == "success" && msg["is_error"] != true;
        if !ok && !run.cancel_requested.load(Ordering::SeqCst) {
            let text = msg["result"]
                .as_str()
                .map(str::to_string)
                .or_else(|| msg["errors"].as_array().map(|e| e.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("Claude Code terminó con estado {}", msg["subtype"]));
            run.state.lock().error = Some(text);
        }
    }
}

/// `total_cost_usd` es el acumulado de la sesión: con `--resume` incluye los turnos anteriores
/// (comprobado con la CLI 2.1.316). El coste de este mensaje es la diferencia con el total que
/// se guardó en el mensaje anterior de la misma sesión. Si no hay referencia fiable, no se da cifra.
fn turn_cost(studio: &Arc<Studio>, run: &Arc<Run>, resumed: bool, msg: &Value) -> Value {
    let Some(total) = msg["total_cost_usd"].as_f64() else { return Value::Null };
    if !resumed {
        return json!(total);
    }
    let sid = msg["session_id"].as_str().unwrap_or_default();
    let prev = studio.db.list_messages(&run.conversation_id).ok().and_then(|list| {
        list.iter()
            .rev()
            .filter(|m| m.id != run.message_id && m.agent.as_deref() == Some("claude"))
            .find(|m| m.usage["sessionId"].as_str() == Some(sid))
            .and_then(|m| m.usage["sessionCostUsd"].as_f64())
    });
    match prev {
        Some(p) => json!((total - p).max(0.0)),
        None => Value::Null,
    }
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| match b["type"].as_str() {
                Some("text") => b["text"].as_str().map(str::to_string),
                Some("image") => Some("[imagen]".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Traduce una llamada a herramienta de Claude Code a un elemento de la cronología.
pub fn normalize_tool(id: &str, name: &str, input: &Value) -> Value {
    let base = |kind: &str| json!({ "id": id, "kind": kind, "status": "running", "tool": name, "input": input });
    match name {
        "Bash" | "PowerShell" => {
            let mut v = base("command");
            v["command"] = input["command"].clone();
            v["description"] = input["description"].clone();
            v
        }
        "Edit" => {
            let mut v = base("file_change");
            v["changes"] = json!([{ "path": input["file_path"], "kind": "update", "oldText": input["old_string"], "newText": input["new_string"] }]);
            v
        }
        "MultiEdit" => {
            let mut v = base("file_change");
            let edits = input["edits"].as_array().cloned().unwrap_or_default();
            v["changes"] = Value::Array(
                edits
                    .iter()
                    .map(|e| json!({ "path": input["file_path"], "kind": "update", "oldText": e["old_string"], "newText": e["new_string"] }))
                    .collect(),
            );
            v
        }
        "Write" => {
            let mut v = base("file_change");
            v["changes"] = json!([{ "path": input["file_path"], "kind": "write", "newText": input["content"] }]);
            v
        }
        "NotebookEdit" => {
            let mut v = base("file_change");
            v["changes"] = json!([{ "path": input["notebook_path"], "kind": "update", "newText": input["new_source"] }]);
            v
        }
        "WebSearch" => {
            let mut v = base("web_search");
            v["query"] = input["query"].clone();
            v
        }
        "WebFetch" => {
            let mut v = base("web_search");
            v["query"] = input["url"].clone();
            v
        }
        "TodoWrite" => {
            let mut v = base("plan");
            let todos = input["todos"].as_array().cloned().unwrap_or_default();
            let text = todos
                .iter()
                .map(|t| {
                    let mark = match t["status"].as_str() {
                        Some("completed") => "[x]",
                        Some("in_progress") => "[~]",
                        _ => "[ ]",
                    };
                    format!("- {mark} {}", t["content"].as_str().unwrap_or_default())
                })
                .collect::<Vec<_>>()
                .join("\n");
            v["text"] = json!(text);
            v
        }
        _ => base("tool"),
    }
}

// ---------- Consultas para ajustes ----------

/// Consulta la CLI con `initialize` (sin enviar ningún mensaje al modelo): modelos disponibles,
/// niveles de esfuerzo, versión, modo de permisos y origen de la autenticación.
pub async fn cli_info(studio: &Arc<Studio>, refresh: bool) -> Result<Value> {
    let config_dir = studio.config_dir("claude");
    let key = config_dir.clone().unwrap_or_default();
    if !refresh {
        if let Some(v) = studio.claude_info.lock().get(&key) {
            return Ok(v.clone());
        }
    }
    let exe = studio.executable("claude")?;
    let mut cmd = hidden_command(&exe);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompts", "host"]);
    if let Some(dir) = &config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().with_context(|| format!("No se pudo iniciar {}", exe.display()))?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("Sin stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("Sin stdout"))?;
    let req = json!({ "type": "control_request", "request_id": "studio-init", "request": { "subtype": "initialize" } });
    stdin.write_all(format!("{req}\n").as_bytes()).await?;
    stdin.flush().await?;

    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["type"] == "control_response" && v["response"]["request_id"] == "studio-init" {
                    return Some(v["response"]["response"].clone());
                }
            }
        }
        None
    };
    let resp = tokio::time::timeout(Duration::from_secs(40), read).await.ok().flatten();
    drop(stdin);
    let _ = child.kill().await;
    let resp = resp.ok_or_else(|| anyhow!("Claude Code no respondió a initialize"))?;
    let models: Vec<Value> = resp["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    json!({
                        "id": m["value"], "label": m["displayName"], "description": m["description"],
                        "resolved": m["resolvedModel"],
                        // Algunos modelos (p. ej. Haiku 4.5) no informan niveles: lista vacía, nunca null (AUD-001).
                        "efforts": m["supportedEffortLevels"].as_array().map(|a| a.iter().filter(|e| e.is_string()).cloned().collect::<Vec<_>>()).unwrap_or_default(),
                        "defaultEffort": Value::Null, "isDefault": m["value"] == "default",
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let info = json!({
        "source": "Claude Code CLI · initialize",
        "models": models,
        "account": resp["account"],
        "version": resp["claude_code_version"],
        "permissionMode": resp["current_permission_mode"],
    });
    studio.claude_info.lock().insert(key, info.clone());
    Ok(info)
}

/// `claude auth status` (JSON): si hay sesión iniciada y con qué método. No expone tokens.
pub async fn auth_status(studio: &Arc<Studio>) -> Result<Value> {
    let exe = studio.executable("claude")?;
    let mut cmd = hidden_command(&exe);
    cmd.args(["auth", "status"]);
    if let Some(dir) = studio.config_dir("claude") {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| anyhow!("claude auth status no respondió"))??;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.trim()).map_err(|_| anyhow!("Respuesta inesperada de claude auth status"))
}

/// Abre una consola visible con `claude auth login`: el usuario completa el inicio de sesión
/// oficial por sí mismo; la aplicación no interviene en las credenciales.
pub fn open_login_terminal(studio: &Arc<Studio>) -> Result<()> {
    let exe = studio.executable("claude")?;
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "start", "Claude Code · inicio de sesión", "cmd", "/K"]).arg(&exe).args(["auth", "login"]);
    if let Some(dir) = studio.config_dir("claude") {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.spawn().context("No se pudo abrir la consola")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_herramientas() {
        let b = normalize_tool("t1", "Bash", &json!({"command":"npm test","description":"tests"}));
        assert_eq!(b["kind"], "command");
        assert_eq!(b["command"], "npm test");
        let e = normalize_tool("t2", "Edit", &json!({"file_path":"a.ts","old_string":"x","new_string":"y"}));
        assert_eq!(e["changes"][0]["path"], "a.ts");
        let t = normalize_tool("t3", "TodoWrite", &json!({"todos":[{"content":"A","status":"completed"},{"content":"B","status":"pending"}]}));
        assert_eq!(t["text"], "- [x] A\n- [ ] B");
        assert_eq!(normalize_tool("t4", "Grep", &json!({}))["kind"], "tool");
    }

    #[test]
    fn texto_de_resultados() {
        assert_eq!(tool_result_text(&json!("ok")), "ok");
        assert_eq!(tool_result_text(&json!([{"type":"text","text":"a"},{"type":"text","text":"b"}])), "a\nb");
    }
}
