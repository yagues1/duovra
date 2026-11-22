//! Duovra: backend nativo.
//!
//! Módulos:
//! - `db`: persistencia local (SQLite).
//! - `agents`: capa común de ejecuciones, contexto compartido y adaptadores de proveedor.
//! - `detect`: detección de las CLIs instaladas.
//! - `commands`: API expuesta a la interfaz.

mod agents;
mod background_images;
mod commands;
mod db;
mod detect;
mod distribution;
mod util;
mod workspace;

use std::sync::Arc;
use tauri::Manager;

const RC1_QA_IDENTIFIER: &str = "dev.duovra.studio.rc1.qa";
const BACKGROUND_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.background";
const PATTERN_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern";
const PATTERN_REFINEMENT_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern-refinement";
const PATTERN_REVIEW_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern-review";
const PERSONAL_BETA_IDENTIFIER: &str = "dev.duovra.studio.beta";

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        // Wry ejecuta sus scripts de inicialización también en subframes de WebView2.
        // Solo el documento principal puede utilizar el transporte nativo. El CSP del
        // visor corta además el transporte HTTP y el sandbox impide scripts del contenido.
        .append_invoke_initialization_script(r#"
            ;if (window !== window.top && window.chrome?.webview) {
                Object.defineProperty(window.chrome, 'webview', {
                    value: undefined, configurable: false, writable: false
                });
            }
        "#)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(distribution::Updates::default())
        .setup(|app| {
            let open = || -> anyhow::Result<db::Db> {
                let mut dir = app.path().app_data_dir()?;
                // La verificación del propio binario de distribución usa un perfil desechable.
                let test_profile = match app.config().identifier.as_str() {
                    RC1_QA_IDENTIFIER => std::env::var("DUOVRA_RC1_TEST_PROFILE").ok(),
                    BACKGROUND_QA_IDENTIFIER => std::env::var("DUOVRA_BACKGROUND_TEST_PROFILE").ok(),
                    PATTERN_QA_IDENTIFIER | PATTERN_REFINEMENT_QA_IDENTIFIER | PATTERN_REVIEW_QA_IDENTIFIER => {
                        std::env::var("DUOVRA_PATTERN_TEST_PROFILE").ok()
                    }
                    PERSONAL_BETA_IDENTIFIER => std::env::var("DUOVRA_BETA_TEST_PROFILE").ok(),
                    _ => None,
                };
                if let Some(profile) = test_profile {
                    let profile = uuid::Uuid::parse_str(&profile)?;
                    dir = dir.join("fixtures").join(profile.to_string());
                }
                std::fs::create_dir_all(&dir)?;
                db::Db::open(&dir.join("studio.sqlite3"))
            };
            if let Ok(db) = open() {
                app.manage(agents::Studio::new(app.handle().clone(), Arc::new(db)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::create_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::list_messages,
            commands::search_conversations,
            commands::set_draft,
            commands::set_draft_attachments,
            commands::set_conversation_prefs,
            commands::forget_provider_session,
            commands::set_setting,
            background_images::background_image_import,
            background_images::background_image_read,
            background_images::background_images_release,
            commands::detect_agents,
            commands::agent_models,
            commands::agent_account,
            commands::codex_rate_limits,
            commands::start_login,
            commands::usage_summary,
            commands::run_insights,
            commands::insights_usage,
            commands::insights_timeline,
            commands::add_account,
            commands::remove_account,
            commands::send_message,
            commands::submit_message,
            commands::message_queue,
            commands::enqueue_message,
            commands::edit_queued_message,
            commands::update_message_queue,
            commands::reconcile_queued_message,
            commands::steer_run,
            commands::cancel_run,
            commands::respond_approval,
            commands::workspace_list,
            commands::workspace_catalog,
            commands::workspace_read,
            commands::workspace_git_status,
            commands::workspace_git_diff,
            commands::inspect_attachments,
            distribution::distribution_info,
            distribution::submit_report,
            distribution::check_update,
            distribution::download_update,
            distribution::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error al iniciar la aplicación")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(studio) = app.try_state::<Arc<agents::Studio>>() {
                    studio.shutdown();
                }
            }
        });
}
