//! Comandos Tauri expuestos a la interfaz.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::agents::{claude, codex, SendRequest, Studio, AGENTS};
use crate::util::{new_id, now_ms};

type Res<T> = Result<T, String>;
type S<'a> = State<'a, Arc<Studio>>;

fn e<E: std::fmt::Display>(err: E) -> String {
    format!("{err:#}")
}

#[tauri::command]
pub async fn bootstrap(app: AppHandle) -> Res<Value> {
    let studio = app.try_state::<Arc<Studio>>().map(|state| state.inner().clone()).ok_or(
        "No se pudieron abrir los datos de Duovra. Cierra otras ventanas de Duovra y comprueba el acceso y el espacio libre de la carpeta de datos antes de reabrir.",
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = &studio.db;
        // Los chats provisionales que se abandonaron sin contenido no sobreviven a un reinicio.
        if studio.active_runs().is_empty() {
            let _ = db.purge_empty_conversations();
        }
        Ok(json!({
            "projects": db.list_projects().map_err(e)?,
            "conversations": db.list_conversations().map_err(e)?,
            "worktrees": db.list_worktrees().map_err(e)?,
            // Proyectos dentro de un repositorio Git (comprobación de disco, sin ejecutar Git).
            "gitProjects": db.list_projects().map_err(e)?.into_iter()
                .filter(|p| std::path::Path::new(&p.path).ancestors().any(|dir| dir.join(".git").exists()))
                .map(|p| p.id).collect::<Vec<_>>(),
            "settings": db.get_settings().map_err(e)?,
            "restoreNotice": crate::backup::take_notice(db),
            "accounts": db.list_accounts().map_err(e)?,
            "activeRuns": studio.active_runs(),
            "appVersion": app.package_info().version.to_string(),
            "qaMode": if app.config().identifier == crate::RC1_QA_IDENTIFIER {
                Some(if std::env::var_os("DUOVRA_RC1_TEST_PROFILE").is_some() { "fixture" } else { "native" })
            } else { None },
        }))
    }).await.map_err(e)?
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
pub fn create_conversation(studio: S<'_>, project_id: String, title: Option<String>, worktree_id: Option<String>) -> Res<Value> {
    let title = title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let conv = studio.db.create_conversation_in(&new_id(), &project_id, title, worktree_id.as_deref()).map_err(e)?;
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

/// Descarta un chat provisional que se abandona sin contenido. Nunca borra uno con mensajes,
/// borrador, adjuntos, encargos o sesiones de proveedor.
#[tauri::command]
pub fn discard_empty_conversation(studio: S<'_>, id: String) -> Res<bool> {
    if studio.active_runs().iter().any(|r| r["conversationId"] == id.as_str()) {
        return Ok(false);
    }
    studio.db.discard_empty_conversation(&id).map_err(e)
}

#[tauri::command]
pub fn set_conversation_permissions(
    studio: S<'_>, conversation_id: String, agent: String, permissions: crate::agents::Permissions,
) -> Res<()> {
    permissions.validate(&agent).map_err(e)?;
    let value = serde_json::to_value(&permissions).map_err(e)?;
    studio.db.set_conversation_permissions(&conversation_id, &agent, &value).map_err(e)
}

#[derive(Serialize)]
pub struct ConversationHistory {
    messages: Vec<crate::db::Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sessions: Option<Vec<crate::db::ProviderSession>>,
}

#[tauri::command]
pub async fn list_messages(studio: S<'_>, conversation_id: String, include_sessions: Option<bool>) -> Res<ConversationHistory> {
    let db = studio.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ConversationHistory {
            messages: db.list_messages(&conversation_id).map_err(e)?,
            sessions: include_sessions.unwrap_or(true)
                .then(|| db.list_provider_sessions(&conversation_id))
                .transpose().map_err(e)?,
        })
    }).await.map_err(e)?
}

#[tauri::command]
pub async fn search_conversations(studio: S<'_>, query: String) -> Res<Vec<Value>> {
    let db = studio.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.search_conversations(&query)).await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub async fn set_draft(studio: S<'_>, conversation_id: String, draft: String) -> Res<()> {
    studio.db.set_draft(&conversation_id, &draft).map_err(e)
}

#[tauri::command]
pub fn set_draft_attachments(studio: S<'_>, conversation_id: String, paths: Vec<String>) -> Res<()> {
    studio.db.set_draft_attachments(&conversation_id, &paths).map_err(e)
}

#[tauri::command]
pub async fn set_conversation_prefs(studio: S<'_>, conversation_id: String, agent: String, model: String, effort: Option<String>) -> Res<()> {
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
    if key.starts_with("agents.codex.") {
        studio.restart_codex().await;
    }
    // El registro ya distingue ejecutable, versión y cuenta; esto solo obliga a confirmar de nuevo.
    for agent in ["claude", "codex"] {
        if key.starts_with(&format!("agents.{agent}.")) || key == format!("accounts.active.{agent}") {
            studio.registry.expire(agent);
        }
    }
    Ok(())
}

// ---------- Agentes ----------

#[tauri::command]
pub async fn detect_agents(studio: S<'_>) -> Res<Value> {
    let (claude, codex) = tokio::join!(
        crate::detect::detect("claude", studio.db.get_setting_str("agents.claude.path")),
        crate::detect::detect("codex", studio.db.get_setting_str("agents.codex.path")),
    );
    Ok(json!([claude, codex]))
}

#[tauri::command]
pub async fn agent_models(studio: S<'_>, agent: String, refresh: Option<bool>) -> Res<Value> {
    let studio = studio.inner().clone();
    crate::agents::capabilities::catalog(&studio, &agent, refresh.unwrap_or(false)).await.map_err(e)
}

/// Registro de capacidades de un agente (Ajustes → Agentes y modelos). Bajo demanda y en caché.
#[tauri::command]
pub async fn agent_capabilities(studio: S<'_>, agent: String, refresh: Option<bool>) -> Res<Value> {
    let studio = studio.inner().clone();
    Ok(crate::agents::capabilities::report(&studio, &agent, refresh.unwrap_or(false)).await)
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
pub async fn usage_summary(studio: S<'_>, days: Option<i64>) -> Res<Value> {
    let days = days.unwrap_or(30).clamp(0, 365);
    let since = if days == 0 { 0 } else { now_ms() - days * 86_400_000 };
    Ok(json!({ "days": days, "rows": studio.db.usage_summary(since).map_err(e)? }))
}

#[tauri::command]
pub async fn run_insights(studio: S<'_>, message_id: String) -> Res<Option<Value>> {
    studio.db.run_insights(&message_id).map_err(e)
}

#[tauri::command]
pub async fn insights_timeline(studio: S<'_>, scope: crate::db::insights::TimelineScope) -> Res<Vec<Value>> {
    studio.db.insights_timeline(&scope).map_err(e)
}

#[tauri::command]
pub async fn insights_usage(studio: S<'_>, scope: crate::db::insights::UsageScope) -> Res<Vec<Value>> {
    studio.db.insights_usage(&scope, now_ms()).map_err(e)
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
pub async fn submit_message(studio: S<'_>, id: String, request: SendRequest, account_id: Option<String>) -> Res<Value> {
    studio.inner().submit(&id, request, account_id.as_deref()).await.map_err(e)
}

#[tauri::command]
pub fn message_queue(studio: S<'_>, conversation_id: String) -> Res<crate::db::queue::QueueView> {
    studio.db.queue(&conversation_id).map_err(e)
}

#[tauri::command]
pub async fn enqueue_message(studio: S<'_>, id: String, request: SendRequest, account_id: Option<String>, defer: Option<bool>) -> Res<crate::db::queue::QueueView> {
    studio.inner().enqueue(&id, request, account_id.as_deref(), defer.unwrap_or(false)).await.map_err(e)
}

#[tauri::command]
pub async fn edit_queued_message(studio: S<'_>, id: String, request: SendRequest, replace_target: bool, account_id: Option<String>) -> Res<crate::db::queue::QueueView> {
    studio.inner().edit_queued(&id, request, replace_target, account_id.as_deref()).await.map_err(e)
}

#[tauri::command]
pub fn update_message_queue(studio: S<'_>, conversation_id: String, action: crate::db::queue::QueueAction) -> Res<crate::db::queue::QueueView> {
    studio.inner().update_queue(&conversation_id, action).map_err(e)
}

#[tauri::command]
pub async fn reconcile_queued_message(studio: S<'_>, conversation_id: String, id: String) -> Res<String> {
    studio.inner().reconcile_queued(&conversation_id, &id).await.map_err(e)
}

#[tauri::command]
pub async fn steer_run(studio: S<'_>, run_id: String, text: String, attachments: Vec<String>) -> Res<()> {
    studio.inner().steer(&run_id, text, attachments).await.map_err(e)
}

#[tauri::command]
pub async fn cancel_run(studio: S<'_>, run_id: String) -> Res<()> {
    studio.cancel(&run_id).await.map_err(e)
}

#[tauri::command]
pub async fn respond_approval(studio: S<'_>, approval_id: String, decision: String) -> Res<()> {
    studio.respond_approval(&approval_id, &decision).await.map_err(e)
}

// ---------- Planes y preguntas (1.0.11, fase 4) ----------

#[tauri::command]
pub fn set_conversation_work_mode(studio: S<'_>, conversation_id: String, agent: String, mode: String) -> Res<()> {
    studio.db.set_conversation_work_mode(&conversation_id, &agent, &mode).map_err(e)
}

#[tauri::command]
pub fn list_interactions(studio: S<'_>, conversation_id: String) -> Res<Vec<crate::db::interactions::Interaction>> {
    studio.db.list_interactions(&conversation_id).map_err(e)
}

#[tauri::command]
pub fn pending_interactions(studio: S<'_>) -> Res<Vec<serde_json::Value>> {
    studio.db.pending_interactions().map_err(e)
}

#[tauri::command]
pub async fn answer_question(studio: S<'_>, interaction_id: String, answers: Vec<crate::agents::interact::Answer>) -> Res<()> {
    studio.answer_question(&interaction_id, answers).await.map_err(e)
}

#[tauri::command]
pub async fn dismiss_question(studio: S<'_>, interaction_id: String) -> Res<()> {
    studio.dismiss_question(&interaction_id).await.map_err(e)
}

#[tauri::command]
pub async fn decide_plan(
    studio: S<'_>, interaction_id: String, action: String, feedback: Option<String>, request: Option<SendRequest>,
) -> Res<serde_json::Value> {
    studio.inner().decide_plan(&interaction_id, &action, feedback, request).await.map_err(e)
}

// ---------- Archivos (panel de consulta) ----------

use crate::workspace::{DiffScope, Document, GitDiff, GitStatus, Listing, Workspace};

/// Raíz de un espacio de Workbench: el id de un proyecto (directorio principal) o de un worktree.
fn project_path(studio: &Studio, space_id: &str) -> Res<String> {
    studio.db.space_root(space_id).map_err(e)
}

#[tauri::command]
pub async fn workspace_list(studio: S<'_>, project_id: String, path: String) -> Res<Listing> {
    let root = project_path(&studio, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || Workspace::open(&root)?.list(&path)).await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub async fn workspace_catalog(studio: S<'_>, project_id: String) -> Res<Listing> {
    let root = project_path(&studio, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || Workspace::open(&root)?.catalog()).await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub async fn workspace_read(studio: S<'_>, project_id: String, path: String, revision: Option<String>) -> Res<Option<Document>> {
    let root = project_path(&studio, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || Workspace::open(&root)?.read_if_changed(&path, revision.as_deref())).await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub async fn workspace_git_status(studio: S<'_>, project_id: String) -> Res<GitStatus> {
    let root = project_path(&studio, &project_id)?;
    Workspace::open(&root).map_err(e)?.git_status().await.map_err(e)
}

#[tauri::command]
pub async fn workspace_git_diff(studio: S<'_>, project_id: String, path: String, scope: DiffScope) -> Res<GitDiff> {
    let root = project_path(&studio, &project_id)?;
    Workspace::open(&root).map_err(e)?.git_diff(&path, scope).await.map_err(e)
}

/// Datos reales de los adjuntos para explicar su tratamiento antes de enviar (AUD-005).
/// Solo metadatos: no lee el contenido.
#[tauri::command]
pub async fn inspect_attachments(paths: Vec<String>) -> Res<Value> {
    let list: Vec<Value> = paths
        .iter()
        .map(|p| match std::fs::metadata(p) {
            Ok(m) => json!({ "path": p, "exists": true, "isDir": m.is_dir(), "size": m.len() }),
            Err(_) => json!({ "path": p, "exists": false, "isDir": false, "size": 0 }),
        })
        .collect();
    Ok(Value::Array(list))
}

// ---------- Worktrees (1.0.9) ----------

use crate::worktrees::{self as wt, CreateRequest};

async fn repo_for_project(studio: &Studio, project_id: &str) -> Res<wt::Repo> {
    let project = studio.db.get_project(project_id).map_err(e)?;
    wt::repo_of(&project.path).await.map_err(e)
}

fn worktree_location(studio: &Studio) -> Option<String> {
    studio.db.get_setting_str("worktrees.location")
}

#[tauri::command]
pub async fn worktree_preflight(studio: S<'_>, project_id: String, request: Option<CreateRequest>) -> Res<wt::Preflight> {
    let repo = repo_for_project(&studio, &project_id).await?;
    wt::preflight(&repo, worktree_location(&studio).as_deref(), request.as_ref()).await.map_err(e)
}

#[tauri::command]
pub async fn worktree_create(studio: S<'_>, project_id: String, request: CreateRequest) -> Res<crate::db::worktrees::Worktree> {
    let repo = repo_for_project(&studio, &project_id).await?;
    let check = wt::preflight(&repo, worktree_location(&studio).as_deref(), Some(&request)).await.map_err(e)?;
    if !check.errors.is_empty() {
        return Err(check.errors.join(" "));
    }
    wt::create(&repo, &request).await.map_err(e)?;
    let base = request.new_branch.then(|| request.base.clone().unwrap_or_else(|| "HEAD".into()));
    studio.db.insert_worktree(crate::db::worktrees::NewWorktree {
        id: &new_id(), project_id: &project_id, path: request.path.trim(), branch: Some(request.branch.trim()),
        label: request.name.trim(), managed: true, base_ref: base.as_deref(),
    }).map_err(e)
}

/// Worktrees que Git conoce y Duovra todavía no tiene registrados (excepto el principal).
#[tauri::command]
pub async fn worktree_importable(studio: S<'_>, project_id: String) -> Res<Vec<wt::GitWorktree>> {
    let repo = repo_for_project(&studio, &project_id).await?;
    let registered: Vec<String> = studio.db.list_worktrees().map_err(e)?.into_iter()
        .filter(|w| w.project_id == project_id && !w.retired).map(|w| w.path).collect();
    let main = repo.main.to_string_lossy().into_owned();
    Ok(wt::list(&repo).await.map_err(e)?.into_iter()
        .filter(|w| !w.bare && !wt::same_path(&w.path, &main) && !registered.iter().any(|r| wt::same_path(r, &w.path)))
        .collect())
}

#[tauri::command]
pub async fn worktree_import(studio: S<'_>, project_id: String, path: String) -> Res<crate::db::worktrees::Worktree> {
    let repo = repo_for_project(&studio, &project_id).await?;
    let found = wt::list(&repo).await.map_err(e)?.into_iter().find(|w| wt::same_path(&w.path, &path))
        .ok_or("Esa carpeta no es un worktree de este repositorio.")?;
    if wt::same_path(&found.path, &repo.main.to_string_lossy()) {
        return Err("El directorio principal ya es el propio proyecto.".into());
    }
    let label = std::path::Path::new(&found.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "worktree".into());
    studio.db.insert_worktree(crate::db::worktrees::NewWorktree {
        id: &new_id(), project_id: &project_id, path: &found.path, branch: found.branch.as_deref(),
        label: &label, managed: false, base_ref: None,
    }).map_err(e)
}

#[tauri::command]
pub fn worktree_rename(studio: S<'_>, id: String, label: String) -> Res<()> {
    let label = label.trim();
    if label.is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    studio.db.rename_worktree(&id, label).map_err(e)
}

#[tauri::command]
pub async fn worktree_status(studio: S<'_>, id: String) -> Res<wt::Status> {
    let worktree = studio.db.get_worktree(&id).map_err(e)?;
    wt::status(&worktree.path).await.map_err(e)
}

#[tauri::command]
pub async fn worktree_size(studio: S<'_>, id: String) -> Res<Value> {
    let path = studio.db.get_worktree(&id).map_err(e)?.path;
    let (bytes, partial) = tauri::async_runtime::spawn_blocking(move || wt::disk_usage(&path)).await.map_err(e)?.map_err(e)?;
    Ok(json!({ "bytes": bytes, "partial": partial }))
}

fn worktree_running(studio: &Studio, id: &str) -> bool {
    studio.active_runs().iter().filter_map(|run| run["conversationId"].as_str().map(str::to_owned))
        .any(|cid| studio.db.get_conversation(&cid).ok().and_then(|c| c.worktree_id).as_deref() == Some(id))
}

#[tauri::command]
pub async fn worktree_removal_check(studio: S<'_>, id: String) -> Res<wt::RemovalCheck> {
    let worktree = studio.db.get_worktree(&id).map_err(e)?;
    let repo = repo_for_project(&studio, &worktree.project_id).await?;
    let usage = studio.db.worktree_usage(&id).map_err(e)?;
    wt::removal_check(&repo, &worktree.path, worktree.branch.as_deref(), usage, worktree_running(&studio, &id)).await.map_err(e)
}

/// Retira el worktree de Duovra y, solo si se pide y es seguro, elimina su carpeta y su rama.
#[tauri::command]
pub async fn worktree_remove(studio: S<'_>, id: String, delete_dir: bool, delete_branch: bool) -> Res<()> {
    let worktree = studio.db.get_worktree(&id).map_err(e)?;
    if delete_dir || delete_branch {
        let repo = repo_for_project(&studio, &worktree.project_id).await?;
        let usage = studio.db.worktree_usage(&id).map_err(e)?;
        let check = wt::removal_check(&repo, &worktree.path, worktree.branch.as_deref(), usage, worktree_running(&studio, &id)).await.map_err(e)?;
        if delete_dir {
            if !check.can_remove_dir {
                return Err(if check.blockers.is_empty() { "La carpeta ya no existe.".into() } else { check.blockers.join(" ") });
            }
            wt::remove_dir(&repo, &worktree.path).await.map_err(e)?;
        }
        if delete_branch {
            let branch = worktree.branch.as_deref().ok_or("Este worktree no tiene una rama propia.")?;
            if !check.can_delete_branch {
                return Err(check.branch_note.unwrap_or_else(|| "La rama no se puede borrar de forma segura.".into()));
            }
            if std::path::Path::new(&worktree.path).is_dir() {
                return Err("Elimina primero la carpeta del worktree: Git no borra una rama en uso.".into());
            }
            wt::delete_branch(&repo, branch).await.map_err(e)?;
        }
    }
    studio.db.retire_worktree(&id).map_err(e)
}

#[tauri::command]
pub async fn worktree_repair(studio: S<'_>, id: String, path: String) -> Res<crate::db::worktrees::Worktree> {
    let worktree = studio.db.get_worktree(&id).map_err(e)?;
    let repo = repo_for_project(&studio, &worktree.project_id).await?;
    let branch = wt::repair(&repo, &path).await.map_err(e)?;
    studio.db.update_worktree_location(&id, &path, branch.as_deref()).map_err(e)?;
    studio.db.get_worktree(&id).map_err(e)
}

#[tauri::command]
pub async fn worktree_integration(studio: S<'_>, id: String) -> Res<wt::Integration> {
    let worktree = studio.db.get_worktree(&id).map_err(e)?;
    let repo = repo_for_project(&studio, &worktree.project_id).await?;
    wt::integration(&repo, &worktree.path).await.map_err(e)
}

// ---------- Context Engine 2.0 (1.0.11) ----------

#[tauri::command]
pub fn memory_list(studio: S<'_>, conversation_id: String, include_archived: Option<bool>) -> Res<Vec<crate::db::memory::Memory>> {
    studio.db.list_memories(&conversation_id, include_archived.unwrap_or(true)).map_err(e)
}

#[tauri::command]
pub fn memory_save(studio: S<'_>, input: crate::db::memory::MemoryInput) -> Res<crate::db::memory::Memory> {
    studio.db.save_memory(&input).map_err(e)
}

#[tauri::command]
pub fn memory_archive(studio: S<'_>, id: String, archived: bool) -> Res<crate::db::memory::Memory> {
    studio.db.set_memory_archived(&id, archived).map_err(e)
}

#[tauri::command]
pub fn memory_delete(studio: S<'_>, id: String) -> Res<()> {
    studio.db.delete_memory(&id).map_err(e)
}

#[tauri::command]
pub fn memory_history(studio: S<'_>, id: String) -> Res<Value> {
    let memory = studio.db.get_memory(&id).map_err(e)?;
    // Origen: los mensajes citados, resumidos (el texto original sigue en el historial).
    let sources: Vec<Value> = memory.source_messages.iter().filter_map(|mid| studio.db.get_message(mid).ok())
        .filter(|m| m.conversation_id == memory.conversation_id)
        .map(|m| json!({
            "id": m.id, "seq": m.seq, "role": m.role, "agent": m.agent, "model": m.model, "createdAt": m.created_at,
            "excerpt": crate::util::clip_middle(&m.content, 600),
        })).collect();
    Ok(json!({ "memory": memory, "revisions": studio.db.memory_revisions(&id).map_err(e)?, "sources": sources }))
}

#[tauri::command]
pub fn memory_import(
    studio: S<'_>, conversation_id: String, source_message_id: String,
    items: Vec<crate::db::memory::ProposedMemory>, archive: Vec<String>,
) -> Res<Vec<crate::db::memory::Memory>> {
    studio.db.import_memories(&conversation_id, &source_message_id, &items, &archive).map_err(e)
}

#[tauri::command]
pub fn set_context_prefs(studio: S<'_>, conversation_id: String, prefs: Value) -> Res<Value> {
    let current = studio.db.get_conversation(&conversation_id).map_err(e)?.context_prefs;
    let mut next = if current.is_object() { current } else { json!({}) };
    match &prefs["mode"] {
        // Sin modo propio: la conversación sigue el ajuste global. Lo demás se conserva.
        Value::Null => { next.as_object_mut().map(|o| o.remove("mode")); }
        mode => {
            serde_json::from_value::<crate::agents::context::Mode>(mode.clone()).map_err(|_| "Modo de transferencia no válido.".to_string())?;
            next["mode"] = mode.clone();
        }
    }
    for key in ["memories", "messages"] {
        if let Some(list) = prefs.get(key).filter(|v| v.is_array()) {
            next[key] = list.clone();
        }
    }
    studio.db.set_context_prefs(&conversation_id, &next).map_err(e)?;
    Ok(next)
}

#[tauri::command]
pub async fn context_status(studio: S<'_>, conversation_id: String, agent: String, include_block: Option<bool>) -> Res<Value> {
    let studio = studio.inner().clone();
    tauri::async_runtime::spawn_blocking(move || studio.context_status(&conversation_id, &agent, include_block.unwrap_or(false)))
        .await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub async fn compact_native(studio: S<'_>, conversation_id: String, agent: String) -> Res<()> {
    let studio = studio.inner().clone();
    studio.compact_native(&conversation_id, &agent).await.map_err(e)
}

// ---------- Session Manager (1.0.11, fase 3) ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRequest {
    conversation_id: String,
    message_id: String,
    /// `fork` (desde aquí, inclusive), `edit` (antes del mensaje editado) o `regenerate` (antes del
    /// mensaje del usuario que originó la respuesta).
    purpose: String,
    /// `same` (predeterminado), `main` (directorio principal) o el id de un worktree activo.
    #[serde(default)]
    space: Option<String>,
    /// Texto editado (solo `edit`). Se guarda como borrador: nada se envía ni consume créditos.
    #[serde(default)]
    text: Option<String>,
}

/// Adjuntos que se pueden volver a enviar: archivos que siguen existiendo (las referencias del
/// proyecto se recalculan a partir del texto al enviar).
fn reusable_attachments(message: &crate::db::Message) -> Vec<String> {
    message.attachments.as_array().into_iter().flatten()
        .filter(|a| a["projectReference"] != true)
        .filter_map(|a| a["path"].as_str())
        .filter(|p| std::path::Path::new(p).is_file())
        .map(str::to_owned)
        .collect()
}

fn fork_now(studio: &Studio, req: ForkRequest) -> anyhow::Result<Value> {
    use crate::db::sessions::{ForkSpec, Space};
    let db = &studio.db;
    let message = db.get_message(&req.message_id)?;
    if message.conversation_id != req.conversation_id {
        anyhow::bail!("El mensaje no pertenece a esta conversación.");
    }
    let history = db.list_messages(&req.conversation_id)?;
    // Punto de corte, borrador y agente sugerido según el tipo de bifurcación.
    let (cut, draft, files, agent) = match req.purpose.as_str() {
        "fork" => (message.seq, String::new(), vec![], None),
        "edit" | "regenerate" => {
            let prompt = if message.role == "user" {
                message.clone()
            } else {
                history.iter().rev().find(|m| m.role == "user" && m.seq < message.seq).cloned()
                    .ok_or_else(|| anyhow::anyhow!("No se encontró el mensaje del usuario de esta respuesta."))?
            };
            if req.purpose == "edit" && message.role != "user" {
                anyhow::bail!("Solo se pueden editar mensajes del usuario.");
            }
            let text = match (&req.purpose[..], &req.text) {
                ("edit", Some(text)) => text.clone(),
                _ => prompt.content.clone(),
            };
            let agent = (message.role == "assistant").then(|| message.agent.clone()).flatten();
            (prompt.seq - 1, text, reusable_attachments(&prompt), agent)
        }
        _ => anyhow::bail!("Tipo de bifurcación no admitido."),
    };
    let source = db.get_conversation(&req.conversation_id)?;
    let space = match req.space.as_deref() {
        None | Some("same") => Space::Same,
        Some("main") => Space::Other(None),
        Some(id) => Space::Other(Some(id.to_owned())),
    };
    let target_root = match &space {
        Space::Same => db.conversation_root(&source.id)?,
        Space::Other(None) => db.get_project(&source.project_id)?.path,
        Space::Other(Some(id)) => db.space_root(id)?,
    };
    if !std::path::Path::new(&target_root).is_dir() {
        anyhow::bail!("La carpeta de destino no existe: {target_root}");
    }
    let source_root = db.conversation_root(&source.id).unwrap_or_default();
    let normalize = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    let conv = db.fork_conversation(&ForkSpec {
        source: &source.id, cut_seq: cut.max(0), purpose: &req.purpose, from_message: &message.id, space,
        same_root: normalize(&source_root) == normalize(&target_root), draft: &draft, draft_attachments: &files,
    })?;
    // Regenerar con el mismo agente por defecto; el usuario puede cambiarlo en el compositor.
    let conv = match agent {
        Some(agent) => {
            let pref = &conv.agent_prefs[&agent];
            db.set_conversation_prefs(&conv.id, &agent, pref["model"].as_str().unwrap_or_default(), pref["effort"].as_str())?;
            db.get_conversation(&conv.id)?
        }
        None => conv,
    };
    Ok(serde_json::to_value(conv)?)
}

#[tauri::command]
pub async fn fork_conversation(studio: S<'_>, request: ForkRequest) -> Res<Value> {
    let studio = studio.inner().clone();
    tauri::async_runtime::spawn_blocking(move || fork_now(&studio, request)).await.map_err(e)?.map_err(e)
}

#[tauri::command]
pub fn set_conversation_pinned(studio: S<'_>, id: String, pinned: bool) -> Res<Value> {
    studio.db.set_conversation_pinned(&id, pinned).map_err(e)?;
    Ok(serde_json::to_value(studio.db.get_conversation(&id).map_err(e)?).unwrap())
}

#[tauri::command]
pub fn set_conversation_archived(studio: S<'_>, id: String, archived: bool) -> Res<Value> {
    studio.db.set_conversation_archived(&id, archived).map_err(e)?;
    Ok(serde_json::to_value(studio.db.get_conversation(&id).map_err(e)?).unwrap())
}

#[tauri::command]
pub async fn import_list(studio: S<'_>, target: crate::importer::ImportTarget, query: Option<String>, cursor: Option<String>) -> Res<Value> {
    let studio = studio.inner().clone();
    studio.import_list(target, query.unwrap_or_default(), cursor).await.map_err(e)
}

#[tauri::command]
pub async fn import_preview(studio: S<'_>, target: crate::importer::ImportTarget, session_id: String) -> Res<Value> {
    let studio = studio.inner().clone();
    studio.import_preview(target, session_id).await.map_err(e)
}

#[tauri::command]
pub async fn import_sessions(
    studio: S<'_>, target: crate::importer::ImportTarget, project_id: String, worktree_id: Option<String>, sessions: Vec<String>, native: bool,
) -> Res<Value> {
    let studio = studio.inner().clone();
    studio.import_sessions(target, project_id, worktree_id, sessions, native).await.map_err(e)
}
