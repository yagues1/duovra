//! Duovra: backend nativo.
//!
//! Módulos:
//! - `db`: persistencia local (SQLite).
//! - `agents`: capa común de ejecuciones, contexto compartido y adaptadores de proveedor.
//! - `detect`: detección de las CLIs instaladas.
//! - `commands`: API expuesta a la interfaz.

mod agents;
mod commands;
mod db;
mod detect;
mod distribution;
mod util;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(distribution::Updates::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Arc::new(db::Db::open(&dir.join("studio.sqlite3"))?);
            app.manage(agents::Studio::new(app.handle().clone(), db));
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
            commands::set_draft,
            commands::set_conversation_prefs,
            commands::forget_provider_session,
            commands::set_setting,
            commands::detect_agents,
            commands::agent_models,
            commands::agent_account,
            commands::codex_rate_limits,
            commands::start_login,
            commands::usage_summary,
            commands::add_account,
            commands::remove_account,
            commands::send_message,
            commands::cancel_run,
            commands::respond_approval,
            commands::read_file,
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
