//! Transporte de reportes y actualización firmada desde el proceso nativo.

use std::{sync::Arc, time::Duration};

use reqwest::{redirect, ClientBuilder, Url};
use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use crate::agents::Studio;

const MAX_REPORT_BYTES: usize = 1_500_000;
const BUSY: &str = "Ya hay una operación de actualización en curso.";

fn https_client(client: ClientBuilder) -> ClientBuilder {
    let client = client.https_only(true);
    #[cfg(feature = "qa-loopback")]
    if let Some(certificate) = option_env!("STUDIO_QA_TLS_CERT_PEM") {
        let ca = reqwest::Certificate::from_pem(certificate.as_bytes()).expect("certificado TLS de QA");
        return client.tls_certs_only([ca]).no_proxy();
    }
    client
}

fn report_endpoint() -> Option<Url> {
    let url = Url::parse(option_env!("STUDIO_REPORT_ENDPOINT")?).ok()?;
    (url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty()
        && url.password().is_none() && url.query().is_none() && url.fragment().is_none())
        .then_some(url)
}

fn updater_enabled(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").is_some_and(|config| {
        config["pubkey"].as_str().is_some_and(|key| !key.trim().is_empty())
            && config["endpoints"].as_array().is_some_and(|list| !list.is_empty())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionInfo {
    version: String,
    platform: String,
    reporting_enabled: bool,
    updater_enabled: bool,
}

#[tauri::command]
pub fn distribution_info(app: AppHandle) -> DistributionInfo {
    DistributionInfo {
        version: app.package_info().version.to_string(),
        platform: format!("Windows ({})", std::env::consts::ARCH),
        reporting_enabled: report_endpoint().is_some(),
        updater_enabled: updater_enabled(&app),
    }
}

#[tauri::command]
pub async fn submit_report(report: Value) -> Result<Value, String> {
    let endpoint = report_endpoint().ok_or("El servicio de reportes aún no está configurado.")?;
    let body = serde_json::to_vec(&report).map_err(|_| "El reporte no es válido.")?;
    if body.len() > MAX_REPORT_BYTES {
        return Err("El reporte supera el tamaño permitido.".into());
    }
    let client = https_client(reqwest::Client::builder())
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(32))
        .build()
        .map_err(|_| "No se pudo iniciar la conexión con el servicio.")?;
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "No se recibió confirmación del servicio. Puedes reintentar con el mismo reporte.")?;
    match response.status().as_u16() {
        200 | 201 => response.json().await.map_err(|_| "La confirmación del servicio no es válida.".into()),
        409 => Err("El servicio ya está procesando este identificador. Reintenta más tarde.".into()),
        429 => Err("Se alcanzó el límite de reportes. Inténtalo más tarde.".into()),
        400 | 413 | 415 => Err("El servicio rechazó el contenido o el tamaño del reporte.".into()),
        _ => Err("El servicio no pudo confirmar la creación de la incidencia.".into()),
    }
}

#[derive(Default)]
pub struct Updates(Mutex<Option<Package>>);

struct Package {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
pub struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { received: u64, total: Option<u64> },
    Verifying,
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, Updates>) -> Result<Option<AvailableUpdate>, String> {
    let mut slot = state.0.try_lock().map_err(|_| BUSY)?;
    if !updater_enabled(&app) {
        return Ok(None);
    }
    // El updater también usa este cliente para el instalador y sus redirecciones.
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .configure_client(https_client)
        .build()
        .map_err(|_| "La configuración del canal de actualización no es válida.")?
        .check()
        .await
        .map_err(|_| "No se pudo consultar el canal de actualización.")?;
    let Some(update) = update else {
        *slot = None;
        return Ok(None);
    };
    if update.download_url.scheme() != "https" {
        return Err("El canal devolvió un instalador sin HTTPS.".into());
    }
    let info = AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.as_ref().map(|body| body.chars().take(12_000).collect()),
    };
    *slot = Some(Package { update, bytes: None });
    Ok(Some(info))
}

#[tauri::command]
pub async fn download_update(
    state: State<'_, Updates>,
    version: String,
    events: Channel<DownloadEvent>,
) -> Result<(), String> {
    let mut slot = state.0.try_lock().map_err(|_| BUSY)?;
    let package = slot.as_mut().filter(|p| p.update.version == version)
        .ok_or("Vuelve a comprobar si hay una actualización.")?;
    let mut received = 0u64;
    let mut last_progress = std::time::Instant::now();
    let bytes = package.update.download(
        |length, total| {
            received += length as u64;
            if last_progress.elapsed() >= Duration::from_millis(120) || total == Some(received) {
                let _ = events.send(DownloadEvent::Progress { received, total });
                last_progress = std::time::Instant::now();
            }
        },
        || { let _ = events.send(DownloadEvent::Verifying); },
    ).await.map_err(|error| match error {
        tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_) =>
            "No se pudo descargar el instalador. Comprueba la conexión y reintenta.",
        _ => "No se pudo verificar la firma o la versión del instalador.",
    })?;
    package.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub fn install_update(
    state: State<'_, Updates>,
    studio: State<'_, Arc<Studio>>,
    version: String,
) -> Result<(), String> {
    let slot = state.0.try_lock().map_err(|_| BUSY)?;
    let package = slot.as_ref().filter(|p| p.update.version == version)
        .ok_or("Vuelve a comprobar si hay una actualización.")?;
    let bytes = package.bytes.as_ref().ok_or("Descarga y verifica el instalador primero.")?;
    studio.when_idle_for_update(|| package.update.install(bytes))
        .map_err(|error| error.to_string())?
        .map_err(|_| "No se pudo iniciar el instalador verificado. Puedes reintentar.".into())
}
