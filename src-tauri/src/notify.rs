//! Notificaciones nativas de Windows con el plugin oficial de Tauri.
//!
//! La interfaz decide cuándo avisar (el usuario no está viendo esa conversación) y este módulo
//! compone el texto. Los avisos nunca incluyen prompts, respuestas, rutas ni errores: solo el
//! agente, el estado y el título de la conversación. Un tap en el aviso trae Duovra al frente y
//! pide a la interfaz que abra esa conversación.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::agents::Studio;

/// Ajuste persistido (Ajustes → Actualizaciones y avisos). Activado por defecto.
pub const SETTING: &str = "notify.native";
/// Evento que recibe la interfaz al pulsar un aviso: `{ conversationId }`.
pub const OPEN_EVENT: &str = "notification-open";
const MAX_TITLE_CHARS: usize = 60;
const MAX_REMEMBERED: usize = 256;

/// Avisos ya mostrados (clave por ejecución o por autorización) para no repetirlos.
#[derive(Default)]
pub struct Delivered(Mutex<Vec<String>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// `finished`, `failed` o `approval`.
    pub kind: String,
    /// Identidad del evento: `run:<runId>:<estado>` o `approval:<approvalId>`.
    pub key: String,
    pub conversation_id: String,
    pub title: String,
    pub agent: String,
    /// Idioma de la interfaz (`es` o `en`). Ausente en versiones anteriores: español.
    #[serde(default)]
    pub locale: Option<String>,
}

fn clip(title: &str) -> String {
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_TITLE_CHARS {
        return collapsed;
    }
    let head: String = collapsed.chars().take(MAX_TITLE_CHARS - 1).collect();
    format!("{}…", head.trim_end())
}

/// Texto del aviso en español (idioma fuente). Ver `compose_in`.
pub fn compose(kind: &str, agent: &str, title: &str) -> Option<(String, String)> {
    compose_in(kind, agent, title, false)
}

/// Texto del aviso: título y cuerpo, en inglés si `english`. `None` si el tipo o el agente no son conocidos.
pub fn compose_in(kind: &str, agent: &str, title: &str, english: bool) -> Option<(String, String)> {
    let label = match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => return None,
    };
    let clipped = clip(title);
    let quoted = if clipped.is_empty() { String::new() } else if english { format!("“{clipped}”") } else { format!("«{clipped}»") };
    if english {
        let (head, body) = match kind {
            "finished" => (
                format!("{label} has finished"),
                if quoted.is_empty() { "Your response is ready in Duovra.".to_string() } else { format!("{quoted} is ready to review.") },
            ),
            "failed" => (
                format!("{label} could not finish"),
                if quoted.is_empty() { "Open Duovra to review the error.".to_string() } else { format!("Open {quoted} in Duovra to review the error.") },
            ),
            "approval" => (
                format!("{label} needs your approval"),
                if quoted.is_empty() { "Open Duovra to respond.".to_string() } else { format!("Open {quoted} in Duovra to respond.") },
            ),
            _ => return None,
        };
        return Some((head, body));
    }
    let (head, body) = match kind {
        "finished" => (
            format!("{label} ha terminado"),
            if quoted.is_empty() { "Tu respuesta está lista en Duovra.".to_string() } else { format!("{quoted} está lista para revisar.") },
        ),
        "failed" => (
            format!("{label} no pudo terminar"),
            if quoted.is_empty() { "Abre Duovra para revisar el error.".to_string() } else { format!("Abre {quoted} en Duovra para revisar el error.") },
        ),
        "approval" => (
            format!("{label} necesita tu autorización"),
            if quoted.is_empty() { "Abre Duovra para responder.".to_string() } else { format!("Abre {quoted} en Duovra para responder.") },
        ),
        _ => return None,
    };
    Some((head, body))
}

/// Registra la clave del aviso. Devuelve `false` si ya se había mostrado.
pub(crate) fn first_delivery(seen: &mut Vec<String>, key: &str) -> bool {
    if seen.iter().any(|known| known == key) {
        return false;
    }
    seen.push(key.to_owned());
    if seen.len() > MAX_REMEMBERED {
        seen.remove(0);
    }
    true
}

/// Muestra un aviso del sistema salvo que el ajuste esté desactivado o la clave ya se mostrara.
/// Devuelve si se mostró.
#[tauri::command]
pub fn notify_native(app: AppHandle, studio: State<'_, Arc<Studio>>, delivered: State<'_, Delivered>, notice: Notice) -> Result<bool, String> {
    if !studio.setting_bool(SETTING, true) {
        return Ok(false);
    }
    let english = notice.locale.as_deref() == Some("en");
    let (title, body) = compose_in(&notice.kind, &notice.agent, &notice.title, english).ok_or("Aviso no reconocido.")?;
    if notice.key.is_empty() || notice.key.chars().count() > 200 || notice.conversation_id.is_empty() {
        return Err("Aviso no válido.".into());
    }
    if !first_delivery(&mut delivered.0.lock(), &notice.key) {
        return Ok(false);
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .extra("conversationId", json!(notice.conversation_id))
        .show()
        .map_err(|error| format!("Windows no mostró el aviso: {error}"))?;
    Ok(true)
}

/// Un tap en el aviso trae la ventana al frente y pide abrir su conversación.
pub fn register_tap_handler(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let conversation = performed
            .notification()
            .and_then(|notification| notification.extra().get("conversationId"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        if let Some(conversation_id) = conversation {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = handle.emit(OPEN_EVENT, json!({ "conversationId": conversation_id }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avisos_sin_contenido_privado() {
        let (title, body) = compose("finished", "claude", "Refactor de   la API").unwrap();
        assert_eq!(title, "Claude Code ha terminado");
        assert_eq!(body, "«Refactor de la API» está lista para revisar.");
        let (title, body) = compose("failed", "codex", "").unwrap();
        assert_eq!(title, "Codex no pudo terminar");
        assert_eq!(body, "Abre Duovra para revisar el error.");
        let (title, body) = compose("approval", "claude", "Plan").unwrap();
        assert_eq!(title, "Claude Code necesita tu autorización");
        assert_eq!(body, "Abre «Plan» en Duovra para responder.");
        assert!(!body.contains("rm -rf") && !body.contains("C:\\"));
    }

    #[test]
    fn avisos_en_ingles() {
        let (title, body) = compose_in("finished", "codex", "API refactor", true).unwrap();
        assert_eq!(title, "Codex has finished");
        assert_eq!(body, "“API refactor” is ready to review.");
        let (title, body) = compose_in("approval", "claude", "", true).unwrap();
        assert_eq!(title, "Claude Code needs your approval");
        assert_eq!(body, "Open Duovra to respond.");
        assert!(compose_in("started", "claude", "x", true).is_none());
    }

    #[test]
    fn recorta_titulos_largos_y_rechaza_tipos_desconocidos() {
        let long = "palabra ".repeat(40);
        let (_, body) = compose("finished", "claude", &long).unwrap();
        assert!(body.chars().count() <= MAX_TITLE_CHARS + 40, "{body}");
        assert!(body.contains('…'));
        assert!(compose("started", "claude", "x").is_none());
        assert!(compose("finished", "otro", "x").is_none());
    }

    #[test]
    fn cada_aviso_se_muestra_una_sola_vez_y_la_memoria_tiene_limite() {
        let mut seen = Vec::new();
        assert!(first_delivery(&mut seen, "run:1:finished"));
        assert!(!first_delivery(&mut seen, "run:1:finished"), "el mismo evento no se repite");
        for index in 0..(MAX_REMEMBERED + 10) {
            first_delivery(&mut seen, &format!("approval:{index}"));
        }
        assert_eq!(seen.len(), MAX_REMEMBERED);
        assert!(first_delivery(&mut seen, "run:1:finished"), "una clave antigua puede volver a registrarse tras el límite");
    }
}
