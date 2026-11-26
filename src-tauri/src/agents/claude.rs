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

use super::{Control, PendingApproval, Run, RunJob, RunState, Studio};
use super::insights::{self, ClaudeUsage};
use crate::util::{hidden_command, new_id};

const CLOSE: &str = "\u{0}__close__";

fn claude_home(config_dir: Option<&str>) -> Option<PathBuf> {
    config_dir.map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
}

/// Carpeta de sesiones de Claude Code de una cuenta (`<config>/projects`).
pub fn projects_dir(config_dir: Option<&str>) -> Option<PathBuf> {
    claude_home(config_dir).map(|h| h.join("projects"))
}

/// Identificador seguro para construir una ruta o buscar un elemento (UUID: hexadecimal y guiones).
pub fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Archivo de una sesión (`projects/<carpeta>/<sesión>.jsonl`). Solo se buscan transcripciones.
pub fn session_file(config_dir: Option<&str>, session_id: &str) -> Option<PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(projects_dir(config_dir)?).ok()?
        .flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
}

/// Comprueba si la sesión sigue en disco antes de intentar reanudarla.
pub fn session_exists(config_dir: Option<&str>, session_id: &str) -> bool {
    session_file(config_dir, session_id).is_some()
}

/// La transcripción contiene el elemento desde el que se quiere bifurcar (`--resume-session-at`).
fn session_has_entry(config_dir: Option<&str>, session_id: &str, uuid: &str) -> bool {
    if !valid_session_id(uuid) {
        return false;
    }
    let needle = format!("\"uuid\":\"{uuid}\"");
    session_file(config_dir, session_id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|text| text.contains(&needle))
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
    if run.cancel_requested.load(Ordering::SeqCst) {
        studio.finish(&run.id, "interrupted");
        return Ok(());
    }
    let exe = studio.executable("claude")?;
    let config_dir = &run.config_dir;
    let resumable = job
        .session_id
        .clone()
        .filter(|sid| session_exists(config_dir.as_deref(), sid));
    // Bifurcación nativa (1.0.11, fase 3): `--resume <origen> --fork-session [--resume-session-at <elemento>]`
    // crea una sesión nueva con el historial hasta ese punto; la de origen no se modifica. Solo si la
    // transcripción de origen sigue en disco y contiene el punto exacto.
    let fork = job.fork.clone().filter(|f| {
        session_exists(config_dir.as_deref(), &f.session_id)
            && f.anchor.as_deref().map_or(true, |a| session_has_entry(config_dir.as_deref(), &f.session_id, a))
    });
    let native = resumable.is_some() || fork.is_some();
    let plan = if native { job.resume_plan.as_ref().unwrap_or(&job.fresh_plan) } else { &job.fresh_plan };
    if job.fork.is_some() && fork.is_none() {
        let _ = studio.db.resolve_native_origin(&run.conversation_id, "claude", "rebuilt", None, Some("unavailable"));
        studio.set_context_note(&job.user_message_id, &plan.note);
        studio.item(
            &run,
            json!({ "id": "resume-notice", "kind": "notice", "status": "completed",
                    "text": "La sesión original de Claude Code no está disponible en ese punto. Duovra continúa en una sesión nueva con el contexto compartido: no es una copia exacta." }),
        );
    }
    if job.session_id.is_some() && resumable.is_none() {
        studio.set_context_note(&job.user_message_id, &plan.note);
        studio.item(
            &run,
            json!({ "id": "resume-notice", "kind": "notice", "status": "completed",
                    "text": "La sesión anterior de Claude Code ya no está disponible. Duovra reconstruye una sesión nueva con las instrucciones, la memoria y el historial compartidos: no es la sesión original y no se repite ningún mensaje." }),
        );
    }

    let permission_mode = studio.permission(run.permissions.as_ref().and_then(|p| p.mode.as_ref()), "claude.permissionMode", "manual");
    // Modo Planificar (fase 4): el modo plan nativo de la CLI, no una instrucción en el mensaje. Los
    // permisos elegidos se conservan para cuando el usuario apruebe el plan (ver `interact.rs`).
    let permission_mode = if run.plan_mode { "plan".to_owned() } else { permission_mode };
    let requested_model = run.resolved_request_model.clone().unwrap_or_else(|| run.model.clone());
    let model_arg = plan_mode_model(run.plan_mode, &requested_model,
        super::capabilities::catalog_resolution(&studio, "claude", config_dir.as_deref(), &requested_model).as_deref());
    if run.plan_mode && model_arg == "haiku" {
        studio.item(&run, json!({ "id": "plan-model-notice", "kind": "notice", "status": "completed",
            "text": "No se pudo confirmar el identificador exacto de Haiku. En modo plan, Claude Code sustituye el alias «haiku» por otro modelo: Duovra avisará si ocurre." }));
    }
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
        &model_arg,
    ]);
    if let Some(effort) = &run.effective_effort {
        cmd.args(["--effort", effort]);
    }
    if let Some(sid) = &resumable {
        cmd.args(["--resume", sid]);
    } else if let Some(f) = &fork {
        cmd.args(["--resume", &f.session_id, "--fork-session"]);
        if let Some(anchor) = &f.anchor {
            cmd.args(["--resume-session-at", anchor]);
        }
    }
    // Ajustes de esta sesión (`--settings`): no modifican ~/.claude/settings.json.
    let session_settings = session_settings(studio.setting_bool("claude.thinkingSummaries", true), run.speed.as_deref().map(|speed| speed != "default"));
    if let Some(settings) = &session_settings {
        cmd.args(["--settings", settings]);
    }
    if let Some(dir) = config_dir {
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

    // Comando del proveedor (fase 5): el texto exacto, sin el bloque de contexto delante.
    let prompt = run.raw_prompt.clone().unwrap_or_else(|| plan.prompt.clone());
    let mut content = vec![json!({ "type": "text", "text": prompt })];
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
    let submitted = {
        let _control = run.control.lock();
        if run.cancel_requested.load(Ordering::SeqCst) {
            false
        } else {
            tx.send(user.to_string()).map_err(|_| anyhow!("No se pudo escribir en Claude Code"))?;
            true
        }
    };
    if !submitted {
        let _ = tx.send(CLOSE.to_string());
        let _ = child.kill().await;
        *run.control.lock() = Control::None;
        studio.finish(&run.id, "interrupted");
        return Ok(());
    }

    studio.context_chosen(&run, native);
    studio.context_sent(&run);
    studio.update_insights(&run, json!({
        "continuity": if fork.is_some() { "forkRequested" } else if resumable.is_some() { "resumeRequested" } else { "new" },
    }));
    let reader = {
        let studio = studio.clone();
        let run = run.clone();
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut parser = StreamParser { resumed: resumable, fork: fork.map(|f| (f.session_id, f.last_seq)), config_dir: run.config_dir.clone(), ..Default::default() };
            let mut lines = BufReader::new(stdout).lines();
            let mut got_result = false;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if msg["type"] == "system" && msg["subtype"] == "init" {
                    studio.run_ready(&run, false);
                }
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
        let msg = super::provider_diagnostic(&tail, "Claude Code terminó sin devolver un resultado. Revisa la ejecución antes de reintentar.");
        studio.fail(&run.id, &msg);
    }
    Ok(())
}

/// Compactación nativa de una sesión existente (1.0.11). Comprobado con Claude Code 2.1.325: con
/// `--resume` y el mensaje `/compact` por stream-json, la CLI emite `status: compacting`, después
/// `compact_boundary` (con `pre_tokens` y `post_tokens`) y un `result` sin turnos del modelo. Solo se
/// da por completada si llega `compact_boundary` y el resultado es correcto.
pub async fn compact(studio: Arc<Studio>, conversation_id: String, session_id: String, config_dir: Option<String>, cwd: PathBuf, model: String) -> Result<()> {
    if !session_exists(config_dir.as_deref(), &session_id) {
        return Err(anyhow!("La sesión de Claude Code ya no está disponible: no hay nada que compactar."));
    }
    let exe = studio.executable("claude")?;
    let mut cmd = hidden_command(&exe);
    cmd.args([
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        // La compactación no ejecuta herramientas. No se usa el modo plan: con `"model": "opusplan"` en
        // la configuración del usuario, Claude Code cambia de modelo en ese modo (comprobado con 2.1.325).
        "--permission-mode", "manual", "--model", &model, "--resume", &session_id,
    ]);
    if let Some(dir) = &config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().with_context(|| format!("No se pudo iniciar {}", exe.display()))?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("Sin stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("Sin stdout"))?;
    let line = json!({
        "type": "user", "session_id": "",
        "message": { "role": "user", "content": [{ "type": "text", "text": "/compact" }] },
        "parent_tool_use_id": null
    });
    stdin.write_all(format!("{line}\n").as_bytes()).await?;
    stdin.flush().await?;
    studio.compaction_progress(&conversation_id, "claude", "accepted");
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut boundary: Option<Value> = None;
        let mut outcome: Option<(bool, Option<String>)> = None;
        let read = async {
            while let Ok(Some(l)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&l) else { continue };
                match (msg["type"].as_str(), msg["subtype"].as_str()) {
                    (Some("system"), Some("status")) if msg["status"] == "compacting" => {
                        studio.compaction_progress(&conversation_id, "claude", "running");
                    }
                    (Some("system"), Some("compact_boundary")) => boundary = Some(msg["compact_metadata"].clone()),
                    (Some("result"), _) => {
                        let ok = msg["subtype"] == "success" && msg["is_error"] != true;
                        let text = msg["result"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_owned);
                        outcome = Some((ok, text));
                        break;
                    }
                    _ => {}
                }
            }
        };
        let timed_out = tokio::time::timeout(Duration::from_secs(600), read).await.is_err();
        drop(stdin);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        let _ = child.kill().await;
        let meta = boundary.clone().unwrap_or(Value::Null);
        let detail = json!({
            "preTokens": insights::number(&meta["pre_tokens"]), "postTokens": insights::number(&meta["post_tokens"]),
            "trigger": meta["trigger"].as_str().unwrap_or("manual"),
        });
        let (state, error) = match (timed_out, outcome, boundary.is_some()) {
            (true, ..) => ("unknown", Some("Claude Code no confirmó el final de la compactación.".to_owned())),
            (false, Some((true, _)), true) => ("completed", None),
            (false, Some((_, text)), _) => ("failed", Some(super::provider_diagnostic(text.as_deref().unwrap_or_default(),
                "Claude Code no compactó la sesión."))),
            (false, None, _) => ("failed", Some("Claude Code terminó sin devolver un resultado.".to_owned())),
        };
        studio.compaction_finished(&conversation_id, "claude", &session_id, state, error, detail);
    });
    Ok(())
}

/// Uso restante de la suscripción según el evento oficial `rate_limit_event` de stream-json.
/// Duovra no consulta nada aparte: guarda la última instantánea que la CLI entrega con cada turno,
/// por cuenta, con la hora de recepción, para mostrarla en Ajustes → Cuentas y uso.
pub(super) fn rate_limit_snapshot(info: &Value, account_id: Option<&str>, account_label: Option<&str>, now: i64) -> Option<Value> {
    let mut windows = serde_json::Map::new();
    if let Some(unified) = info["unifiedWindows"].as_object() {
        for (key, window) in unified {
            let Some(used) = window["utilization"].as_f64() else { continue };
            windows.insert(key.clone(), json!({
                "usedPercent": (used * 1000.0).round() / 10.0,
                "resetsAt": window["resetsAt"], "status": window["status"],
            }));
        }
    } else if let (Some(kind), Some(used)) = (info["rateLimitType"].as_str(), info["utilization"].as_f64()) {
        windows.insert(kind.to_owned(), json!({ "usedPercent": (used * 1000.0).round() / 10.0, "resetsAt": info["resetsAt"], "status": info["status"] }));
    }
    if windows.is_empty() && info["status"].is_null() { return None; }
    Some(json!({
        "accountId": account_id, "accountLabel": account_label, "receivedAt": now,
        "status": info["status"], "windows": windows,
    }))
}

fn record_rate_limits(studio: &Arc<Studio>, run: &Arc<Run>, info: &Value) {
    let label = run.account_id.as_ref().and_then(|id| studio.db.list_accounts().ok()?.into_iter().find(|a| &a.id == id).map(|a| a.label));
    let Some(snapshot) = rate_limit_snapshot(info, run.account_id.as_deref(), label.as_deref(), crate::util::now_ms()) else { return };
    let key = run.account_id.clone().unwrap_or_else(|| "default".into());
    let mut all = studio.db.get_setting("quota.claude").filter(Value::is_object).unwrap_or_else(|| json!({}));
    all[key] = snapshot;
    if studio.db.set_setting("quota.claude", &all).is_ok() {
        studio.emit(json!({ "type": "rateLimits", "agent": "claude", "data": all }));
    }
}

/// Ajustes oficiales que Duovra aplica solo a la sesión que lanza:
/// - `showThinkingSummaries`: pide a la API los resúmenes de pensamiento que Claude Code muestra.
/// - `fastMode`: el modo rápido elegido en el compositor, solo si el modelo lo admite.
fn session_settings(thinking_summaries: bool, fast: Option<bool>) -> Option<String> {
    let mut settings = serde_json::Map::new();
    if thinking_summaries {
        settings.insert("showThinkingSummaries".into(), json!(true));
    }
    if let Some(fast) = fast {
        settings.insert("fastMode".into(), json!(fast));
    }
    (!settings.is_empty()).then(|| Value::Object(settings).to_string())
}

/// Convierte los mensajes `stream-json` de Claude Code en la cronología normalizada.
#[derive(Default)]
struct StreamParser {
    /// Modelo que atendió la última petición (puede diferir del de la sesión, p. ej. con `opusplan` en modo plan).
    last_request_model: Option<String>,
    /// El proceso reanudó una sesión existente (`--resume`).
    resumed: Option<String>,
    /// Bifurcación nativa pedida (`--fork-session`): sesión de origen y último mensaje que contiene.
    fork: Option<(String, i64)>,
    /// Último elemento de la transcripción (`uuid`) de este turno: punto exacto para bifurcar después.
    last_entry: Option<String>,
    usage: ClaudeUsage,
    context_tokens: Option<i64>,
    tasks: Vec<Value>,
    background_tasks: Vec<Value>,
    task_results: HashSet<String>,
    worker_keys: HashMap<String, Vec<String>>,
    tool_workers: HashMap<String, String>,
    worker_tools: HashMap<String, std::collections::BTreeSet<String>>,
    current_msg: Option<String>,
    /// Bloques ya emitidos por streaming parcial (id de mensaje → índices).
    streamed: HashMap<String, HashSet<u64>>,
    block_kind: HashMap<String, String>,
    /// Carpeta de configuración de la cuenta (para leer un plan que la CLI guardó en su archivo).
    config_dir: Option<String>,
    /// Ya se avisó de que la CLI atendió una petición con otro modelo.
    model_change_noticed: bool,
}

/// Modelo que se pasa a `--model`. Comprobado en Claude Code 2.1.325: en modo plan la CLI sustituye
/// el ajuste de modelo cuando es el alias `haiku` (pasa a Sonnet) u `opusplan` (pasa a Opus), y
/// `--model` cuenta como ese ajuste. Con el identificador exacto no hay sustitución. `opusplan` se
/// respeta porque el usuario lo eligió precisamente por ese comportamiento.
fn plan_mode_model(plan: bool, requested: &str, exact: Option<&str>) -> String {
    match exact {
        Some(exact) if plan && !requested.starts_with("opusplan") => exact.to_owned(),
        _ => requested.to_owned(),
    }
}

/// Dos identificadores del mismo modelo (`claude-haiku-5-5` y su versión con fecha) no son un cambio.
fn same_model(a: &str, b: &str) -> bool {
    a == b || a.starts_with(b) || b.starts_with(a)
}

impl StreamParser {
    /// Devuelve `true` al recibir el mensaje `result`.
    fn handle(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, tx: &mpsc::UnboundedSender<String>, msg: Value) -> bool {
        if msg["isReplay"] == true { return false; }
        if let Some(parent) = msg["parent_tool_use_id"].as_str() {
            if msg["type"] == "assistant" {
                self.child_tools(studio, run, parent, &msg["message"]);
            }
            if matches!(msg["type"].as_str(), Some("assistant" | "stream_event" | "user")) {
                return false;
            }
        }
        if matches!(msg["type"].as_str(), Some("assistant" | "user")) {
            if let Some(uuid) = msg["uuid"].as_str() {
                self.last_entry = Some(uuid.to_owned());
            }
        }
        match msg["type"].as_str() {
            Some("system") => match msg["subtype"].as_str() {
                Some("init") => {
                    studio.update_insights(run, json!({ "contextSent": true }));
                    if let Some(sid) = msg["session_id"].as_str() {
                        let continuity = match &self.fork {
                            // La sesión bifurcada contiene lo confirmado hasta el corte: se registra antes que la sesión.
                            Some((source, seq)) if source != sid => {
                                let _ = studio.db.upsert_provider_session(&run.conversation_id, "claude", sid, *seq, run.account_id.as_deref());
                                let _ = studio.db.resolve_native_origin(&run.conversation_id, "claude", "native", Some(sid), None);
                                "forked"
                            }
                            Some(_) => "resumed",
                            None if self.resumed.as_deref() == Some(sid) => "resumed",
                            None => "new",
                        };
                        studio.set_session(run, sid);
                        studio.update_insights(run, json!({ "continuity": continuity }));
                    }
                    if let Some(m) = msg["model"].as_str() {
                        run.state.lock().resolved_model = Some(m.to_string());
                        studio.update_insights(run, json!({ "sessionModel": m }));
                        studio.emit(json!({ "type": "model", "runId": run.id, "model": m }));
                    }
                }
                Some("compact_boundary") => {
                    self.context_tokens = None;
                    let meta = &msg["compact_metadata"];
                    studio.native_compacted(run, json!({
                        "trigger": meta["trigger"].as_str().unwrap_or("auto"),
                        "preTokens": insights::number(&meta["pre_tokens"]), "postTokens": insights::number(&meta["post_tokens"]),
                    }));
                    studio.update_insights(run, json!({ "compacted": true, "lastInputTokens": null }));
                    studio.item(run, json!({ "id": new_id(), "kind": "notice", "status": "completed", "text": "Claude Code compactó el contexto de la sesión." }));
                }
                Some("task_started" | "task_updated" | "task_notification" | "task_progress") => {
                    self.worker_event(studio, run, &msg);
                }
                Some("api_retry") => studio.item(
                    run,
                    json!({ "id": new_id(), "kind": "notice", "status": "completed",
                            "text": format!("Claude Code reintenta la petición a la API (intento {}).", msg["attempt"]) }),
                ),
                _ => {}
            },
            Some("stream_event") => self.stream_event(studio, run, &msg["event"]),
            Some("assistant") => self.assistant(studio, run, &msg["message"]),
            Some("user") => self.tool_results(studio, run, &msg),
            Some("control_request") => self.control_request(studio, run, tx, &msg),
            Some("rate_limit_event") => record_rate_limits(studio, run, &msg["rate_limit_info"]),
            Some("result") => {
                if msg["origin"]["kind"] == "task-notification" { return false; }
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
                // El modelo ya está respondiendo a la petición: el contexto enviado se recibió.
                studio.context_confirmed(run);
                self.current_msg = ev["message"]["id"].as_str().map(str::to_string);
            }
            Some("content_block_start") => {
                let (Some(msg), Some(idx)) = (self.current_msg.clone(), ev["index"].as_u64()) else { return };
                let block = &ev["content_block"];
                let id = format!("{msg}:{idx}");
                let kind = match block["type"].as_str() {
                    Some("text") => "text",
                    // `redacted_thinking` no contiene texto legible: no genera una entrada.
                    Some("thinking") => "reasoning",
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
        studio.context_confirmed(run);
        let msg_id = message["id"].as_str().unwrap_or_default().to_string();
        let session = run.state.lock().session_id.clone();
        let new_usage = !msg_id.is_empty() && message["usage"].is_object() &&
            session.as_deref().is_some_and(|sid| studio.db.claim_claude_request(&run.message_id, sid, &msg_id).unwrap_or(false));
        if new_usage && self.usage.request(&msg_id, &message["usage"]) {
            self.context_tokens = ClaudeUsage::context_tokens(&message["usage"]);
            let mut usage = self.usage.metrics(None);
            usage["contextTokens"] = json!(self.context_tokens);
            studio.set_usage(run, usage);
            self.last_request_model = message["model"].as_str().map(str::to_owned).or(self.last_request_model.take());
            studio.update_insights(run, json!({ "lastInputTokens": self.context_tokens, "lastRequestModel": message["model"] }));
            self.check_model(studio, run, message["model"].as_str());
        }
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

    /// Comunica cuando la CLI atiende una petición con un modelo distinto del de la sesión (por ejemplo,
    /// `opusplan` o `haiku` en modo plan, o un modelo de respaldo). Nunca se oculta ni se corrige solo.
    fn check_model(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, used: Option<&str>) {
        // `<synthetic>`: mensajes que la propia CLI genera sin llamar a la API (errores locales).
        let Some(used) = used.filter(|m| !m.starts_with('<')) else { return };
        let expected = run.state.lock().resolved_model.clone();
        let Some(expected) = expected else { return };
        if same_model(used, &expected) || self.model_change_noticed { return; }
        self.model_change_noticed = true;
        studio.update_insights(run, json!({ "modelChanged": { "expected": expected, "used": used } }));
        studio.item(run, json!({ "id": "model-change-notice", "kind": "notice", "status": "completed",
            "text": format!("Claude Code atendió este turno con {used} en lugar de {expected}.") }));
    }

    fn tool_results(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, message: &Value) {
        let Some(blocks) = message["message"]["content"].as_array() else { return };
        let single_result = blocks.iter().filter(|b| b["type"] == "tool_result").count() == 1;
        for b in blocks {
            let update = normalize_tool_result(&run.state.lock(), b);
            if let Some(update) = update {
                let structured = if single_result { &message["tool_use_result"] } else { &Value::Null };
                self.project_tool_result(studio, run, b, structured, &update);
                studio.item(run, update);
            }
        }
    }

    fn project_tool_result(&mut self, studio: &Studio, run: &Run, block: &Value, result: &Value, update: &Value) {
        let Some(id) = block["tool_use_id"].as_str() else { return };
        let Some(tool) = run.state.lock().get(id).cloned() else { return };
        if update["status"] != "completed" || !self.task_results.insert(id.to_owned()) { return; }
        let input = &tool["input"];
        let text = update["result"].as_str().unwrap_or_default();
        match tool["tool"].as_str() {
            Some("TodoWrite") => {
                if let Some(tasks) = insights::plan_steps(&input["todos"], "content") {
                    studio.record_plan(run, "Claude Code · TodoWrite", tasks, &Value::Null);
                }
            }
            Some(name @ ("TaskCreate" | "TaskUpdate")) => {
                if project_claude_task(&mut self.tasks, name, input, result, text) {
                    studio.record_plan(run, "Claude Code · Task tools", self.tasks.clone(), &Value::Null);
                }
            }
            Some("Agent" | "Task") => {
                // Un resultado de lanzamiento confirma una delegación, pero solo el
                // estado de la tarea o el resultado síncrono confirma su finalización.
                let agent_id = result["agentId"].as_str().or_else(|| text.lines().find_map(|line| {
                    let id = line.trim().strip_prefix("agentId:")?.split_whitespace().next()?;
                    id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).then_some(id)
                }));
                let existing = self.tool_workers.get(id).cloned();
                let Some(key) = existing.clone().or_else(|| agent_id.map(|agent| format!("agent:{agent}"))) else { return };
                self.tool_workers.insert(id.to_owned(), key.clone());
                let mut patch = json!({
                    "itemId": id, "description": input["description"], "role": input["subagent_type"],
                });
                if let Some(agent_id) = agent_id { patch["agentId"] = json!(agent_id); }
                if existing.is_none() { patch["id"] = json!(agent_id); }
                if result["status"] == "completed" {
                    patch["status"] = json!("completed");
                    patch["result"] = json!(text);
                    patch["totalTokens"] = result["totalTokens"].clone();
                    patch["durationMs"] = result["totalDurationMs"].clone();
                } else if existing.is_none() && result["status"] == "async_launched" {
                    patch["status"] = json!("running");
                }
                self.patch_worker(studio, run, &key, patch);
            }
            _ => {}
        }
    }

    fn patch_worker(&self, studio: &Studio, run: &Run, key: &str, mut patch: Value) {
        if let Some(fields) = patch.as_object_mut() { fields.retain(|_, v| !v.is_null()); }
        studio.update_insights(run, json!({ "subagents": { (key): patch } }));
    }

    fn child_tools(&mut self, studio: &Studio, run: &Run, parent: &str, message: &Value) {
        let Some(blocks) = message["content"].as_array() else { return };
        let tools = self.worker_tools.entry(parent.to_owned()).or_default();
        let mut changed = false;
        for name in blocks.iter().filter(|b| b["type"] == "tool_use").filter_map(|b| b["name"].as_str()) {
            changed |= tools.insert(name.to_owned());
        }
        if changed {
            if let Some(key) = self.tool_workers.get(parent) {
                let patch = json!({ "tools": tools });
                self.patch_worker(studio, run, key, patch);
            }
        }
    }

    fn worker_event(&mut self, studio: &Studio, run: &Run, event: &Value) {
        if event["ambient"] == true { return; }
        let Some(id) = event["task_id"].as_str().filter(|s| !s.is_empty()) else { return };
        let call = event["tool_use_id"].as_str();
        let tool = call.and_then(|id| run.state.lock().get(id).cloned()).unwrap_or_default();
        let start = event["subtype"] == "task_started";
        let mut key = match event["run_id"].as_str() {
            Some(native) => format!("task:{id}:{native}"),
            None => format!("task:{id}"),
        };
        if event["run_id"].is_null() {
            if let Some(known) = self.worker_keys.get(id) {
                if known.len() != 1 { return; }
                key = known[0].clone();
            }
        }
        let is_worker = matches!(event["task_type"].as_str(), Some("local_agent" | "remote_agent"))
            || matches!(tool["tool"].as_str(), Some("Agent" | "Task"))
            || self.worker_keys.get(id).is_some_and(|keys| keys.contains(&key));
        let payload = if event["subtype"] == "task_updated" { &event["patch"] } else { event };
        let status = insights::status(&payload["status"]).or_else(|| start.then_some("running"));
        if !is_worker {
            if start && event["task_type"] == "local_bash" && !self.background_tasks.iter().any(|t| t["id"] == id) {
                self.background_tasks.push(json!({ "id": id, "title": event["description"], "status": "running" }));
            }
            if let Some(task) = self.background_tasks.iter_mut().find(|t| t["id"] == id) {
                if let Some(status) = status { task["status"] = json!(status); }
                if let Some(summary) = event["summary"].as_str() { task["description"] = json!(summary); }
                studio.record_plan(run, "Claude Code · Tareas en segundo plano", self.background_tasks.clone(), &Value::Null);
            }
            return;
        }
        // Si el resultado del lanzamiento llegó primero, conservar su identidad y
        // asociar el ID nativo al mismo registro mediante el tool_use_id observado.
        if let Some(call) = call {
            if let Some(existing) = self.tool_workers.get(call).filter(|k| k.starts_with("agent:")) {
                key = existing.clone();
            }
            self.tool_workers.insert(call.to_owned(), key.clone());
        }
        let keys = self.worker_keys.entry(id.to_owned()).or_default();
        if !keys.contains(&key) { keys.push(key.clone()); }
        let description = payload["description"].as_str().or_else(|| tool["input"]["description"].as_str());
        let role = event["subagent_type"].as_str().or_else(|| tool["input"]["subagent_type"].as_str());
        let mut patch = json!({
            "id": id, "runId": event["run_id"], "itemId": call, "description": description,
            "role": role, "parentId": event["parent_task_id"], "status": status,
            "lastTool": event["last_tool_name"], "totalTokens": event["usage"]["total_tokens"],
            "toolCalls": event["usage"]["tool_uses"], "durationMs": event["usage"]["duration_ms"],
            "endedAt": payload["end_time"],
        });
        if let Some(tools) = call.and_then(|id| self.worker_tools.get(id)) { patch["tools"] = json!(tools); }
        if event["subtype"] == "task_progress" { patch["progress"] = event["summary"].clone(); }
        if event["subtype"] == "task_notification" { patch["result"] = event["summary"].clone(); }
        if let Some(error) = payload["error"].as_str() { patch["result"] = json!(error); }
        self.patch_worker(studio, run, &key, patch);
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
        // Planes y preguntas (fase 4): tarjetas propias, no una aprobación de herramienta.
        // Claude Code 2.1.325 no repite `plan` en `can_use_tool` (llega `input: {}`): el plan está en el bloque
        // `tool_use` del asistente, que la CLI emite antes de la solicitud (comprobado con una API simulada).
        let announced = tool_use_id.as_deref().and_then(|id| run.state.lock().get(id).map(|item| item["input"].clone())).unwrap_or(Value::Null);
        let plan_input = if input["plan"].as_str().is_some_and(|p| !p.trim().is_empty()) { input.clone() } else {
            let mut merged = announced.clone();
            if !merged.is_object() { merged = json!({}); }
            if let Some(file) = input["planFilePath"].as_str() { merged["planFilePath"] = json!(file); }
            merged
        };
        let interaction = match tool {
            "ExitPlanMode" => plan_text(&plan_input, self.config_dir.as_deref())
                .map(|(plan, file)| ("plan", super::interact::plan_payload(&plan, "ExitPlanMode", file.as_deref()))),
            "AskUserQuestion" => super::interact::claude_questions(&input).map(|payload| ("question", payload)),
            _ => None,
        };
        if let Some((kind, payload)) = interaction {
            let native = super::interact::Native::Claude { stdin: tx.clone(), request_id: request_id.clone(), input: input.clone() };
            if studio.open_interaction(run, kind, tool_use_id.as_deref(), payload, Some(native)).is_none() {
                let response = json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": request_id,
                        "response": { "behavior": "deny", "message": "La ejecución ya está cerrada o cancelándose." } }
                });
                let _ = tx.send(response.to_string());
            }
            return;
        }
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
            // En modo plan la CLI pide aprobación para lo que no es de solo lectura: no es un sandbox estricto.
            "planMode": run.plan_mode,
        });
        if !studio.request_approval(
            run,
            PendingApproval::Claude {
                run_id: run.id.clone(), stdin: tx.clone(), request_id: request_id.clone(), tool_use_id, input, suggestions,
            },
            info,
        ) {
            let response = json!({
                "type": "control_response",
                "response": {
                    "subtype": "success", "request_id": request_id,
                    "response": { "behavior": "deny", "message": "La ejecución ya está cerrada o cancelándose." }
                }
            });
            let _ = tx.send(response.to_string());
        }
    }

    fn result(&mut self, studio: &Arc<Studio>, run: &Arc<Run>, msg: &Value) {
        if let Some(entry) = &self.last_entry {
            studio.update_insights(run, json!({ "nativeAnchor": entry }));
        }
        let session = msg["session_id"].as_str();
        if let Some(session) = session {
            studio.set_session(run, session);
        }
        let identified = session.zip(msg["uuid"].as_str()).is_some_and(|(session, id)| studio.provider_identity(run, session, id));
        // La ventana corresponde al modelo que atendió la última petición (la ocupación sale de ella).
        let model = self.last_request_model.clone().or_else(|| run.state.lock().resolved_model.clone());
        let matching_model = model.as_deref().map_or(&Value::Null, |m| &msg["modelUsage"][m]);
        if identified {
            let previous = studio.db.previous_metrics(&run.message_id, "claude").ok().flatten();
            let mut usage = self.usage.metrics(Some(msg));
            usage["costUsd"] = json!(insights::claude_cost(msg, self.resumed.as_deref(), previous.as_ref()));
            usage["costKind"] = json!("estimate");
            usage["sessionId"] = msg["session_id"].clone();
            usage["sessionCostUsd"] = msg["total_cost_usd"].clone();
            usage["contextTokens"] = json!(self.context_tokens);
            usage["contextWindow"] = json!(insights::number(&matching_model["contextWindow"]).filter(|n| *n > 0));
            usage["maxOutputTokens"] = json!(insights::number(&matching_model["maxOutputTokens"]).filter(|n| *n > 0));
            usage["durationMs"] = msg["duration_ms"].clone();
            usage["turns"] = msg["num_turns"].clone();
            studio.set_usage(run, usage);
        }
        // Claude Code informa el estado efectivo del modo rápido (`on`, `cooldown`, `off`).
        if run.speed.as_deref().is_some_and(|speed| speed != "default") {
            if let Some(state) = msg["fast_mode_state"].as_str().filter(|state| *state != "on") {
                let text = if state == "cooldown" {
                    "Claude Code no aplicó el modo rápido: está en pausa temporal por límite de uso."
                } else {
                    "Claude Code no aplicó el modo rápido en este turno."
                };
                studio.item(run, json!({ "id": "fast-mode-notice", "kind": "notice", "status": "completed", "text": text }));
            }
        }
        let ok = msg["subtype"] == "success" && msg["is_error"] != true;
        // Un comando local de la CLI responde solo con `result` (sin mensaje del modelo).
        if ok && run.raw_prompt.is_some() {
            let has_text = run.state.lock().items.iter().any(|i| i["kind"] == "text" && i["text"].as_str().is_some_and(|t| !t.trim().is_empty()));
            if let Some(text) = msg["result"].as_str().filter(|t| !t.trim().is_empty() && !has_text) {
                studio.item(run, json!({ "id": "command-output", "kind": "text", "status": "completed", "text": text }));
            }
        }
        if ok && insights::number(&msg["num_turns"]).is_some_and(|n| n > 0) {
            studio.context_confirmed(run);
        }
        if !ok && !run.cancel_requested.load(Ordering::SeqCst) {
            let text = msg["result"]
                .as_str()
                .map(str::to_string)
                .or_else(|| msg["errors"].as_array().map(|e| e.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n")))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_default();
            run.state.lock().error = Some(super::provider_diagnostic(&text, "Claude Code no pudo completar el turno. Revisa la ejecución antes de reintentar."));
        }
    }
}

fn task_id(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned).or_else(|| value.as_u64().map(|n| n.to_string()))
}

fn project_claude_task(tasks: &mut Vec<Value>, tool: &str, input: &Value, result: &Value, text: &str) -> bool {
    let create = tool == "TaskCreate";
    let id = if create {
        task_id(&result["task"]["id"]).or_else(|| {
            let (id, _) = text.strip_prefix("Task #")?.split_once(" created successfully")?;
            (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_owned())
        })
    } else {
        task_id(&input["taskId"]).filter(|id| {
            let textual = text.strip_prefix("Updated task #").is_some_and(|s| s.split_whitespace().next() == Some(id));
            result["success"] == true || textual
        })
    };
    let Some(id) = id else { return false };
    let index = tasks.iter().position(|task| task["id"] == id).unwrap_or_else(|| {
        tasks.push(json!({ "id": id }));
        tasks.len() - 1
    });
    let task = &mut tasks[index];
    for (dest, field) in [("title", "subject"), ("description", "description"), ("activeForm", "activeForm")] {
        if let Some(s) = input[field].as_str().or_else(|| result["task"][field].as_str()) {
            task[dest] = json!(s);
        }
    }
    let status = insights::status(&result["task"]["status"]).or_else(|| insights::status(&input["status"]));
    if create {
        task["status"] = json!(status.unwrap_or("pending"));
    } else if input["status"] == "deleted" {
        task["status"] = json!("removed");
    } else if let Some(status) = status {
        task["status"] = json!(status);
    }
    for (dest, field) in [("blockedBy", "addBlockedBy"), ("blocks", "addBlocks")] {
        if let Some(values) = input[field].as_array() {
            let mut known = task[dest].as_array().cloned().unwrap_or_default();
            for value in values.iter().filter_map(task_id).map(Value::String) {
                if !known.contains(&value) { known.push(value); }
            }
            task[dest] = json!(known);
        }
    }
    true
}

/// Texto del plan de `ExitPlanMode`: el campo `plan` o, si la CLI lo dejó en su archivo de plan, ese
/// archivo (solo dentro de `<config>/plans`). Sin ninguno de los dos no hay plan que mostrar.
fn plan_text(input: &Value, config_dir: Option<&str>) -> Option<(String, Option<String>)> {
    let file = input["planFilePath"].as_str().filter(|p| !p.is_empty()).map(str::to_owned);
    if let Some(plan) = input["plan"].as_str().filter(|p| !p.trim().is_empty()) {
        return Some((plan.to_owned(), file));
    }
    let path = PathBuf::from(file.as_deref()?);
    let plans = claude_home(config_dir)?.join("plans").canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    if !real.starts_with(&plans) || std::fs::metadata(&real).ok()?.len() > 512 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(&real).ok()?;
    (!text.trim().is_empty()).then_some((text, file))
}

fn normalize_tool_result(state: &RunState, block: &Value) -> Option<Value> {
    if block["type"] != "tool_result" {
        return None;
    }
    let id = block["tool_use_id"].as_str()?;
    // Claude devuelve también is_error para una acción rechazada desde el canal de permisos.
    let status = if state.declined_claude_tools.contains(id) {
        "declined"
    } else if block["is_error"] == true {
        "failed"
    } else {
        "completed"
    };
    let field = if state.get(id).is_some_and(|item| item["kind"] == "command") { "output" } else { "result" };
    let mut update = json!({ "id": id, "status": status });
    update[field] = json!(tool_result_text(&block["content"]));
    Some(update)
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
        // Plan propuesto con `ExitPlanMode` (fase 4). La tarjeta se asocia por el id de la llamada.
        "ExitPlanMode" => {
            let mut v = base("plan_proposal");
            v["text"] = input["plan"].clone();
            v
        }
        "AskUserQuestion" => {
            let mut v = base("question");
            v["questions"] = super::interact::claude_questions(input).map(|p| p["questions"].clone()).unwrap_or(Value::Null);
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
/// niveles de esfuerzo, versión, modo de permisos, comandos y capacidades que comunica la CLI.
/// La caché vive en el registro de capacidades (`capabilities.rs`), no aquí.
pub async fn cli_info_for(studio: &Arc<Studio>, config_dir: Option<&str>) -> Result<Value> {
    let exe = studio.executable("claude")?;
    let mut cmd = hidden_command(&exe);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompts", "host"]);
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
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
    Ok(parse_init(&resp))
}

/// Normaliza la respuesta de `initialize`. Solo copia campos presentes: nada se deduce del nombre.
pub(super) fn parse_init(resp: &Value) -> Value {
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
                        // Modo rápido oficial (`fastMode`), solo en los modelos que lo declaran.
                        "fast": if m["supportsFastMode"] == true { json!({ "id": "fast", "label": "Rápido" }) } else { Value::Null },
                        // `value` puede ser un alias (`opus`, `default`): el exacto es `resolvedModel`.
                        "exact": m["resolvedModel"],
                        "alias": m["resolvedModel"].as_str().is_some_and(|r| Some(r) != m["value"].as_str()),
                        "traits": {
                            "effort": m["supportsEffort"], "adaptiveThinking": m["supportsAdaptiveThinking"],
                            "autoMode": m["supportsAutoMode"], "thinkingOff": m["supportsThinkingOff"],
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let commands: Vec<Value> = resp["commands"].as_array().map(|list| list.iter().filter(|c| c["name"].is_string()).map(|c| json!({
        "name": c["name"], "description": c["description"], "argumentHint": c["argumentHint"],
        "aliases": c["aliases"], "builtin": c["builtin"] == true,
    })).collect()).unwrap_or_default();
    json!({
        "source": "Claude Code CLI · initialize",
        "models": models,
        "account": resp["account"],
        "version": resp["claude_code_version"],
        "permissionMode": resp["current_permission_mode"],
        "extras": {
            "commands": commands,
            "agents": resp["agents"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).map(str::to_owned).collect::<Vec<_>>()),
            "fastModeState": resp["fast_mode_state"], "fastModeDisabledReason": resp["fast_mode_disabled_reason"],
            "cliCapabilities": resp["capabilities"], "sessionState": resp["session_state"],
        },
    })
}

/// `claude auth status` (JSON): si hay sesión iniciada y con qué método. No expone tokens.
pub async fn auth_status(studio: &Arc<Studio>) -> Result<Value> {
    auth_status_for(studio, studio.config_dir("claude").as_deref()).await
}

pub async fn auth_status_for(studio: &Arc<Studio>, config_dir: Option<&str>) -> Result<Value> {
    let exe = studio.executable("claude")?;
    let mut cmd = hidden_command(&exe);
    cmd.args(["auth", "status"]);
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
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
    fn instantanea_de_cuota_desde_rate_limit_event() {
        let info = json!({"status":"allowed","resetsAt":1795202400,"rateLimitType":"five_hour",
            "unifiedWindows":{"five_hour":{"utilization":0.54,"resetsAt":1795202400,"status":"allowed"},
                              "seven_day":{"utilization":0.7449,"resetsAt":1795356000,"status":"allowed"}}});
        let snap = rate_limit_snapshot(&info, None, None, 5).unwrap();
        assert_eq!(snap["windows"]["five_hour"]["usedPercent"], 54.0);
        assert_eq!(snap["windows"]["seven_day"]["usedPercent"], 74.5);
        assert_eq!(snap["windows"]["seven_day"]["resetsAt"], 1795356000);
        assert_eq!(snap["receivedAt"], 5);
        let legacy = json!({"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.9,"resetsAt":7});
        assert_eq!(rate_limit_snapshot(&legacy, Some("a"), Some("Trabajo"), 1).unwrap()["windows"]["seven_day"]["usedPercent"], 90.0);
        assert!(rate_limit_snapshot(&json!({}), None, None, 1).is_none());
    }

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
    fn modelo_exacto_en_modo_plan() {
        assert_eq!(plan_mode_model(true, "haiku", Some("claude-haiku-5-5")), "claude-haiku-5-5");
        assert_eq!(plan_mode_model(false, "haiku", Some("claude-haiku-5-5")), "haiku");
        assert_eq!(plan_mode_model(true, "haiku", None), "haiku");
        assert_eq!(plan_mode_model(true, "opusplan", Some("claude-opus-5-5")), "opusplan");
        assert!(same_model("claude-haiku-5-5-20261001", "claude-haiku-5-5"));
        assert!(!same_model("claude-sonnet-5-5", "claude-haiku-5-5"));
    }

    #[test]
    fn plan_y_preguntas_en_la_cronologia() {
        let p = normalize_tool("t1", "ExitPlanMode", &json!({ "plan": "# Plan\n1. A" }));
        assert_eq!((p["kind"].as_str(), p["text"].as_str()), (Some("plan_proposal"), Some("# Plan\n1. A")));
        let q = normalize_tool("t2", "AskUserQuestion", &json!({ "questions": [{ "question": "¿A o B?", "header": "X", "multiSelect": false,
            "options": [{ "label": "A", "description": "a" }, { "label": "B", "description": "b" }] }] }));
        assert_eq!(q["kind"], "question");
        assert_eq!(q["questions"][0]["options"][1]["label"], "B");
        assert_eq!(plan_text(&json!({ "plan": "Hacer X" }), None).unwrap().0, "Hacer X");
        assert!(plan_text(&json!({ "planFilePath": "C:/Windows/win.ini" }), None).is_none());
    }

    #[test]
    fn texto_de_resultados() {
        assert_eq!(tool_result_text(&json!("ok")), "ok");
        assert_eq!(tool_result_text(&json!([{"type":"text","text":"a"},{"type":"text","text":"b"}])), "a\nb");
    }

    #[test]
    fn distingue_un_comando_rechazado_de_un_error() {
        let mut state = RunState::default();
        state.upsert(normalize_tool("t1", "Bash", &json!({"command":"node --version"})));
        let block = json!({"type":"tool_result","tool_use_id":"t1","content":"rechazado","is_error":true});
        assert_eq!(normalize_tool_result(&state, &block).unwrap()["status"], "failed");

        state.declined_claude_tools.insert("t1".into());
        let update = normalize_tool_result(&state, &block).unwrap();
        assert_eq!(update["status"], "declined");
        assert_eq!(update["output"], "rechazado");
    }
}
