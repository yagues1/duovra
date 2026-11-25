//! Duovra: backend nativo.
//!
//! Módulos:
//! - `db`: persistencia local (SQLite).
//! - `agents`: capa común de ejecuciones, contexto compartido y adaptadores de proveedor.
//! - `detect`: detección de las CLIs instaladas.
//! - `commands`: API expuesta a la interfaz.

mod agents;
mod backup;
mod background_images;
mod commands;
mod db;
mod detect;
mod distribution;
mod export;
mod live_preview;
mod notify;
mod util;
mod workspace;
mod worktrees;

use std::sync::Arc;
use tauri::Manager;

const RC1_QA_IDENTIFIER: &str = "dev.duovra.studio.rc1.qa";
const BACKGROUND_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.background";
const PATTERN_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern";
const PATTERN_REFINEMENT_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern-refinement";
const PATTERN_REVIEW_QA_IDENTIFIER: &str = "dev.duovra.studio.qa.pattern-review";
const PERSONAL_BETA_IDENTIFIER: &str = "dev.duovra.studio.beta";

/// Fija el tipo del manejador generado para poder envolverlo con la guarda de IPC.
fn typed_handler<F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static>(f: F) -> F {
    f
}

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(distribution::Updates::default())
        .manage(backup::RestoreSelection::default())
        .manage(notify::Delivered::default())
        .manage(live_preview::LivePreview::default())
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
            // El manejador de avisos existe antes de mostrar ninguno: Windows solo informa de los taps registrados.
            notify::register_tap_handler(app.handle());
            live_preview::prune_all(app.handle());
            if let Ok(db) = open() {
                app.manage(agents::Studio::new(app.handle().clone(), Arc::new(db)));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Las ventanas independientes de Live Preview no sobreviven a la principal.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                live_preview::close_all(window.app_handle());
            }
        })
        .invoke_handler({
        let handler = typed_handler(tauri::generate_handler![
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
            commands::set_conversation_permissions,
            commands::discard_empty_conversation,
            commands::worktree_preflight,
            commands::worktree_create,
            commands::worktree_importable,
            commands::worktree_import,
            commands::worktree_rename,
            commands::worktree_status,
            commands::worktree_size,
            commands::worktree_removal_check,
            commands::worktree_remove,
            commands::worktree_repair,
            commands::worktree_integration,
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
            export::export_conversation,
            backup::backup_create,
            backup::backup_pick_restore,
            backup::backup_confirm_restore,
            notify::notify_native,
            distribution::distribution_info,
            distribution::submit_report,
            distribution::check_update,
            distribution::download_update,
            distribution::install_update,
            live_preview::live_preview_open,
            live_preview::live_preview_bounds,
            live_preview::live_preview_action,
            live_preview::live_preview_allow,
            live_preview::live_preview_close,
            live_preview::live_preview_state,
            live_preview::live_preview_console,
            live_preview::live_preview_network,
            live_preview::live_preview_clear,
            live_preview::live_preview_inspect,
            live_preview::live_preview_select_relative,
            live_preview::live_preview_capture,
            live_preview::live_preview_store_region,
            live_preview::live_preview_save_capture,
            live_preview::live_preview_emulate,
            live_preview::live_preview_open_external,
            live_preview::live_preview_port_open,
            live_preview::live_preview_detach,
            live_preview::live_preview_attach,
            live_preview::live_preview_focus_main,
            live_preview::live_preview_server,
            live_preview::live_preview_server_start,
            live_preview::live_preview_server_stop,
        ]);
        // Defensa en profundidad: además de las capacidades por WebView, solo la interfaz de Duovra
        // invoca comandos. Las páginas de Live Preview (`lp-*`) no pueden invocar ninguno.
        move |invoke: tauri::ipc::Invoke| {
            let allowed = live_preview::ipc_allowed(invoke.message.webview_ref().label(), invoke.message.command());
            if !allowed {
                invoke.resolver.reject("Comando no permitido desde esta vista.");
                return true;
            }
            handler(invoke)
        }
        })
        .build(tauri::generate_context!())
        .expect("error al iniciar la aplicación")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(studio) = app.try_state::<Arc<agents::Studio>>() {
                    studio.shutdown();
                }
                if let Some(lp) = app.try_state::<live_preview::LivePreview>() {
                    lp.servers.shutdown();
                }
            }
        });
}
