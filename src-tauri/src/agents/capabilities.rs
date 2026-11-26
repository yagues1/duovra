//! Registro de capacidades de los agentes (1.0.11, fase 1).
//!
//! Un único punto que responde «qué admite esta instalación de Claude Code o Codex con esta
//! cuenta y este modelo». Reúne lo que ya consultaba Duovra (catálogos, `initialize`,
//! `account/read`, sondeo de `turn/steer`) y lo clasifica sin inventar:
//!
//! - **Fuente**: cada capacidad indica de dónde sale (respuesta de la CLI, lista de métodos del
//!   servidor, esquema generado por la CLI instalada…). Sin dato fiable queda «desconocida».
//! - **Nivel**: instalación, cuenta, modelo o ejecución activa. Lo que solo se sabe durante un
//!   turno no se afirma de antemano.
//! - **Proveedor frente a Duovra**: `status` describe al proveedor; `integrated` describe si
//!   Duovra lo usa hoy. Una capacidad compatible no se presenta como función de Duovra.
//!
//! Nunca se inicia un turno, se crea un hilo ni se consume cuota para detectar nada.
//!
//! Caché: por ejecutable (ruta, tamaño y fecha del binario, que cambian al actualizar la CLI) y
//! cuenta. Caduca a la hora o al cambiar ajustes; una consulta fallida conserva el último dato
//! válido marcado como desactualizado. Las consultas simultáneas del mismo agente se agrupan.

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use super::{claude, codex, Studio};
use crate::util::{hidden_command, new_id, now_ms};

/// Vigencia de un catálogo o informe confirmado.
pub const TTL_MS: i64 = 60 * 60 * 1000;

#[derive(Clone)]
struct Entry {
    agent: String,
    config_dir: Option<String>,
    /// Respuesta normalizada del proveedor (modelos y extras de la CLI).
    catalog: Value,
    checked_at: i64,
    report: Option<Value>,
    expired: bool,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    /// Datos estáticos del binario (esquema de Codex, `--help` de Claude) por huella del ejecutable.
    binaries: Mutex<HashMap<String, Value>>,
    gates: [tokio::sync::Mutex<()>; 2],
}

impl Registry {
    fn gate(&self, agent: &str) -> &tokio::sync::Mutex<()> {
        &self.gates[usize::from(agent == "codex")]
    }

    /// Obliga a confirmar de nuevo, sin borrar el último dato válido.
    pub fn expire(&self, agent: &str) {
        for entry in self.entries.lock().values_mut().filter(|e| e.agent == agent) {
            entry.expired = true;
        }
    }

    /// Último dato válido de la misma cuenta (otra versión del binario incluida).
    fn fallback(&self, agent: &str, config_dir: &Option<String>) -> Option<Entry> {
        self.entries.lock().values().filter(|e| e.agent == agent && &e.config_dir == config_dir)
            .max_by_key(|e| e.checked_at).cloned()
    }
}

struct Fingerprint {
    key: String,
    binary: String,
    exe: PathBuf,
    config_dir: Option<String>,
    account: Value,
}

fn binary_fingerprint(exe: &Path) -> String {
    let meta = std::fs::metadata(exe).ok();
    let modified = meta.as_ref().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or_default();
    format!("{}\u{1f}{}\u{1f}{}", exe.display(), meta.map(|m| m.len()).unwrap_or_default(), modified)
}

fn fingerprint(studio: &Studio, agent: &str) -> Result<Fingerprint> {
    if !matches!(agent, "claude" | "codex") {
        return Err(anyhow!("Agente desconocido"));
    }
    let exe = studio.executable(agent)?;
    let account = studio.active_account(agent);
    let config_dir = account.as_ref().and_then(|a| a.config_dir.clone());
    let binary = format!("{agent}\u{1f}{}", binary_fingerprint(&exe));
    Ok(Fingerprint {
        key: format!("{binary}\u{1f}{}", config_dir.clone().unwrap_or_default()),
        binary,
        exe,
        account: match account {
            Some(a) => json!({ "id": a.id, "label": a.label, "source": "profile" }),
            None => json!({ "id": null, "label": null, "source": "cli" }),
        },
        config_dir,
    })
}

async fn fetch_catalog(studio: &Arc<Studio>, agent: &str, fp: &Fingerprint) -> Result<Value> {
    if agent == "codex" {
        let server = studio.codex_server_for(fp.config_dir.clone()).await?;
        codex::models_on(&server).await
    } else {
        claude::cli_info_for(studio, fp.config_dir.as_deref()).await
    }
}

/// Catálogo que ve el compositor: sin los extras de la CLI y con su fecha y vigencia.
fn public_catalog(entry: &Entry, stale: bool, error: Option<String>) -> Value {
    let mut out = entry.catalog.clone();
    if let Some(map) = out.as_object_mut() {
        map.remove("extras");
        map.insert("checkedAt".into(), json!(entry.checked_at));
        map.insert("stale".into(), json!(stale));
        map.insert("staleReason".into(), json!(error));
    }
    out
}

/// Entrada vigente o recién consultada. `Err` solo si no hay ningún dato válido previo.
async fn entry_for(studio: &Arc<Studio>, agent: &str, refresh: bool) -> Result<(Entry, bool, Option<String>, Fingerprint)> {
    let started = now_ms();
    let fp = fingerprint(studio, agent)?;
    let _gate = studio.registry.gate(agent).lock().await;
    if let Some(entry) = studio.registry.entries.lock().get(&fp.key).cloned() {
        // Otra petición simultánea ya la confirmó después de que empezara esta: se reutiliza.
        let fresh = !entry.expired && now_ms() - entry.checked_at < TTL_MS;
        if entry.checked_at >= started || (fresh && !refresh) {
            return Ok((entry, false, None, fp));
        }
    }
    match fetch_catalog(studio, agent, &fp).await {
        Ok(catalog) => {
            let entry = Entry { agent: agent.into(), config_dir: fp.config_dir.clone(), catalog, checked_at: now_ms(), report: None, expired: false };
            studio.registry.entries.lock().insert(fp.key.clone(), entry.clone());
            // Mismo canal que el resto de eventos: las vistas abiertas releen la caché, sin otra consulta.
            studio.emit(json!({ "type": "capabilitiesChanged", "agent": agent, "checkedAt": entry.checked_at }));
            Ok((entry, false, None, fp))
        }
        Err(error) => match studio.registry.fallback(agent, &fp.config_dir) {
            Some(entry) => Ok((entry, true, Some(error.to_string()), fp)),
            None => Err(error),
        },
    }
}

pub async fn catalog(studio: &Arc<Studio>, agent: &str, refresh: bool) -> Result<Value> {
    let (entry, stale, error, _) = entry_for(studio, agent, refresh).await?;
    Ok(public_catalog(&entry, stale, error))
}

/// Resolución anunciada por el último catálogo confirmado (`opus` → `claude-opus-5-5`).
/// Es lo que comunicó el proveedor al listar modelos, no prueba del modelo usado en el turno.
pub fn catalog_resolution(studio: &Studio, agent: &str, config_dir: Option<&str>, model: &str) -> Option<String> {
    let exe = studio.executable(agent).ok()?;
    let key = format!("{agent}\u{1f}{}\u{1f}{}", binary_fingerprint(&exe), config_dir.unwrap_or_default());
    let entries = studio.registry.entries.lock();
    let entry = entries.get(&key)?;
    let found = entry.catalog["models"].as_array()?.iter().find(|m| m["id"] == model)?;
    found["exact"].as_str().filter(|exact| *exact != model).map(str::to_owned)
}

// ---------- Informe completo (Ajustes) ----------

pub async fn report(studio: &Arc<Studio>, agent: &str, refresh: bool) -> Value {
    let checked = now_ms();
    let (entry, stale, error, fp) = match entry_for(studio, agent, refresh).await {
        Ok(found) => found,
        Err(error) => {
            let path = studio.executable(agent).ok();
            return json!({
                "agent": agent, "checkedAt": checked, "stale": false, "error": error.to_string(),
                "installation": { "agent": agent, "path": path, "available": false, "auth": { "state": "unknown" } },
                "models": [], "capabilities": unknown_all(agent, "No se pudo consultar el proveedor."), "commands": [],
            });
        }
    };
    if !stale && !refresh {
        if let Some(report) = entry.report.clone() {
            return report;
        }
    }
    let binary = binary_info(studio, agent, &fp, refresh).await;
    let mut report = match agent {
        "codex" => codex_report(studio, &entry, &fp, &binary, stale).await,
        _ => claude_report(&entry, &binary),
    };
    let installation = &mut report["installation"];
    installation["agent"] = json!(agent);
    installation["path"] = json!(fp.exe);
    installation["version"] = entry.catalog["version"].clone();
    installation["available"] = json!(!stale);
    installation["account"] = fp.account.clone();
    installation["checkedAt"] = json!(entry.checked_at);
    report["agent"] = json!(agent);
    report["checkedAt"] = json!(entry.checked_at);
    report["stale"] = json!(stale);
    report["error"] = json!(error);
    report["models"] = public_catalog(&entry, stale, None)["models"].clone();
    report["source"] = entry.catalog["source"].clone();
    for capability in report["capabilities"].as_array_mut().into_iter().flatten() {
        capability["checkedAt"] = json!(entry.checked_at);
    }
    if !stale {
        if let Some(saved) = studio.registry.entries.lock().get_mut(&fp.key) {
            saved.report = Some(report.clone());
        }
    }
    report
}

/// Datos que dependen solo del binario: se calculan una vez por versión instalada.
async fn binary_info(studio: &Arc<Studio>, agent: &str, fp: &Fingerprint, refresh: bool) -> Value {
    if !refresh {
        if let Some(found) = studio.registry.binaries.lock().get(&fp.binary) {
            return found.clone();
        }
    }
    let info = if agent == "codex" {
        match codex_schema(&fp.exe, fp.config_dir.as_deref()).await {
            Ok(schema) => schema,
            Err(error) => json!({ "error": error.to_string() }),
        }
    } else {
        match claude_help(&fp.exe).await {
            Ok(help) => json!({ "help": help }),
            Err(error) => json!({ "error": error.to_string() }),
        }
    };
    if info.get("error").is_none() {
        studio.registry.binaries.lock().insert(fp.binary.clone(), info.clone());
    }
    info
}

async fn run_short(exe: &Path, args: &[&str], config: Option<(&str, &str)>, timeout: u64) -> Result<String> {
    let mut cmd = hidden_command(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if let Some((key, value)) = config {
        cmd.env(key, value);
    }
    let out = tokio::time::timeout(Duration::from_secs(timeout), cmd.output()).await
        .map_err(|_| anyhow!("{} no respondió", args.join(" ")))??;
    if !out.status.success() {
        return Err(anyhow!("{} terminó con error", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn claude_help(exe: &Path) -> Result<String> {
    run_short(exe, &["--help"], None, 20).await
}

/// Métodos del esquema estable que genera la CLI instalada (`app-server generate-json-schema`).
/// Lo que el servidor reconoce y no está en el esquema estable es experimental.
async fn codex_schema(exe: &Path, config_dir: Option<&str>) -> Result<Value> {
    let dir = std::env::temp_dir().join(format!("duovra-codex-schema-{}", new_id()));
    let out = dir.to_string_lossy().into_owned();
    let result = run_short(exe, &["app-server", "generate-json-schema", "--out", &out], config_dir.map(|d| ("CODEX_HOME", d)), 30).await
        .and_then(|_| {
            let read = |name: &str| -> Result<Vec<String>> {
                let text = std::fs::read_to_string(dir.join(format!("{name}.json")))?;
                Ok(schema_methods(&serde_json::from_str(&text)?))
            };
            Ok(json!({ "requests": read("ClientRequest")?, "notifications": read("ServerNotification")?, "serverRequests": read("ServerRequest")? }))
        });
    let _ = std::fs::remove_dir_all(&dir);
    result
}

pub(super) fn schema_methods(schema: &Value) -> Vec<String> {
    schema["oneOf"].as_array().or_else(|| schema["anyOf"].as_array()).into_iter().flatten()
        .filter_map(|variant| variant["properties"]["method"]["enum"][0].as_str().map(str::to_owned)).collect()
}

// ---------- Clasificación ----------

/// Capacidades que sigue el registro y si Duovra las integra hoy (`yes`, `partial`, `no`).
/// `integrated` describe a Duovra, nunca al proveedor.
const CAPABILITIES: &[(&str, &str, &str, &str)] = &[
    // id, nivel, integración en Claude Code, integración en Codex
    ("streaming", "installation", "yes", "yes"),
    ("imageInput", "model", "yes", "yes"),
    ("resume", "installation", "yes", "yes"),
    // 1.0.11, fase 3: bifurcación nativa; listar y leer para importar (Claude Code: lectura local de sus transcripciones).
    ("fork", "installation", "yes", "yes"),
    ("sessionList", "installation", "partial", "yes"),
    ("sessionRead", "installation", "partial", "yes"),
    ("compact", "installation", "yes", "yes"),
    ("planning", "installation", "partial", "partial"),
    ("interactiveQuestions", "installation", "no", "no"),
    ("steering", "run", "no", "yes"),
    ("interrupt", "run", "yes", "yes"),
    ("quickCommands", "installation", "no", "no"),
    ("tasks", "run", "yes", "yes"),
    ("subagents", "installation", "yes", "yes"),
    ("codeReview", "installation", "no", "no"),
    ("goals", "installation", "no", "no"),
    ("usageInfo", "run", "yes", "yes"),
    ("rateLimits", "account", "yes", "yes"),
];

fn capability(agent: &str, id: &str, status: &str, source: &str, note: Option<&str>) -> Value {
    let (level, integrated) = CAPABILITIES.iter().find(|c| c.0 == id)
        .map(|c| (c.1, if agent == "codex" { c.3 } else { c.2 })).unwrap_or(("installation", "no"));
    json!({ "id": id, "level": level, "status": status, "integrated": integrated, "source": source, "note": note })
}

fn unknown_all(agent: &str, note: &str) -> Vec<Value> {
    CAPABILITIES.iter().map(|c| capability(agent, c.0, "unknown", "Sin datos", Some(note))).collect()
}

fn has_flag(help: &str, flag: &str) -> bool {
    help.split(|c: char| c.is_whitespace() || c == ',').any(|token| token == flag)
}

pub(super) fn claude_capabilities(init: &Value, help: Option<&str>) -> Vec<Value> {
    let a = "claude";
    let commands: HashSet<&str> = init["extras"]["commands"].as_array().into_iter().flatten()
        .filter(|c| c["builtin"] == true).filter_map(|c| c["name"].as_str()).collect();
    let has_commands = init["extras"]["commands"].is_array();
    let command = |id: &str, name: &str| -> Value {
        if !has_commands {
            capability(a, id, "unknown", "initialize no informó comandos", None)
        } else if commands.contains(name) {
            capability(a, id, "supported", &format!("initialize · comando /{name}"), None)
        } else {
            capability(a, id, "unsupported", &format!("initialize · sin /{name}"), None)
        }
    };
    let flag = |id: &str, flag: &str| -> Value {
        match help {
            None => capability(a, id, "unknown", "No se pudo leer claude --help", None),
            Some(h) if has_flag(h, flag) => capability(a, id, "supported", &format!("claude --help · {flag}"), None),
            Some(_) => capability(a, id, "unsupported", &format!("claude --help · sin {flag}"), None),
        }
    };
    let agents = init["extras"]["agents"].as_array().map(Vec::len);
    let plan = help.map(|h| h.contains("\"plan\""));
    vec![
        capability(a, "streaming", "supported", "Integración stream-json de Duovra", None),
        capability(a, "imageInput", "unknown", "initialize no informa modalidades por modelo",
            Some("Duovra envía imágenes como bloques de stream-json; cada modelo no declara si las admite.")),
        flag("resume", "--resume"),
        flag("fork", "--fork-session"),
        capability(a, "sessionList", "unknown", "Sin método equivalente en la CLI",
            Some("El Agent SDK documenta la gestión de sesiones; no se asume disponible mediante la CLI.")),
        capability(a, "sessionRead", "unknown", "Sin método equivalente en la CLI", None),
        command("compact", "compact"),
        match plan {
            Some(true) => capability(a, "planning", "supported", "claude --help · --permission-mode plan", None),
            Some(false) => capability(a, "planning", "unsupported", "claude --help · sin modo plan", None),
            None => capability(a, "planning", "unknown", "No se pudo leer claude --help", None),
        },
        capability(a, "interactiveQuestions", "unknown", "initialize no enumera herramientas",
            Some("AskUserQuestion se confirmará al recibir la solicitud durante una ejecución.")),
        capability(a, "steering", "unknown", "Sin mecanismo comunicado por la CLI", None),
        capability(a, "interrupt", "supported", "control_request · interrupt (integrado)", None),
        if has_commands { capability(a, "quickCommands", "supported", "initialize · lista de comandos", None) }
        else { capability(a, "quickCommands", "unknown", "initialize no informó comandos", None) },
        capability(a, "tasks", "unknown", "Se confirma con eventos de la ejecución", None),
        match agents {
            Some(n) if n > 0 => capability(a, "subagents", "supported", "initialize · agents", None),
            Some(_) => capability(a, "subagents", "unsupported", "initialize · agents vacío", None),
            None => capability(a, "subagents", "unknown", "initialize no informó agentes", None),
        },
        command("codeReview", "code-review"),
        command("goals", "goal"),
        capability(a, "usageInfo", "supported", "Evento result de stream-json (integrado)", None),
        capability(a, "rateLimits", "unknown", "Se confirma con rate_limit_event durante una ejecución", None),
    ]
}

pub(super) fn codex_capabilities(known: Option<&[String]>, schema: &Value, models: &[Value]) -> Vec<Value> {
    let a = "codex";
    let stable: HashSet<&str> = ["requests", "notifications", "serverRequests"].iter()
        .flat_map(|k| schema[*k].as_array().into_iter().flatten()).filter_map(Value::as_str).collect();
    let has_schema = !stable.is_empty();
    // Solicitudes del cliente: la lista del servidor instalado manda; el esquema dice si es estable.
    let request = |id: &str, method: &str| -> Value {
        let Some(known) = known else {
            return capability(a, id, "unknown", "No se pudo leer la lista de métodos del App Server", None);
        };
        if !known.iter().any(|m| m == method) {
            return capability(a, id, "unsupported", &format!("App Server · sin {method}"), None);
        }
        if has_schema && !stable.contains(method) {
            return capability(a, id, "experimental", &format!("App Server · {method} (fuera del esquema estable)"),
                Some("Requiere experimentalApi; Duovra no lo activa."));
        }
        capability(a, id, "supported", &format!("App Server · {method}"), None)
    };
    // Notificaciones y solicitudes del servidor: solo el esquema generado por la CLI las enumera.
    let emitted = |id: &str, method: &str| -> Value {
        if !has_schema {
            capability(a, id, "unknown", "Esquema del App Server no disponible", None)
        } else if stable.contains(method) {
            capability(a, id, "supported", &format!("Esquema · {method}"), None)
        } else {
            capability(a, id, "unsupported", &format!("Esquema · sin {method}"), None)
        }
    };
    // Rasgos por modelo de `model/list`: se afirma solo si algún modelo lo declara.
    let model_trait = |id: &str, declared: &dyn Fn(&Value) -> bool, source: &str| -> Value {
        if models.is_empty() {
            capability(a, id, "unknown", "model/list sin modelos", None)
        } else if models.iter().any(declared) {
            capability(a, id, "supported", source, Some("Se decide por modelo."))
        } else {
            capability(a, id, "unsupported", source, None)
        }
    };
    vec![
        emitted("streaming", "item/agentMessage/delta"),
        model_trait("imageInput", &|m| m["inputModalities"].as_array().is_some_and(|l| l.iter().any(|x| x == "image")), "model/list · inputModalities"),
        request("resume", "thread/resume"),
        request("fork", "thread/fork"),
        request("sessionList", "thread/list"),
        request("sessionRead", "thread/read"),
        request("compact", "thread/compact/start"),
        emitted("planning", "item/plan/delta"),
        emitted("interactiveQuestions", "item/tool/requestUserInput"),
        request("steering", "turn/steer"),
        request("interrupt", "turn/interrupt"),
        capability(a, "quickCommands", "unsupported", "El App Server no publica comandos rápidos",
            Some("Las operaciones nativas (compactar, revisar…) se expondrán como acciones de Duovra.")),
        emitted("tasks", "turn/plan/updated"),
        model_trait("subagents", &|m| !m["traits"]["multiAgent"].is_null(), "model/list · multiAgentVersion"),
        request("codeReview", "review/start"),
        request("goals", "thread/goal/set"),
        emitted("usageInfo", "thread/tokenUsage/updated"),
        request("rateLimits", "account/rateLimits/read"),
    ]
}

fn claude_report(entry: &Entry, binary: &Value) -> Value {
    let init = &entry.catalog;
    let account = &init["account"];
    let signed_in = account["email"].as_str().is_some_and(|e| !e.is_empty()) || account["subscriptionType"].is_string();
    let mut limitations = vec![];
    if let Some(reason) = init["extras"]["fastModeDisabledReason"].as_str() {
        limitations.push(json!({ "id": "fastModeDisabled", "detail": reason }));
    }
    if binary.get("error").is_some() {
        limitations.push(json!({ "id": "helpUnavailable", "detail": binary["error"] }));
    }
    json!({
        "installation": {
            "protocol": "claude -p · stream-json (stdio)", "protocolVersion": init["version"],
            "auth": { "state": if signed_in { "signedIn" } else { "unknown" }, "method": account["apiProvider"], "plan": account["subscriptionType"] },
            "permissionMode": init["permissionMode"],
        },
        "capabilities": claude_capabilities(init, binary["help"].as_str()),
        "commands": init["extras"]["commands"].clone(),
        "providerFlags": { "fastModeState": init["extras"]["fastModeState"], "cliCapabilities": init["extras"]["cliCapabilities"] },
        "limitations": limitations,
    })
}

async fn codex_report(studio: &Arc<Studio>, entry: &Entry, fp: &Fingerprint, schema: &Value, stale: bool) -> Value {
    let server = if stale { None } else { studio.codex_server_for(fp.config_dir.clone()).await.ok() };
    let known = server.as_ref().and_then(|s| s.methods.lock().clone());
    let (account, provider) = match &server {
        Some(server) => {
            let account = server.request_timeout("account/read", json!({ "refreshToken": false }), Duration::from_secs(15)).await.ok();
            let provider = if known.as_ref().is_some_and(|k| k.iter().any(|m| m == "modelProvider/capabilities/read")) {
                server.request_timeout("modelProvider/capabilities/read", json!({}), Duration::from_secs(15)).await.unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            (account, provider)
        }
        None => (None, Value::Null),
    };
    let auth = match &account {
        Some(a) if a["account"].is_object() => json!({ "state": "signedIn", "method": a["account"]["type"], "plan": a["account"]["planType"] }),
        Some(a) if a["requiresOpenaiAuth"] == true => json!({ "state": "signedOut" }),
        _ => json!({ "state": "unknown" }),
    };
    let mut limitations = vec![];
    if schema.get("error").is_some() {
        limitations.push(json!({ "id": "schemaUnavailable", "detail": schema["error"] }));
    }
    if known.is_none() && !stale {
        limitations.push(json!({ "id": "methodsUnavailable", "detail": Value::Null }));
    }
    let experimental: Vec<String> = match &known {
        Some(known) if schema["requests"].is_array() => {
            let stable: HashSet<&str> = schema["requests"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            known.iter().filter(|m| !stable.contains(m.as_str())).cloned().collect()
        }
        _ => vec![],
    };
    json!({
        "installation": {
            "protocol": "Codex App Server · JSON-RPC (stdio)", "protocolVersion": entry.catalog["version"], "auth": auth,
            "methods": known.as_ref().map(Vec::len), "experimentalMethods": experimental.len(),
        },
        "capabilities": codex_capabilities(known.as_deref(), schema, entry.catalog["models"].as_array().map(Vec::as_slice).unwrap_or_default()),
        "commands": [],
        "providerFlags": { "modelProvider": provider },
        "limitations": limitations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status<'a>(caps: &'a [Value], id: &str) -> &'a str {
        caps.iter().find(|c| c["id"] == id).and_then(|c| c["status"].as_str()).unwrap()
    }

    #[test]
    fn claude_sin_datos_queda_desconocido() {
        let caps = claude_capabilities(&json!({ "models": [] }), None);
        assert_eq!(status(&caps, "fork"), "unknown");
        assert_eq!(status(&caps, "compact"), "unknown");
        assert_eq!(status(&caps, "planning"), "unknown");
        assert_eq!(caps.len(), CAPABILITIES.len());
    }

    #[test]
    fn claude_con_initialize_y_ayuda() {
        let init = json!({ "models": [{}], "extras": {
            "commands": [{ "name": "compact", "builtin": true }, { "name": "goal", "builtin": false }],
            "agents": ["general-purpose"],
        } });
        let help = "  -r, --resume [value]  Resume\n  --fork-session  Fork\n  --permission-mode <mode> (choices: \"auto\", \"plan\")";
        let caps = claude_capabilities(&init, Some(help));
        assert_eq!(status(&caps, "fork"), "supported");
        assert_eq!(status(&caps, "resume"), "supported");
        assert_eq!(status(&caps, "compact"), "supported");
        // Un comando personalizado con el mismo nombre no prueba la función nativa.
        assert_eq!(status(&caps, "goals"), "unsupported");
        assert_eq!(status(&caps, "planning"), "supported");
        assert_eq!(status(&caps, "subagents"), "supported");
        assert_eq!(status(&caps, "steering"), "unknown");
        let fork = caps.iter().find(|c| c["id"] == "fork").unwrap();
        assert_eq!(fork["integrated"], "yes");
    }

    #[test]
    fn codex_estable_experimental_y_ausente() {
        let known: Vec<String> = ["thread/fork", "thread/list", "turn/steer", "review/start", "memory/status"].map(String::from).to_vec();
        let schema = json!({ "requests": ["thread/fork", "thread/list", "turn/steer"], "notifications": ["item/plan/delta"], "serverRequests": [] });
        let models = [json!({ "inputModalities": ["text"], "traits": { "multiAgent": "v2" } })];
        let caps = codex_capabilities(Some(&known), &schema, &models);
        assert_eq!(status(&caps, "imageInput"), "unsupported");
        assert_eq!(status(&caps, "subagents"), "supported");
        assert_eq!(status(&caps, "fork"), "supported");
        assert_eq!(status(&caps, "codeReview"), "experimental");
        assert_eq!(status(&caps, "goals"), "unsupported");
        assert_eq!(status(&caps, "planning"), "supported");
        assert_eq!(status(&caps, "interactiveQuestions"), "unsupported");
        let steering = caps.iter().find(|c| c["id"] == "steering").unwrap();
        assert_eq!(steering["integrated"], "yes");
        assert_eq!(steering["level"], "run");
    }

    #[test]
    fn codex_sin_lista_ni_esquema_no_inventa() {
        let caps = codex_capabilities(None, &json!({ "error": "x" }), &[]);
        for id in ["fork", "goals", "streaming", "tasks", "rateLimits", "imageInput", "subagents"] {
            assert_eq!(status(&caps, id), "unknown", "{id}");
        }
    }

    #[test]
    fn metodos_del_esquema() {
        let schema = json!({ "oneOf": [{ "properties": { "method": { "enum": ["initialize"] } } }, { "properties": {} }] });
        assert_eq!(schema_methods(&schema), ["initialize"]);
    }

    #[test]
    fn bandera_exacta_en_la_ayuda() {
        assert!(has_flag("  --fork-session  When resuming", "--fork-session"));
        assert!(!has_flag("  --fork-session-x", "--fork-session"));
        assert!(has_flag("  -r, --resume [value]", "--resume"));
    }

    #[test]
    fn catalogo_publico_sin_extras() {
        let entry = Entry { agent: "claude".into(), config_dir: None, catalog: json!({ "models": [], "extras": { "commands": [] } }),
            checked_at: 5, report: None, expired: false };
        let out = public_catalog(&entry, true, Some("sin red".into()));
        assert!(out.get("extras").is_none());
        assert_eq!(out["stale"], true);
        assert_eq!(out["checkedAt"], 5);
        assert_eq!(out["staleReason"], "sin red");
    }
}
