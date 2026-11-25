//! Puente con el protocolo de Chrome DevTools (CDP) integrado en WebView2.
//!
//! Live Preview no inyecta scripts en la página para inspeccionarla: consola, red, capturas e
//! inspector visual se obtienen desde el proceso de Duovra con `CallDevToolsProtocolMethod` y
//! `GetDevToolsProtocolEventReceiver`. Es la API oficial del host de WebView2, no abre ningún
//! puerto de depuración y la página no puede interceptarla ni falsificar sus eventos.
//!
//! Todas las llamadas COM se ejecutan en el hilo de la interfaz (`with_webview`).

use anyhow::{anyhow, Result};
use serde_json::Value;
use tauri::Webview;

#[cfg(windows)]
mod imp {
    use super::*;
    use webview2_com::{
        take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
        HistoryChangedEventHandler, Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler,
    };
    use windows::core::{BOOL, HSTRING, PWSTR};

    /// Llama a un método CDP y devuelve su resultado JSON.
    pub async fn call(webview: &Webview, method: &str, params: Value) -> Result<Value> {
        let (tx, rx) = tokio::sync::oneshot::channel::<std::result::Result<String, String>>();
        let method_name = method.to_string();
        let params = params.to_string();
        webview.with_webview(move |platform| unsafe {
            let sent = (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let _ = tx.send(result.map(|_| json).map_err(|e| e.message().to_string()));
                    Ok(())
                }));
                core.CallDevToolsProtocolMethod(&HSTRING::from(method_name), &HSTRING::from(params), &handler)
            })();
            // Si la llamada falla, el manejador se descarta y `rx` informa del error.
            let _ = sent;
        })?;
        let json = tokio::time::timeout(std::time::Duration::from_secs(20), rx)
            .await
            .map_err(|_| anyhow!("La página no respondió a tiempo ({method})."))?
            .map_err(|_| anyhow!("La vista previa ya no está disponible."))?
            .map_err(|e| anyhow!("{method}: {e}"))?;
        Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
    }

    pub type Sink = std::sync::Arc<dyn Fn(&str, Value) + Send + Sync>;

    /// Suscribe eventos CDP, el historial (SPA incluidas) y deniega cualquier solicitud de
    /// permisos de la página (cámara, micrófono, ubicación, notificaciones…), avisando a `sink`.
    pub fn subscribe(webview: &Webview, events: &'static [&'static str], sink: Sink) -> Result<()> {
        webview.with_webview(move |platform| unsafe {
            let _ = (|| -> windows::core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                for name in events {
                    let receiver = core.GetDevToolsProtocolEventReceiver(&HSTRING::from(*name))?;
                    let sink = sink.clone();
                    let mut token = 0i64;
                    receiver.add_DevToolsProtocolEventReceived(
                        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut raw = PWSTR::null();
                            args.ParameterObjectAsJson(&mut raw)?;
                            let json = take_pwstr(raw);
                            sink(name, serde_json::from_str(&json).unwrap_or(Value::Null));
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }
                let history = sink.clone();
                let mut token = 0i64;
                core.add_HistoryChanged(
                    &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                        if let Some(sender) = sender {
                            history("Duovra.history", read_nav(&sender));
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                let permissions = sink.clone();
                core.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        let label = match kind {
                            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
                            COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
                            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "geolocation",
                            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
                            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard",
                            _ => "other",
                        };
                        permissions("Duovra.permission", serde_json::json!({ "kind": label }));
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })();
        })?;
        Ok(())
    }

    unsafe fn read_nav(core: &ICoreWebView2) -> Value {
        let mut url = PWSTR::null();
        let mut title = PWSTR::null();
        let mut back = BOOL::default();
        let mut forward = BOOL::default();
        let _ = core.Source(&mut url);
        let _ = core.DocumentTitle(&mut title);
        let _ = core.CanGoBack(&mut back);
        let _ = core.CanGoForward(&mut forward);
        serde_json::json!({
            "url": take_pwstr(url), "title": take_pwstr(title),
            "canGoBack": back.as_bool(), "canGoForward": forward.as_bool(),
        })
    }

    /// Estado de navegación actual (URL, título, atrás/adelante).
    pub async fn nav(webview: &Webview) -> Result<Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                let _ = tx.send(read_nav(&core));
            }
        })?;
        rx.await.map_err(|_| anyhow!("La vista previa ya no está disponible."))
    }

    /// Atrás, adelante o detener carga con la API nativa de WebView2.
    pub fn history(webview: &Webview, action: &str) -> Result<()> {
        let action = action.to_string();
        webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                let _ = match action.as_str() {
                    "back" => core.GoBack(),
                    "forward" => core.GoForward(),
                    _ => core.Stop(),
                };
            }
        })?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub type Sink = std::sync::Arc<dyn Fn(&str, Value) + Send + Sync>;
    pub async fn call(_: &Webview, method: &str, _: Value) -> Result<Value> {
        Err(anyhow!("{method}: Live Preview solo está disponible en Windows."))
    }
    pub fn subscribe(_: &Webview, _: &'static [&'static str], _: Sink) -> Result<()> {
        Ok(())
    }
    pub async fn nav(_: &Webview) -> Result<Value> {
        Ok(Value::Null)
    }
    pub fn history(webview: &Webview, action: &str) -> Result<()> {
        if action == "back" || action == "forward" {
            webview.eval(if action == "back" { "history.back()" } else { "history.forward()" })?;
        }
        Ok(())
    }
}

pub use imp::*;
