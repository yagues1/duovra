//! Comandos Tauri expuestos a la interfaz.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::agents::{claude, codex, SendRequest, Studio, AGENTS};
use crate::util::{new_id, now_ms};

type Res<T> = Result<T, String>;
type S<'a> = State<'a, Arc<Studio>>;

fn e<E: std::fmt::Display>(err: E) -> String {
    format!("{err:#}")
}

#[tauri::command]
pub fn bootstrap(studio: S<'_>) -> Res<Value> {
    let db = &studio.db;
    Ok(json!({
        "projects": db.list_projects().map_err(e)?,
        "conversations": db.list_conversations().map_err(e)?,
        "settings": db.get_settings().map_err(e)?,
        "accounts": db.list_accounts().map_err(e)?,
        "activeRuns": studio.active_runs(),
        "appVersion": env!("CARGO_PKG_VERSION"),
    }))
}

// ---------- Proyectos ----------

#[tauri::command]
pub fn create_project(studio: S<'_>, name: String, path: String) -> Res<Value> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("La carpeta seleccionada no existe".into());
    }
    let name = if name.trim().is_empty() {
        p.file_name().and_then(|n| n.to_str()).unwrap_or("Proyecto").to_string()
    } else {
        name.trim().to_string()
    };
    let project = studio.db.create_project(&new_id(), &name, &path).map_err(e)?;
    Ok(serde_json::to_value(project).unwrap())
}

#[tauri::command]
pub fn rename_project(studio: S<'_>, id: String, name: String) -> Res<()> {
    if name.trim().is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    studio.db.rename_project(&id, name.trim()).map_err(e)
}

#[tauri::command]
pub fn delete_project(studio: S<'_>, id: String) -> Res<()> {
    // Solo elimina el proyecto de la aplicación; nunca toca la carpeta del disco.
    studio.db.delete_project(&id).map_err(e)
}

// ---------- Conversaciones ----------

#[tauri::command]
pub fn create_conversation(studio: S<'_>, project_id: String, title: Option<String>) -> Res<Value> {
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Nueva conversación".into());
    let conv = studio.db.create_conversation(&new_id(), &project_id, &title).map_err(e)?;
    Ok(serde_json::to_value(conv).unwrap())
}

#[tauri::command]
pub fn rename_conversation(studio: S<'_>, id: String, title: String) -> Res<()> {
    if title.trim().is_empty() {
        return Err("El título no puede estar vacío".into());
    }
    studio.db.rename_conversation(&id, title.trim()).map_err(e)
}

#[tauri::command]
pub fn delete_conversation(studio: S<'_>, id: String) -> Res<()> {
    if studio.active_runs().iter().any(|r| r["conversationId"] == id.as_str()) {
        return Err("Detén la ejecución activa antes de eliminar la conversación".into());
    }
    studio.db.delete_conversation(&id).map_err(e)
}

#[tauri::command]
pub fn list_messages(studio: S<'_>, conversation_id: String) -> Res<Value> {
    Ok(json!({
        "messages": studio.db.list_messages(&conversation_id).map_err(e)?,
        "sessions": studio.db.list_provider_sessions(&conversation_id).map_err(e)?,
    }))
}

#[tauri::command]
pub fn set_draft(studio: S<'_>, conversation_id: String, draft: String) -> Res<()> {
    studio.db.set_draft(&conversation_id, &draft).map_err(e)
}

#[tauri::command]
pub fn set_conversation_prefs(studio: S<'_>, conversation_id: String, agent: String, model: String, effort: Option<String>) -> Res<()> {
    studio
        .db
        .set_conversation_prefs(&conversation_id, &agent, &model, effort.as_deref())
        .map_err(e)
}

#[tauri::command]
pub fn forget_provider_session(studio: S<'_>, conversation_id: String, agent: String) -> Res<()> {
    studio.db.delete_provider_session(&conversation_id, &agent).map_err(e)
}

// ---------- Ajustes ----------

#[tauri::command]
pub async fn set_setting(studio: S<'_>, key: String, value: Value) -> Res<()> {
    studio.db.set_setting(&key, &value).map_err(e)?;
    if key.starts_with("agents.codex.") || key == "accounts.active.codex" {
        studio.restart_codex().await;
    }
    if key.starts_with("agents.claude.") || key == "accounts.active.claude" {
        studio.claude_info.lock().clear();
    }
    Ok(())
}

// ---------- Agentes ----------

#[tauri::command]
pub async fn detect_agents(studio: S<'_>) -> Res<Value> {
    let mut out = Vec::new();
    for a in AGENTS {
        out.push(crate::detect::detect(a, studio.db.get_setting_str(&format!("agents.{a}.path"))).await);
    }
    Ok(Value::Array(out))
}

#[tauri::command]
pub async fn agent_models(studio: S<'_>, agent: String, refresh: Option<bool>) -> Res<Value> {
    let studio = studio.inner().clone();
    match agent.as_str() {
        "codex" => codex::list_models(&studio).await.map_err(e),
        "claude" => claude::cli_info(&studio, refresh.unwrap_or(false)).await.map_err(e),
        _ => Err("Agente desconocido".into()),
    }
}

#[tauri::command]
pub async fn agent_account(studio: S<'_>, agent: String) -> Res<Value> {
    let studio = studio.inner().clone();
    match agent.as_str() {
        "codex" => codex::account_status(&studio).await.map_err(e),
        "claude" => {
            let status = claude::auth_status(&studio).await.map_err(e)?;
            Ok(json!({ "status": status }))
        }
        _ => Err("Agente desconocido".into()),
    }
}

#[tauri::command]
pub async fn codex_rate_limits(studio: S<'_>) -> Res<Value> {
    codex::rate_limits(&studio.inner().clone()).await.map_err(e)
}

#[tauri::command]
pub async fn start_login(studio: S<'_>, agent: String) -> Res<Value> {
    let studio = studio.inner().clone();
    match agent.as_str() {
        "codex" => codex::start_login(&studio).await.map_err(e),
        "claude" => {
            claude::open_login_terminal(&studio).map_err(e)?;
            Ok(json!({ "terminal": true }))
        }
        _ => Err("Agente desconocido".into()),
    }
}

#[tauri::command]
pub fn usage_summary(studio: S<'_>, days: Option<i64>) -> Res<Value> {
    let days = days.unwrap_or(30);
    let since = now_ms() - days * 24 * 3600 * 1000;
    Ok(json!({ "days": days, "rows": studio.db.usage_summary(since).map_err(e)? }))
}

// ---------- Cuentas ----------

#[tauri::command]
pub fn add_account(studio: S<'_>, agent: String, label: String, config_dir: Option<String>) -> Res<Value> {
    if !AGENTS.contains(&agent.as_str()) {
        return Err("Agente desconocido".into());
    }
    let dir = config_dir.filter(|d| !d.trim().is_empty());
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).map_err(e)?;
    }
    let id = new_id();
    studio.db.add_account(&id, &agent, label.trim(), dir.as_deref()).map_err(e)?;
    Ok(json!({ "accounts": studio.db.list_accounts().map_err(e)? }))
}

#[tauri::command]
pub async fn remove_account(studio: S<'_>, id: String) -> Res<Value> {
    let accounts = studio.db.list_accounts().map_err(e)?;
    if let Some(acc) = accounts.iter().find(|a| a.id == id) {
        let key = format!("accounts.active.{}", acc.agent);
        if studio.db.get_setting_str(&key).as_deref() == Some(id.as_str()) {
            studio.db.set_setting(&key, &Value::Null).map_err(e)?;
            if acc.agent == "codex" {
                studio.restart_codex().await;
            }
        }
    }
    studio.db.remove_account(&id).map_err(e)?;
    Ok(json!({ "accounts": studio.db.list_accounts().map_err(e)? }))
}

// ---------- Ejecuciones ----------

#[tauri::command]
pub fn send_message(studio: S<'_>, request: SendRequest) -> Res<Value> {
    studio.inner().send(request).map_err(e)
}

#[tauri::command]
pub async fn cancel_run(studio: S<'_>, run_id: String) -> Res<()> {
    studio.cancel(&run_id).await.map_err(e)
}

#[tauri::command]
pub async fn respond_approval(studio: S<'_>, approval_id: String, decision: String) -> Res<()> {
    studio.respond_approval(&approval_id, &decision).await.map_err(e)
}

// ---------- Archivos (panel de consulta) ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileArgs {
    pub path: String,
    pub root: Option<String>,
}

#[tauri::command]
pub fn read_file(args: ReadFileArgs) -> Res<Value> {
    const MAX: u64 = 1024 * 1024;
    let mut p = PathBuf::from(&args.path);
    if p.is_relative() {
        if let Some(root) = &args.root {
            p = PathBuf::from(root).join(p);
        }
    }
    let meta = std::fs::metadata(&p).map_err(|_| format!("No se encontró el archivo: {}", p.display()))?;
    if meta.is_dir() {
        return Err("La ruta es una carpeta".into());
    }
    let size = meta.len();
    let bytes = {
        use std::io::Read;
        let mut f = std::fs::File::open(&p).map_err(e)?;
        let mut buf = Vec::new();
        f.by_ref().take(MAX).read_to_end(&mut buf).map_err(e)?;
        buf
    };
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    Ok(json!({
        "path": p,
        "size": size,
        "truncated": size > MAX,
        "binary": binary,
        "content": if binary { String::new() } else { String::from_utf8_lossy(&bytes).to_string() },
    }))
}

/// Datos reales de los adjuntos para explicar su tratamiento antes de enviar (AUD-005).
/// Solo metadatos: no lee el contenido.
#[tauri::command]
pub fn inspect_attachments(paths: Vec<String>) -> Res<Value> {
    let list: Vec<Value> = paths
        .iter()
        .map(|p| match std::fs::metadata(p) {
            Ok(m) => json!({ "path": p, "exists": true, "isDir": m.is_dir(), "size": m.len() }),
            Err(_) => json!({ "path": p, "exists": false, "isDir": false, "size": 0 }),
        })
        .collect();
    Ok(Value::Array(list))
}
