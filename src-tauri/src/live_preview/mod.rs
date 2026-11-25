//! Live Preview (1.0.9): navegador de desarrollo integrado en Workbench.
//!
//! Seguridad (ver `docs/live-preview.md`):
//! - Cada previsualización es una WebView hija **separada** (`lp-<espacio>`), en un perfil InPrivate
//!   (sin cookies ni almacenamiento compartidos con Duovra), sin capacidades de Tauri: los permisos
//!   (`capabilities/*.json`) se conceden por etiqueta de WebView y `ipc_allowed` rechaza cualquier
//!   comando que no proceda de la interfaz de Duovra.
//! - La página no recibe ningún script de Duovra: consola, red, capturas e inspector usan CDP desde el
//!   host (`cdp.rs`). El único script inicial retira los puentes IPC del contexto de la página.
//! - Navegación: solo http(s); hosts locales libres; hosts externos solo si el usuario los escribe o
//!   los permite explícitamente; nunca los orígenes internos de Tauri. Ventanas nuevas, descargas y
//!   solicitudes de permisos se bloquean y se avisan.

pub mod cdp;
pub mod server;

use crate::agents::Studio;
use anyhow::{anyhow, Result};
use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

const MAX_CONSOLE: usize = 400;
const MAX_NETWORK: usize = 300;
const MAX_ALIVE: usize = 3;
const BAR_HEIGHT: f64 = 46.0;
const CAPTURES_KEPT: usize = 24;
const INSPECTOR_FN: &str = include_str!("inspector.js");

/// Orígenes internos de Tauri/WebView2 a los que una previsualización nunca puede navegar.
const INTERNAL_HOSTS: [&str; 3] = ["tauri.localhost", "ipc.localhost", "asset.localhost"];

/// Eventos CDP suscritos. Sin `Network` no habría tiempos ni estados; no se leen cuerpos ni cabeceras.
const EVENTS: &[&str] = &[
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Log.entryAdded",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Overlay.inspectNodeRequested",
];

/// Comandos que la interfaz puede invocar desde la barra de la ventana independiente.
pub fn ipc_allowed(label: &str, command: &str) -> bool {
    if label == "main" {
        return true;
    }
    label.starts_with("lpbar-") && command.starts_with("live_preview_")
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Nav {
    url: String,
    title: String,
    can_go_back: bool,
    can_go_forward: bool,
    loading: bool,
    /// Error de red de la última navegación del documento principal (`net::ERR_…`), si falló.
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    seq: u64,
    level: String,
    origin: &'static str,
    text: String,
    source: Option<String>,
    line: Option<u64>,
    column: Option<u64>,
    stack: Option<String>,
    time: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetEntry {
    seq: u64,
    #[serde(skip)]
    id: String,
    url: String,
    method: String,
    kind: String,
    status: Option<u16>,
    status_text: Option<String>,
    mime: Option<String>,
    #[serde(skip)]
    started: f64,
    duration_ms: Option<f64>,
    failed: bool,
    error: Option<String>,
    done: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    seq: u64,
    kind: &'static str,
    detail: String,
}

#[derive(Default)]
struct Data {
    nav: Nav,
    console: VecDeque<ConsoleEntry>,
    network: VecDeque<NetEntry>,
    notices: VecDeque<Notice>,
    seq: u64,
    errors: u32,
    warnings: u32,
    failed: u32,
    /// Marco principal de la página y petición de su documento en curso (para detectar fallos de carga).
    main_frame: Option<String>,
    main_request: Option<String>,
}

impl Data {
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
    fn notice(&mut self, kind: &'static str, detail: String) {
        let seq = self.next();
        if self.notices.len() >= 6 {
            self.notices.pop_front();
        }
        self.notices.push_back(Notice { seq, kind, detail });
    }
}

pub struct Preview {
    label: String,
    allowed_hosts: Mutex<HashSet<String>>,
    data: Mutex<Data>,
    detached: AtomicBool,
    inspecting: AtomicBool,
    mobile: AtomicBool,
    selected: Mutex<Option<i64>>,
    /// Último aviso de posición aplicado: las órdenes llegan por hilos distintos y una antigua
    /// (p. ej. «ocultar» de una vista ya sustituida) no debe pisar a una posterior.
    bounds_seq: AtomicU64,
}

#[derive(Default)]
pub struct LivePreview {
    previews: Mutex<HashMap<String, Arc<Preview>>>,
    /// Orden de uso (el último es el más reciente), para no mantener demasiadas WebViews vivas.
    order: Mutex<Vec<String>>,
    pending: Mutex<HashSet<String>>,
    /// Serializa la creación y el cierre de vistas: dos aperturas seguidas, o un cierre mientras
    /// se crea, no pueden dejar WebViews duplicadas ni huérfanas.
    lifecycle: tokio::sync::Mutex<()>,
    generation: AtomicU64,
    pub servers: server::Servers,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// `window.innerWidth` de la interfaz: convierte píxeles CSS (con el zoom de Duovra) en lógicos.
    css_width: f64,
    /// Escala de la página previsualizada (simulación de tamaño). 1 = 100 %.
    zoom: f64,
    /// Simulación de tamaño: la página debe medir exactamente el ancho simulado en píxeles CSS.
    #[serde(default)]
    device: bool,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn cut(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn valid_space(space: &str) -> Result<()> {
    if space.is_empty() || space.len() > 64 || !space.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow!("Espacio no válido."));
    }
    Ok(())
}

pub fn is_local_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if INTERNAL_HOSTS.contains(&host) {
        return false;
    }
    host == "localhost" || host.ends_with(".localhost") || host == "::1" || host == "0.0.0.0"
        || host.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Decide si una navegación de nivel superior puede producirse.
fn navigation_allowed(url: &Url, allowed: &HashSet<String>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    if INTERNAL_HOSTS.contains(&host) {
        return false;
    }
    is_local_host(host) || allowed.contains(host)
}

/// Normaliza una dirección escrita por el usuario. Solo http(s).
pub fn parse_address(input: &str) -> Result<Url> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err(anyhow!("Dirección no válida."));
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("http://{input}") };
    let url = Url::parse(&with_scheme).map_err(|_| anyhow!("Dirección no válida."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(anyhow!("Live Preview solo abre direcciones http o https."));
    }
    if url.host_str().map(|h| INTERNAL_HOSTS.contains(&h)).unwrap_or(false) {
        return Err(anyhow!("Esa dirección pertenece a Duovra y no puede abrirse en Live Preview."));
    }
    Ok(url)
}

/// Oculta credenciales de la URL (usuario:clave@ y parámetros sensibles). Nunca se guardan cabeceras.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else { return cut(raw, 600) };
    if url.scheme() == "data" {
        return cut(raw, 60);
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if url.query().is_some() {
        let sensitive = |k: &str| {
            let k = k.to_ascii_lowercase();
            ["token", "key", "secret", "pass", "auth", "session", "code", "sig", "jwt", "credential", "otp"].iter().any(|s| k.contains(s))
        };
        let pairs: Vec<(String, String)> = url.query_pairs()
            .map(|(k, v)| { let v = if sensitive(&k) { "[redactado]".to_string() } else { v.into_owned() }; (k.into_owned(), v) })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    cut(url.as_str(), 600)
}

fn studio_root(app: &AppHandle, space: &str) -> Result<String> {
    let studio = app.try_state::<Arc<Studio>>().ok_or_else(|| anyhow!("Duovra no está listo."))?;
    studio.db.space_root(space)
}

impl LivePreview {
    fn get(&self, space: &str) -> Option<Arc<Preview>> {
        self.previews.lock().get(space).cloned()
    }

    fn touch(&self, space: &str) {
        let mut order = self.order.lock();
        order.retain(|s| s != space);
        order.push(space.to_string());
    }

    /// Avisa a la interfaz de un cambio (coalescido: como mucho uno cada 150 ms por espacio).
    fn changed(app: &AppHandle, space: &str) {
        let lp = app.state::<LivePreview>();
        if !lp.pending.lock().insert(space.to_string()) {
            return;
        }
        let app = app.clone();
        let space = space.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let lp = app.state::<LivePreview>();
            lp.pending.lock().remove(&space);
            let summary = lp.summary(&space);
            let _ = app.emit_to("main", "live-preview://changed", &summary);
            let _ = app.emit_to(format!("lpbar-{space}").as_str(), "live-preview://changed", &summary);
        });
    }

    fn summary(&self, space: &str) -> Value {
        let server = self.servers.view(space).map(|s| json!({
            "running": s.running, "urls": s.urls, "exitCode": s.exit_code, "command": s.command, "lineCount": s.lines.len(),
        }));
        let Some(p) = self.get(space) else {
            return json!({ "space": space, "alive": false, "server": server });
        };
        let d = p.data.lock();
        json!({
            "space": space,
            "alive": true,
            "nav": d.nav,
            "counts": { "errors": d.errors, "warnings": d.warnings, "failed": d.failed },
            "seq": d.seq,
            "notices": d.notices,
            "detached": p.detached.load(Ordering::SeqCst),
            "inspecting": p.inspecting.load(Ordering::SeqCst),
            "mobile": p.mobile.load(Ordering::SeqCst),
            "server": server,
        })
    }
}

fn webview_of(app: &AppHandle, preview: &Preview) -> Result<Webview> {
    app.get_webview(&preview.label).ok_or_else(|| anyhow!("La vista previa ya no está disponible."))
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn stack_text(trace: Option<&Value>) -> Option<String> {
    let frames = trace?.get("callFrames")?.as_array()?;
    let text = frames.iter().take(6).map(|f| {
        let name = f.get("functionName").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("(anónima)");
        format!("    at {name} ({}:{}:{})", redact_url(f.get("url").and_then(Value::as_str).unwrap_or("")),
            f.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) + 1, f.get("columnNumber").and_then(Value::as_u64).unwrap_or(0) + 1)
    }).collect::<Vec<_>>().join("\n");
    (!text.is_empty()).then_some(text)
}

fn remote_text(arg: &Value) -> String {
    if let Some(v) = arg.get("value") {
        return match v { Value::String(s) => s.clone(), other => other.to_string() };
    }
    if let Some(u) = arg.get("unserializableValue").and_then(Value::as_str) {
        return u.to_string();
    }
    // Vista previa de objetos y arrays que ofrece CDP (sin evaluar nada en la página).
    if let Some(preview) = arg.get("preview") {
        let props = preview.get("properties").and_then(Value::as_array).cloned().unwrap_or_default();
        let array = preview.get("subtype").and_then(Value::as_str) == Some("array");
        let body = props.iter().take(8).map(|p| {
            let value = p.get("value").and_then(Value::as_str).unwrap_or("…");
            let value = if p.get("type").and_then(Value::as_str) == Some("string") { format!("\"{value}\"") } else { value.to_string() };
            if array { value } else { format!("{}: {value}", p.get("name").and_then(Value::as_str).unwrap_or("")) }
        }).collect::<Vec<_>>().join(", ");
        let more = if preview.get("overflow").and_then(Value::as_bool).unwrap_or(false) { ", …" } else { "" };
        return if array { format!("[{body}{more}]") } else { format!("{{{body}{more}}}") };
    }
    arg.get("description").and_then(Value::as_str).map(str::to_string)
        .unwrap_or_else(|| arg.get("type").and_then(Value::as_str).unwrap_or("").to_string())
}

/// Procesa un evento CDP o nativo de la página. Se ejecuta en el hilo de la interfaz: solo actualiza
/// búferes limitados y programa un aviso.
fn on_event(app: &AppHandle, space: &str, preview: &Arc<Preview>, name: &str, params: Value) {
    {
        let mut d = preview.data.lock();
        match name {
            "Runtime.consoleAPICalled" => {
                let kind = params.get("type").and_then(Value::as_str).unwrap_or("log");
                let level = match kind { "error" | "assert" => "error", "warning" => "warn", "info" => "info", "debug" => "debug", _ => "log" };
                let text = params.get("args").and_then(Value::as_array).map(|a| a.iter().map(remote_text).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                let frame = params.get("stackTrace").and_then(|t| t.get("callFrames")).and_then(|f| f.get(0)).cloned();
                push_console(&mut d, level, "console", &text, frame.as_ref(), stack_text(params.get("stackTrace")));
            }
            "Runtime.exceptionThrown" => {
                let details = params.get("exceptionDetails").cloned().unwrap_or(Value::Null);
                let text = details.get("exception").and_then(|e| e.get("description")).and_then(Value::as_str)
                    .map(str::to_string).or_else(|| str_of(&details, "text")).unwrap_or_default();
                let stack = stack_text(details.get("stackTrace"));
                push_console(&mut d, "error", "exception", text.lines().next().unwrap_or(""), Some(&details), stack);
            }
            "Log.entryAdded" => {
                let entry = params.get("entry").cloned().unwrap_or(Value::Null);
                let level = match entry.get("level").and_then(Value::as_str) { Some("error") => "error", Some("warning") => "warn", Some("info") => "info", _ => "debug" };
                let text = str_of(&entry, "text").unwrap_or_default();
                push_console(&mut d, level, "browser", &text, Some(&entry), None);
            }
            "Network.requestWillBeSent" => {
                let id = str_of(&params, "requestId").unwrap_or_default();
                let request = params.get("request").cloned().unwrap_or(Value::Null);
                let url = redact_url(&str_of(&request, "url").unwrap_or_default());
                let started = params.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
                // Nueva navegación del documento principal (no iframes): la lista empieza de nuevo,
                // como en las herramientas de Chromium, incluida la petición del propio documento.
                let top_document = params.get("type").and_then(Value::as_str) == Some("Document")
                    && params.get("initiator").and_then(|i| i.get("type")).and_then(Value::as_str) == Some("other")
                    && params.get("redirectResponse").is_none();
                if top_document {
                    d.network.clear();
                    d.failed = 0;
                }
                // Navegación del documento del marco principal (por cualquier vía: dirección,
                // enlace, script o recarga): el error de carga anterior deja de aplicarse.
                let navigation = params.get("type").and_then(Value::as_str) == Some("Document")
                    && str_of(&params, "loaderId").as_deref() == Some(id.as_str())
                    && d.main_frame.is_some() && str_of(&params, "frameId") == d.main_frame;
                if navigation {
                    d.main_request = Some(id.clone());
                    d.nav.error = None;
                }
                if let Some(e) = d.network.iter_mut().rev().find(|e| e.id == id) {
                    // Redirección: la misma petición continúa en otra URL.
                    e.url = url;
                    e.status = params.get("redirectResponse").and_then(|r| r.get("status")).and_then(Value::as_u64).map(|s| s as u16);
                } else {
                    let seq = d.next();
                    if d.network.len() >= MAX_NETWORK { d.network.pop_front(); }
                    d.network.push_back(NetEntry {
                        seq, id, url, method: str_of(&request, "method").unwrap_or_else(|| "GET".into()),
                        kind: str_of(&params, "type").unwrap_or_else(|| "Other".into()), status: None, status_text: None,
                        mime: None, started, duration_ms: None, failed: false, error: None, done: false,
                    });
                }
            }
            "Network.responseReceived" => {
                let id = str_of(&params, "requestId").unwrap_or_default();
                let response = params.get("response").cloned().unwrap_or(Value::Null);
                let mut bad = false;
                if let Some(e) = d.network.iter_mut().rev().find(|e| e.id == id) {
                    let status = response.get("status").and_then(Value::as_u64).map(|s| s as u16);
                    e.status = status;
                    e.status_text = str_of(&response, "statusText").map(|s| cut(&s, 80));
                    e.mime = str_of(&response, "mimeType").map(|s| cut(&s, 80));
                    if let Some(kind) = str_of(&params, "type") { e.kind = kind; }
                    bad = status.map(|s| s >= 400).unwrap_or(false) && !e.failed;
                    if bad { e.failed = true; }
                }
                if bad { d.failed += 1; }
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                let id = str_of(&params, "requestId").unwrap_or_default();
                let end = params.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
                let failed = name == "Network.loadingFailed";
                let mut newly_failed = false;
                if let Some(e) = d.network.iter_mut().rev().find(|e| e.id == id) {
                    e.done = true;
                    if e.started > 0.0 && end >= e.started { e.duration_ms = Some(((end - e.started) * 1000.0 * 10.0).round() / 10.0); }
                    if failed {
                        let canceled = params.get("canceled").and_then(Value::as_bool).unwrap_or(false);
                        e.error = str_of(&params, "errorText").map(|s| cut(&s, 160));
                        if !canceled && !e.failed { e.failed = true; newly_failed = true; }
                    }
                }
                if newly_failed { d.failed += 1; }
                if failed && d.main_request.as_deref() == Some(id.as_str()) {
                    d.main_request = None;
                    let canceled = params.get("canceled").and_then(Value::as_bool).unwrap_or(false);
                    let text = str_of(&params, "errorText").unwrap_or_default();
                    // ERR_ABORTED: la propia navegación se sustituyó (otra dirección, detener, descarga).
                    if !canceled && text != "net::ERR_ABORTED" {
                        d.nav.error = Some(cut(&text, 80));
                        d.nav.loading = false;
                    }
                }
            }
            "Duovra.history" => {
                if let Some(url) = params.get("url").and_then(Value::as_str) { d.nav.url = url.to_string(); }
                if let Some(title) = params.get("title").and_then(Value::as_str) { d.nav.title = cut(title, 200); }
                d.nav.can_go_back = params.get("canGoBack").and_then(Value::as_bool).unwrap_or(false);
                d.nav.can_go_forward = params.get("canGoForward").and_then(Value::as_bool).unwrap_or(false);
            }
            "Duovra.permission" => {
                let kind = str_of(&params, "kind").unwrap_or_default();
                d.notice("permission", kind);
            }
            "Overlay.inspectNodeRequested" => {
                drop(d);
                if let Some(node) = params.get("backendNodeId").and_then(Value::as_i64) {
                    preview.inspecting.store(false, Ordering::SeqCst);
                    let app = app.clone();
                    let space = space.to_string();
                    tauri::async_runtime::spawn(async move {
                        let result = select_node(&app, &space, node).await;
                        if let Err(e) = result {
                            let _ = app.emit_to("main", "live-preview://element", json!({ "space": space, "error": e.to_string() }));
                        }
                    });
                }
                LivePreview::changed(app, space);
                return;
            }
            _ => return,
        }
    }
    LivePreview::changed(app, space);
}

fn push_console(d: &mut Data, level: &str, origin: &'static str, text: &str, frame: Option<&Value>, stack: Option<String>) {
    let seq = d.next();
    if d.console.len() >= MAX_CONSOLE {
        if let Some(old) = d.console.pop_front() {
            match old.level.as_str() { "error" => d.errors = d.errors.saturating_sub(1), "warn" => d.warnings = d.warnings.saturating_sub(1), _ => {} }
        }
    }
    match level { "error" => d.errors += 1, "warn" => d.warnings += 1, _ => {} }
    let source = frame.and_then(|f| f.get("url")).and_then(Value::as_str).filter(|u| !u.is_empty()).map(redact_url);
    let line = frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_u64);
    // CDP numera líneas y columnas desde 0 en marcos de pila y excepciones; Log.entryAdded ya viene en base 1.
    let zero_based = origin != "browser";
    d.console.push_back(ConsoleEntry {
        seq, level: level.into(), origin, text: cut(text, 4000), source,
        line: line.map(|l| if zero_based { l + 1 } else { l }),
        column: frame.and_then(|f| f.get("columnNumber")).and_then(Value::as_u64).map(|c| if zero_based { c + 1 } else { c }),
        stack, time: now(),
    });
}

fn ratio(app: &AppHandle, b: &Bounds) -> Result<f64> {
    let window = app.get_window("main").ok_or_else(|| anyhow!("Ventana principal no disponible."))?;
    let scale = window.scale_factor()?;
    let inner = window.inner_size()?.to_logical::<f64>(scale);
    Ok(if b.css_width > 0.0 { inner.width / b.css_width } else { 1.0 })
}

/// Zoom de la página: 1 al ocupar el hueco; con simulación, el ancho CSS de la página coincide con
/// el del dispositivo aunque Duovra tenga otra escala de interfaz.
fn page_zoom(app: &AppHandle, b: &Bounds) -> f64 {
    if !b.device {
        return 1.0;
    }
    (b.zoom * ratio(app, b).unwrap_or(1.0)).clamp(0.1, 3.0)
}

fn logical_bounds(app: &AppHandle, b: &Bounds) -> Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let ratio = ratio(app, b)?;
    Ok((
        LogicalPosition::new((b.x * ratio).round(), (b.y * ratio).round()),
        LogicalSize::new((b.width * ratio).round().max(1.0), (b.height * ratio).round().max(1.0)),
    ))
}

/// Script inicial de la página: retira los puentes IPC del contexto de la página. Las órdenes no
/// pasarían igualmente (capacidades y `ipc_allowed`), pero así la página ni siquiera puede enviarlas.
const PAGE_GUARD: &str = r#"
;(() => {
  try { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: undefined, configurable: false, writable: false }); } catch (_) {}
  try { if (window.chrome && window.chrome.webview) Object.defineProperty(window.chrome, 'webview', { value: undefined, configurable: false, writable: false }); } catch (_) {}
})();
"#;

async fn create(app: &AppHandle, space: &str, bounds: &Bounds) -> Result<Arc<Preview>> {
    let lp = app.state::<LivePreview>();
    // Límite de WebViews vivas: se libera la menos reciente que no esté a la vista.
    let evict: Vec<String> = {
        let order = lp.order.lock();
        let alive = lp.previews.lock();
        let mut candidates: Vec<String> = order.iter().filter(|s| alive.contains_key(*s) && s.as_str() != space).cloned().collect();
        let excess = (alive.len() + 1).saturating_sub(MAX_ALIVE);
        candidates.retain(|s| !alive.get(s).map(|p| p.detached.load(Ordering::SeqCst)).unwrap_or(true));
        candidates.into_iter().take(excess).collect()
    };
    for old in evict {
        destroy(app, &old);
        // Sin este aviso, la interfaz de ese espacio seguiría creyendo que su página existe y
        // mostraría un hueco vacío al volver a él.
        LivePreview::changed(app, &old);
    }

    // Etiqueta única por creación: cerrar y volver a abrir enseguida no choca con la WebView
    // anterior, cuyo cierre nativo puede no haber terminado todavía.
    let generation = lp.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let preview = Arc::new(Preview {
        label: format!("lp-{space}-{generation}"),
        allowed_hosts: Mutex::new(HashSet::new()),
        data: Mutex::new(Data::default()),
        detached: AtomicBool::new(false),
        inspecting: AtomicBool::new(false),
        mobile: AtomicBool::new(false),
        selected: Mutex::new(None),
        bounds_seq: AtomicU64::new(0),
    });
    let (position, size) = logical_bounds(app, bounds)?;
    let window = app.get_window("main").ok_or_else(|| anyhow!("Ventana principal no disponible."))?;

    let nav_preview = preview.clone();
    let nav_app = app.clone();
    let nav_space = space.to_string();
    let win_preview = preview.clone();
    let win_app = app.clone();
    let win_space = space.to_string();
    let dl_preview = preview.clone();
    let dl_space = space.to_string();
    let load_preview = preview.clone();
    let load_space = space.to_string();
    let title_preview = preview.clone();
    let title_space = space.to_string();

    let builder = WebviewBuilder::new(&preview.label, WebviewUrl::External("about:blank".parse()?))
        .incognito(true)
        .zoom_hotkeys_enabled(false)
        .disable_drag_drop_handler()
        .background_color(tauri::window::Color(20, 21, 26, 255))
        .initialization_script_for_all_frames(PAGE_GUARD)
        .on_navigation(move |url| {
            let allowed = navigation_allowed(url, &nav_preview.allowed_hosts.lock());
            if !allowed {
                nav_preview.data.lock().notice("navigation", cut(url.as_str(), 600));
                LivePreview::changed(&nav_app, &nav_space);
            }
            allowed
        })
        .on_new_window(move |url, _| {
            // Nunca se crean ventanas ni se navega por iniciativa de la página: se avisa y el
            // usuario decide (abrir aquí o en el navegador).
            win_preview.data.lock().notice("popup", cut(url.as_str(), 600));
            LivePreview::changed(&win_app, &win_space);
            NewWindowResponse::Deny
        })
        .on_download(move |webview, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                dl_preview.data.lock().notice("download", redact_url(url.as_str()));
                LivePreview::changed(webview.app_handle(), &dl_space);
            }
            false
        })
        .on_page_load(move |webview, payload| {
            let app = webview.app_handle().clone();
            {
                let mut d = load_preview.data.lock();
                match payload.event() {
                    PageLoadEvent::Started => {
                        d.nav.loading = true;
                        d.nav.url = payload.url().to_string();
                    }
                    PageLoadEvent::Finished => d.nav.loading = false,
                }
            }
            let preview = load_preview.clone();
            let space = load_space.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(webview) = webview_of(&app, &preview) {
                    if let Ok(state) = cdp::nav(&webview).await {
                        on_event(&app, &space, &preview, "Duovra.history", state);
                        return;
                    }
                }
                LivePreview::changed(&app, &space);
            });
        })
        .on_document_title_changed(move |webview, title| {
            title_preview.data.lock().nav.title = cut(&title, 200);
            LivePreview::changed(webview.app_handle(), &title_space);
        });

    let webview = window.add_child(builder, position, size)?;
    // Nace oculta: solo la muestra la interfaz cuando su hueco está a la vista. Si mientras tanto se
    // cambió de pestaña o de worktree, o se abrió un diálogo, no aparece encima de nada.
    let _ = webview.hide();
    let zoom = page_zoom(app, bounds);
    if (zoom - 1.0).abs() > 0.001 {
        let _ = webview.set_zoom(zoom);
    }
    if let Err(e) = attach_devtools(app, space, &preview, &webview).await {
        let _ = webview.close();
        return Err(e);
    }
    lp.previews.lock().insert(space.to_string(), preview.clone());
    Ok(preview)
}

async fn attach_devtools(app: &AppHandle, space: &str, preview: &Arc<Preview>, webview: &Webview) -> Result<()> {
    let sink_app = app.clone();
    let sink_space = space.to_string();
    let sink_preview = preview.clone();
    cdp::subscribe(webview, EVENTS, Arc::new(move |name, params| on_event(&sink_app, &sink_space, &sink_preview, name, params)))?;
    for (method, params) in [
        ("Runtime.enable", json!({})),
        ("Log.enable", json!({})),
        // Búfer mínimo: Duovra nunca lee cuerpos de respuesta.
        ("Network.enable", json!({ "maxTotalBufferSize": 0, "maxResourceBufferSize": 0, "maxPostDataSize": 0 })),
        ("Page.enable", json!({})),
    ] {
        cdp::call(webview, method, params).await?;
    }
    let tree = cdp::call(webview, "Page.getFrameTree", json!({})).await?;
    let frame = tree.get("frameTree").and_then(|t| t.get("frame")).and_then(|f| f.get("id")).and_then(Value::as_str).map(str::to_string);
    preview.data.lock().main_frame = frame;
    Ok(())
}

fn destroy(app: &AppHandle, space: &str) {
    let lp = app.state::<LivePreview>();
    let Some(preview) = lp.previews.lock().remove(space) else { return };
    lp.order.lock().retain(|s| s != space);
    if let Some(webview) = app.get_webview(&preview.label) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_window(&format!("lpw-{space}")) {
        let _ = window.destroy();
    }
}

/// Cierra todas las ventanas independientes (al cerrar la ventana principal).
pub fn close_all(app: &AppHandle) {
    let spaces: Vec<String> = app.state::<LivePreview>().previews.lock().keys().cloned().collect();
    for space in spaces {
        destroy(app, &space);
    }
}

async fn ensure(app: &AppHandle, space: &str, bounds: &Bounds) -> Result<Arc<Preview>> {
    let lp = app.state::<LivePreview>();
    lp.touch(space);
    if let Some(p) = lp.get(space) {
        if app.get_webview(&p.label).is_some() {
            return Ok(p);
        }
        lp.previews.lock().remove(space);
    }
    create(app, space, bounds).await
}

fn preview_of(app: &AppHandle, space: &str) -> Result<(Arc<Preview>, Webview)> {
    valid_space(space)?;
    let preview = app.state::<LivePreview>().get(space).ok_or_else(|| anyhow!("Abre primero la vista previa."))?;
    let webview = webview_of(app, &preview)?;
    Ok((preview, webview))
}

// ---------------------------------------------------------------------------------------------
// Comandos

type Res<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn live_preview_open(app: AppHandle, space: String, url: String, external: bool, bounds: Bounds) -> Res<Value> {
    valid_space(&space).map_err(err)?;
    let url = parse_address(&url).map_err(err)?;
    let host = url.host_str().unwrap_or_default().to_string();
    let local = is_local_host(&host);
    // Antes de crear nada: un sitio externo sin confirmar no deja una WebView a medio abrir encima
    // del diálogo de confirmación.
    if !local && !external {
        return Err(format!("EXTERNAL:{host}"));
    }
    let lp = app.state::<LivePreview>();
    let _guard = lp.lifecycle.lock().await;
    let preview = ensure(&app, &space, &bounds).await.map_err(err)?;
    if !local {
        preview.allowed_hosts.lock().insert(host);
    }
    let webview = webview_of(&app, &preview).map_err(err)?;
    webview.navigate(url).map_err(err)?;
    Ok(app.state::<LivePreview>().summary(&space))
}

/// Coloca la vista sobre el hueco de Workbench, o la oculta (`bounds: null`).
#[tauri::command]
pub async fn live_preview_bounds(app: AppHandle, space: String, bounds: Option<Bounds>, seq: Option<u64>) -> Res<()> {
    valid_space(&space).map_err(err)?;
    let Some(preview) = app.state::<LivePreview>().get(&space) else { return Ok(()) };
    if preview.detached.load(Ordering::SeqCst) {
        return Ok(());
    }
    // Las órdenes async pueden llegar desordenadas: se descarta la que ya fue superada.
    if let Some(seq) = seq {
        if preview.bounds_seq.fetch_max(seq, Ordering::SeqCst) > seq {
            return Ok(());
        }
    }
    let webview = webview_of(&app, &preview).map_err(err)?;
    match bounds {
        None => webview.hide().map_err(err)?,
        Some(b) => {
            let (position, size) = logical_bounds(&app, &b).map_err(err)?;
            webview.set_bounds(tauri::Rect { position: position.into(), size: size.into() }).map_err(err)?;
            webview.set_zoom(page_zoom(&app, &b)).map_err(err)?;
            webview.show().map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn live_preview_action(app: AppHandle, space: String, action: String) -> Res<()> {
    let (_, webview) = preview_of(&app, &space).map_err(err)?;
    match action.as_str() {
        "reload" => webview.reload().map_err(err),
        "back" | "forward" | "stop" => cdp::history(&webview, &action).map_err(err),
        _ => Err("Acción no válida.".into()),
    }
}

/// Permite una navegación que Duovra bloqueó (redirección a un sitio externo) y la abre.
#[tauri::command]
pub async fn live_preview_allow(app: AppHandle, space: String, url: String) -> Res<()> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    let url = parse_address(&url).map_err(err)?;
    if let Some(host) = url.host_str() {
        preview.allowed_hosts.lock().insert(host.to_string());
    }
    webview.navigate(url).map_err(err)
}

#[tauri::command]
pub async fn live_preview_close(app: AppHandle, space: String) -> Res<()> {
    valid_space(&space).map_err(err)?;
    let lp = app.state::<LivePreview>();
    let _guard = lp.lifecycle.lock().await;
    destroy(&app, &space);
    app.state::<LivePreview>().servers.forget(&space);
    LivePreview::changed(&app, &space);
    Ok(())
}

#[tauri::command]
pub fn live_preview_state(app: AppHandle, space: String) -> Res<Value> {
    valid_space(&space).map_err(err)?;
    Ok(app.state::<LivePreview>().summary(&space))
}

#[tauri::command]
pub fn live_preview_console(app: AppHandle, space: String) -> Res<Vec<ConsoleEntry>> {
    let preview = app.state::<LivePreview>().get(&space);
    Ok(preview.map(|p| p.data.lock().console.iter().cloned().collect()).unwrap_or_default())
}

#[tauri::command]
pub fn live_preview_network(app: AppHandle, space: String) -> Res<Vec<NetEntry>> {
    let preview = app.state::<LivePreview>().get(&space);
    Ok(preview.map(|p| p.data.lock().network.iter().cloned().collect()).unwrap_or_default())
}

#[tauri::command]
pub fn live_preview_clear(app: AppHandle, space: String, what: String) -> Res<()> {
    if let Some(p) = app.state::<LivePreview>().get(&space) {
        let mut d = p.data.lock();
        match what.as_str() {
            "console" => { d.console.clear(); d.errors = 0; d.warnings = 0; }
            "network" => { d.network.clear(); d.failed = 0; }
            "notices" => d.notices.clear(),
            _ => {}
        }
    }
    LivePreview::changed(&app, &space);
    Ok(())
}

const HIGHLIGHT: &str = r#"{"showInfo":true,"showStyles":false,"showAccessibilityInfo":false,"contentColor":{"r":183,"g":240,"b":64,"a":0.18},"paddingColor":{"r":183,"g":240,"b":64,"a":0.08},"borderColor":{"r":183,"g":240,"b":64,"a":0.9},"marginColor":{"r":255,"g":255,"b":255,"a":0.06}}"#;

fn highlight() -> Value {
    serde_json::from_str(HIGHLIGHT).unwrap_or(Value::Null)
}

/// Activa o desactiva el modo de selección visual (resaltado nativo de Chromium).
#[tauri::command]
pub async fn live_preview_inspect(app: AppHandle, space: String, on: bool) -> Res<()> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    if on {
        cdp::call(&webview, "DOM.enable", json!({})).await.map_err(err)?;
        cdp::call(&webview, "Overlay.enable", json!({})).await.map_err(err)?;
        cdp::call(&webview, "Overlay.setInspectMode", json!({ "mode": "searchForNode", "highlightConfig": highlight() })).await.map_err(err)?;
        let _ = webview.set_focus();
    } else {
        let _ = cdp::call(&webview, "Overlay.setInspectMode", json!({ "mode": "none", "highlightConfig": highlight() })).await;
        let _ = cdp::call(&webview, "Overlay.hideHighlight", json!({})).await;
        *preview.selected.lock() = None;
    }
    preview.inspecting.store(on, Ordering::SeqCst);
    LivePreview::changed(&app, &space);
    Ok(())
}

async fn describe(webview: &Webview, node: i64) -> Result<Value> {
    let object = cdp::call(webview, "DOM.resolveNode", json!({ "backendNodeId": node })).await?;
    let object_id = object.get("object").and_then(|o| o.get("objectId")).and_then(Value::as_str)
        .ok_or_else(|| anyhow!("El elemento ya no existe en la página."))?.to_string();
    let result = cdp::call(webview, "Runtime.callFunctionOn", json!({
        "objectId": object_id, "functionDeclaration": INSPECTOR_FN, "returnByValue": true, "silent": true,
    })).await?;
    let value = result.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null);
    if value.is_null() {
        return Err(anyhow!("No se pudo leer el elemento."));
    }
    if value.to_string().len() > 96 * 1024 {
        return Err(anyhow!("El resumen del elemento es demasiado grande."));
    }
    let _ = cdp::call(webview, "Runtime.releaseObject", json!({ "objectId": object_id })).await;
    Ok(value)
}

async fn select_node(app: &AppHandle, space: &str, node: i64) -> Result<()> {
    let (preview, webview) = preview_of(app, space)?;
    let _ = cdp::call(&webview, "Overlay.setInspectMode", json!({ "mode": "none", "highlightConfig": highlight() })).await;
    let info = describe(&webview, node).await?;
    let _ = cdp::call(&webview, "Overlay.highlightNode", json!({ "highlightConfig": highlight(), "backendNodeId": node })).await;
    *preview.selected.lock() = Some(node);
    let _ = app.emit_to("main", "live-preview://element", json!({ "space": space, "node": node, "info": info }));
    LivePreview::changed(app, space);
    Ok(())
}

/// Selecciona el elemento padre o el primer hijo del actual.
#[tauri::command]
pub async fn live_preview_select_relative(app: AppHandle, space: String, direction: String) -> Res<()> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    let node = preview.selected.lock().ok_or("No hay ningún elemento seleccionado.")?;
    let object = cdp::call(&webview, "DOM.resolveNode", json!({ "backendNodeId": node })).await.map_err(err)?;
    let object_id = object.get("object").and_then(|o| o.get("objectId")).and_then(Value::as_str).ok_or("El elemento ya no existe en la página.")?;
    let function = if direction == "parent" {
        "function(){const p=this.parentElement;return p&&p.tagName!=='HTML'?p:null}"
    } else {
        "function(){return this.firstElementChild}"
    };
    let next = cdp::call(&webview, "Runtime.callFunctionOn", json!({ "objectId": object_id, "functionDeclaration": function, "silent": true })).await.map_err(err)?;
    let next_id = next.get("result").and_then(|r| r.get("objectId")).and_then(Value::as_str).ok_or("No hay más elementos en esa dirección.")?;
    let described = cdp::call(&webview, "DOM.describeNode", json!({ "objectId": next_id })).await.map_err(err)?;
    let backend = described.get("node").and_then(|n| n.get("backendNodeId")).and_then(Value::as_i64).ok_or("No se pudo seleccionar el elemento.")?;
    select_node(&app, &space, backend).await.map_err(err)
}

fn captures_dir(app: &AppHandle, space: &str) -> Result<std::path::PathBuf> {
    let dir = app.path().app_cache_dir()?.join("live-preview").join(space);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Guarda una captura (PNG; JPEG si supera el límite de imágenes incrustadas) con nombre por
/// contenido: la misma imagen no se duplica. Conserva solo las más recientes de cada espacio.
fn store_capture(app: &AppHandle, space: &str, png: Vec<u8>, kind: &str) -> Result<Value> {
    use std::hash::{Hash, Hasher};
    let image = image::load_from_memory(&png).map_err(|_| anyhow!("La captura no es una imagen válida."))?;
    let (width, height) = (image.width(), image.height());
    let (bytes, ext) = if png.len() > 4_500_000 {
        let mut out = std::io::Cursor::new(Vec::new());
        image.to_rgb8().write_to(&mut out, image::ImageFormat::Jpeg)?;
        (out.into_inner(), "jpg")
    } else {
        (png, "png")
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let dir = captures_dir(app, space)?;
    let path = dir.join(format!("{kind}-{:016x}.{ext}", hasher.finish()));
    if !path.exists() {
        std::fs::write(&path, &bytes)?;
    }
    let _ = filetime_touch(&path);
    prune(&dir);
    let mime = if ext == "png" { "image/png" } else { "image/jpeg" };
    Ok(json!({
        "path": path.to_string_lossy(), "width": width, "height": height, "bytes": bytes.len(), "kind": kind,
        "dataUrl": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    }))
}

fn filetime_touch(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new().append(true).open(path)?.set_modified(std::time::SystemTime::now())
}

fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries.flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for (i, (modified, path)) in files.iter().enumerate() {
        if i >= CAPTURES_KEPT || modified.elapsed().map(|e| e > week).unwrap_or(false) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Retira las capturas antiguas de todos los espacios (al iniciar).
pub fn prune_all(app: &AppHandle) {
    if let Ok(root) = app.path().app_cache_dir().map(|d| d.join("live-preview")) {
        if let Ok(entries) = std::fs::read_dir(root) {
            for e in entries.flatten() {
                prune(&e.path());
            }
        }
    }
}

#[tauri::command]
pub async fn live_preview_capture(app: AppHandle, space: String, kind: String) -> Res<Value> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    let _ = cdp::call(&webview, "Overlay.hideHighlight", json!({})).await;
    let params = match kind.as_str() {
        "viewport" => json!({ "format": "png" }),
        "full" => {
            let metrics = cdp::call(&webview, "Page.getLayoutMetrics", json!({})).await.map_err(err)?;
            let size = metrics.get("cssContentSize").cloned().unwrap_or(Value::Null);
            let w = size.get("width").and_then(Value::as_f64).unwrap_or(0.0).clamp(1.0, 4000.0);
            let h = size.get("height").and_then(Value::as_f64).unwrap_or(0.0).clamp(1.0, 12000.0);
            json!({ "format": "png", "captureBeyondViewport": true, "clip": { "x": 0, "y": 0, "width": w, "height": h, "scale": 1 } })
        }
        "element" => {
            let node = preview.selected.lock().ok_or("Selecciona primero un elemento.").map_err(err)?;
            let info = describe(&webview, node).await.map_err(err)?;
            let page = info.get("page").cloned().unwrap_or(Value::Null);
            let num = |k: &str| page.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let (w, h) = (num("width"), num("height"));
            if w < 1.0 || h < 1.0 {
                return Err("El elemento no ocupa espacio visible.".into());
            }
            json!({ "format": "png", "captureBeyondViewport": true,
                "clip": { "x": num("x"), "y": num("y"), "width": w.min(4000.0), "height": h.min(8000.0), "scale": 1 } })
        }
        _ => return Err("Tipo de captura no válido.".into()),
    };
    let shot = cdp::call(&webview, "Page.captureScreenshot", params).await.map_err(err)?;
    let selected = *preview.selected.lock();
    if let Some(node) = selected {
        let _ = cdp::call(&webview, "Overlay.highlightNode", json!({ "highlightConfig": highlight(), "backendNodeId": node })).await;
    }
    let data = shot.get("data").and_then(Value::as_str).ok_or("La página no devolvió la captura.")?;
    let png = base64::engine::general_purpose::STANDARD.decode(data).map_err(err)?;
    store_capture(&app, &space, png, &kind).map_err(err)
}

/// Recorte de una región, hecho en la interfaz sobre una captura previa de la página.
#[tauri::command]
pub fn live_preview_store_region(app: AppHandle, space: String, data: String) -> Res<Value> {
    valid_space(&space).map_err(err)?;
    let raw = data.strip_prefix("data:image/png;base64,").ok_or("Formato de imagen no válido.")?;
    if raw.len() > 30_000_000 {
        return Err("La región es demasiado grande.".into());
    }
    let png = base64::engine::general_purpose::STANDARD.decode(raw).map_err(err)?;
    store_capture(&app, &space, png, "region").map_err(err)
}

/// Copia una captura de Live Preview al destino que el usuario eligió en el diálogo de guardado.
#[tauri::command]
pub fn live_preview_save_capture(app: AppHandle, path: String, destination: String) -> Res<()> {
    let root = app.path().app_cache_dir().map_err(err)?.join("live-preview");
    let source = std::fs::canonicalize(&path).map_err(err)?;
    let root = std::fs::canonicalize(&root).map_err(err)?;
    if !source.starts_with(&root) {
        return Err("Solo se pueden guardar capturas de Live Preview.".into());
    }
    std::fs::copy(source, destination).map_err(err)?;
    Ok(())
}

/// Simulación de dispositivo táctil (agente de usuario móvil + eventos táctiles). Requiere recargar.
#[tauri::command]
pub async fn live_preview_emulate(app: AppHandle, space: String, mobile: bool) -> Res<()> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    const UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    cdp::call(&webview, "Emulation.setTouchEmulationEnabled", json!({ "enabled": mobile, "maxTouchPoints": if mobile { 5 } else { 1 } })).await.map_err(err)?;
    cdp::call(&webview, "Emulation.setEmitTouchEventsForMouse", json!({ "enabled": mobile, "configuration": "mobile" })).await.map_err(err)?;
    cdp::call(&webview, "Emulation.setUserAgentOverride", json!({ "userAgent": if mobile { UA } else { "" } })).await.map_err(err)?;
    preview.mobile.store(mobile, Ordering::SeqCst);
    webview.reload().map_err(err)?;
    LivePreview::changed(&app, &space);
    Ok(())
}

#[tauri::command]
pub fn live_preview_open_external(app: AppHandle, url: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = parse_address(&url).map_err(err)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(err)
}

/// Comprueba si algo escucha en el puerto de una dirección local (sin enviar peticiones HTTP).
#[tauri::command]
pub async fn live_preview_port_open(url: String) -> Res<bool> {
    let url = parse_address(&url).map_err(err)?;
    let host = url.host_str().unwrap_or("localhost").trim_matches(['[', ']']).to_string();
    if !is_local_host(&host) {
        return Ok(false);
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let target = if host == "localhost" || host.ends_with(".localhost") || host == "0.0.0.0" { "127.0.0.1".to_string() } else { host };
    let connect = tokio::net::TcpStream::connect((target.as_str(), port));
    Ok(matches!(tokio::time::timeout(std::time::Duration::from_millis(400), connect).await, Ok(Ok(_))))
}

/// Mueve la vista a una ventana independiente con su barra de navegación (sin recargar la página).
#[tauri::command]
pub async fn live_preview_detach(app: AppHandle, space: String, lang: String) -> Res<()> {
    let (preview, webview) = preview_of(&app, &space).map_err(err)?;
    let label = format!("lpw-{space}");
    if let Some(window) = app.get_window(&label) {
        let _ = window.set_focus();
        return Ok(());
    }
    let title = { let d = preview.data.lock(); if d.nav.title.is_empty() { d.nav.url.clone() } else { d.nav.title.clone() } };
    let mut builder = tauri::window::WindowBuilder::new(&app, &label)
        .title(format!("{} · Live Preview", cut(&title, 80)))
        .inner_size(1120.0, 780.0)
        .min_inner_size(380.0, 320.0)
        .background_color(tauri::window::Color(20, 21, 26, 255));
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).map_err(err)?;
    }
    let window = builder.build().map_err(err)?;
    // La barra es la propia interfaz de Duovra (origen de la aplicación), con permisos limitados a
    // `live_preview_*` (ver `ipc_allowed` y capabilities/live-preview-bar.json).
    let mut bar_url = app.get_webview("main").and_then(|w| w.url().ok()).ok_or("Ventana principal no disponible.")?;
    bar_url.set_path("/");
    bar_url.set_query(Some(&format!("lp={space}&lang={}", if lang == "en" { "en" } else { "es" })));
    bar_url.set_fragment(None);
    let size = window.inner_size().map_err(err)?.to_logical::<f64>(window.scale_factor().map_err(err)?);
    let bar = WebviewBuilder::new(format!("lpbar-{space}"), WebviewUrl::External(bar_url))
        .background_color(tauri::window::Color(20, 21, 26, 255))
        .zoom_hotkeys_enabled(false);
    window.add_child(bar, LogicalPosition::new(0.0, 0.0), LogicalSize::new(size.width, BAR_HEIGHT)).map_err(err)?;
    webview.reparent(&window).map_err(err)?;
    webview.set_bounds(tauri::Rect {
        position: LogicalPosition::new(0.0, BAR_HEIGHT).into(),
        size: LogicalSize::new(size.width, (size.height - BAR_HEIGHT).max(1.0)).into(),
    }).map_err(err)?;
    let _ = webview.set_zoom(1.0);
    webview.show().map_err(err)?;
    preview.detached.store(true, Ordering::SeqCst);

    let event_app = app.clone();
    let event_space = space.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => {
            let app = &event_app;
            let Some(window) = app.get_window(&format!("lpw-{event_space}")) else { return };
            let Ok(scale) = window.scale_factor() else { return };
            let Ok(size) = window.inner_size().map(|s| s.to_logical::<f64>(scale)) else { return };
            if let Some(bar) = app.get_webview(&format!("lpbar-{event_space}")) {
                let _ = bar.set_bounds(tauri::Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(size.width, BAR_HEIGHT).into() });
            }
            let label = app.state::<LivePreview>().get(&event_space).map(|p| p.label.clone());
            if let Some(content) = label.and_then(|l| app.get_webview(&l)) {
                let _ = content.set_bounds(tauri::Rect {
                    position: LogicalPosition::new(0.0, BAR_HEIGHT).into(),
                    size: LogicalSize::new(size.width, (size.height - BAR_HEIGHT).max(1.0)).into(),
                });
            }
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let app = event_app.clone();
            let space = event_space.clone();
            tauri::async_runtime::spawn(async move { let _ = attach(&app, &space); });
        }
        _ => {}
    });
    LivePreview::changed(&app, &space);
    Ok(())
}

fn attach(app: &AppHandle, space: &str) -> Result<()> {
    let lp = app.state::<LivePreview>();
    let preview = lp.get(space).ok_or_else(|| anyhow!("Abre primero la vista previa."))?;
    let main = app.get_window("main").ok_or_else(|| anyhow!("Ventana principal no disponible."))?;
    if let Some(webview) = app.get_webview(&preview.label) {
        webview.reparent(&main)?;
        webview.hide()?;
    }
    preview.detached.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_window(&format!("lpw-{space}")) {
        window.destroy()?;
    }
    LivePreview::changed(app, space);
    Ok(())
}

#[tauri::command]
pub async fn live_preview_attach(app: AppHandle, space: String) -> Res<()> {
    valid_space(&space).map_err(err)?;
    attach(&app, &space).map_err(err)
}

#[tauri::command]
pub async fn live_preview_focus_main(app: AppHandle) -> Res<()> {
    if let Some(window) = app.get_window("main") {
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn live_preview_server(app: AppHandle, space: String) -> Res<Option<server::ServerView>> {
    valid_space(&space).map_err(err)?;
    Ok(app.state::<LivePreview>().servers.view(&space))
}

/// Inicia el comando de desarrollo configurado, en el directorio del espacio. Solo por orden expresa.
#[tauri::command]
pub async fn live_preview_server_start(app: AppHandle, space: String, command: String) -> Res<server::ServerView> {
    valid_space(&space).map_err(err)?;
    let root = studio_root(&app, &space).map_err(err)?;
    let notify_app = app.clone();
    let notify_space = space.clone();
    let lp: State<LivePreview> = app.state();
    let view = lp.servers.start(&space, &root, &command, Arc::new(move || LivePreview::changed(&notify_app, &notify_space))).map_err(err)?;
    LivePreview::changed(&app, &space);
    Ok(view)
}

#[tauri::command]
pub fn live_preview_server_stop(app: AppHandle, space: String) -> Res<()> {
    valid_space(&space).map_err(err)?;
    app.state::<LivePreview>().servers.stop(&space).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_policy_blocks_internal_and_non_http() {
        let none = HashSet::new();
        let ok = |s: &str| navigation_allowed(&Url::parse(s).unwrap(), &none);
        assert!(ok("http://localhost:5173/"));
        assert!(ok("http://127.0.0.1:8080/a"));
        assert!(ok("http://app.localhost:3000/"));
        assert!(ok("about:blank"));
        assert!(!ok("http://tauri.localhost/index.html"));
        assert!(!ok("http://ipc.localhost/bootstrap"));
        assert!(!ok("file:///C:/Windows/win.ini"));
        assert!(!ok("https://example.com/"));
        let mut allowed = HashSet::new();
        allowed.insert("example.com".to_string());
        assert!(navigation_allowed(&Url::parse("https://example.com/x").unwrap(), &allowed));
    }

    #[test]
    fn addresses_are_normalized_and_restricted() {
        assert_eq!(parse_address("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert!(parse_address("file:///etc/passwd").is_err());
        assert!(parse_address("http://tauri.localhost/").is_err());
        assert!(parse_address("javascript:alert(1)").is_err());
    }

    #[test]
    fn urls_are_redacted() {
        let r = redact_url("http://user:pw@localhost:3000/api?token=abc&page=2");
        assert!(!r.contains("abc") && !r.contains("pw") && r.contains("page=2"));
    }

    #[test]
    fn only_main_and_preview_bar_can_invoke() {
        assert!(ipc_allowed("main", "send_message"));
        assert!(ipc_allowed("lpbar-x", "live_preview_action"));
        assert!(!ipc_allowed("lpbar-x", "send_message"));
        assert!(!ipc_allowed("lp-x", "live_preview_action"));
        assert!(!ipc_allowed("lp-x", "bootstrap"));
    }
}
