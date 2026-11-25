//! Exportación local de una conversación a Markdown.
//!
//! El contenido sale siempre de SQLite (no de la vista cargada), solo de la conversación
//! pedida y sin enviar nada fuera del equipo. El archivo se escribe de forma atómica: si algo
//! falla a mitad, el destino anterior queda intacto.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::agents::Studio;
use crate::db::{Conversation, Db, Message};
use crate::util::{new_id, now_ms};

const DEFAULT_STEM: &str = "Conversación";
const MAX_STEM_CHARS: usize = 80;
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Nombre de archivo propuesto a partir del título: sin caracteres no válidos en Windows,
/// sin nombres reservados ni puntos finales, y con un tamaño razonable.
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed
        .chars()
        .take(MAX_STEM_CHARS)
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string();
    if trimmed.is_empty() {
        return DEFAULT_STEM.to_string();
    }
    let upper = trimmed.to_ascii_uppercase();
    if RESERVED_NAMES.contains(&upper.as_str()) {
        return format!("{trimmed} conversación");
    }
    trimmed
}

/// `YYYY-MM-DD HH:MM` en UTC a partir de milisegundos desde la época (algoritmo de calendario civil).
pub fn utc_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let minutes = secs.rem_euclid(86_400) / 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}", minutes / 60, minutes % 60)
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Encabezado de cada mensaje: quién habla, modelo y esfuerzo si se conocen, y la fecha.
fn message_heading(message: &Message) -> String {
    let when = utc_stamp(message.created_at);
    if message.role == "user" {
        return format!("Usuario · {when} UTC");
    }
    let mut parts = vec![match message.agent.as_deref() {
        Some("claude") => "Claude Code".to_string(),
        Some("codex") => "Codex".to_string(),
        _ => "Asistente".to_string(),
    }];
    if let Some(model) = message.model.as_deref().filter(|m| !m.trim().is_empty()) {
        parts.push(model.trim().to_string());
    }
    if let Some(effort) = message.effort.as_deref().filter(|e| !e.trim().is_empty()) {
        parts.push(format!("esfuerzo {}", effort.trim()));
    }
    parts.push(format!("{when} UTC"));
    parts.join(" · ")
}

/// Documento Markdown completo de la conversación. Conserva el texto de cada mensaje tal cual
/// (incluidos los bloques de código) y solo añade encabezados, estados y referencias a adjuntos.
pub fn markdown(conversation: &Conversation, messages: &[Message], exported_at: i64) -> String {
    let title = conversation.title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = format!("# {}\n\n_Exportado desde Duovra el {} UTC._\n\n", title, utc_stamp(exported_at));
    let visible: Vec<&Message> = messages.iter().filter(|m| m.role == "user" || m.role == "assistant").collect();
    if visible.is_empty() {
        out.push_str("_Esta conversación no tiene mensajes._\n");
        return out;
    }
    for message in visible {
        out.push_str("---\n\n");
        out.push_str(&format!("## {}\n\n", message_heading(message)));
        let body = message.content.trim_end();
        if !body.is_empty() {
            out.push_str(body);
            out.push_str("\n\n");
        }
        match message.status.as_str() {
            "failed" => out.push_str(&format!(
                "_La ejecución terminó con error{}._\n\n",
                message.error.as_deref().filter(|e| !e.trim().is_empty()).map(|e| format!(": {}", e.trim())).unwrap_or_default()
            )),
            "interrupted" => out.push_str("_La ejecución se interrumpió antes de terminar._\n\n"),
            "cancelled" => out.push_str("_La ejecución se canceló._\n\n"),
            "running" => out.push_str("_La respuesta seguía en curso al exportar._\n\n"),
            _ => {}
        }
        if let Some(files) = message.attachments.as_array().filter(|files| !files.is_empty()) {
            out.push_str("Archivos adjuntos:\n\n");
            for file in files {
                let name = file["name"].as_str().unwrap_or("archivo");
                let path = file["path"].as_str().unwrap_or_default();
                out.push_str(&format!("- {name} (`{path}`)\n"));
            }
            out.push('\n');
        }
    }
    out
}

/// Escribe `content` en `path` mediante un archivo temporal junto al destino.
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    use std::io::Write;
    let name = path.file_name().and_then(|n| n.to_str()).context("Nombre de archivo no válido")?;
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", new_id()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("No se pudo escribir el archivo exportado. Revisa la carpeta elegida y el espacio libre.")
}

/// Exporta una conversación persistida a `path`. Lo usan el comando y las pruebas.
pub fn export_to(db: &Db, conversation_id: &str, path: &Path) -> Result<()> {
    let conversation = db.get_conversation(conversation_id).map_err(|_| anyhow!("La conversación ya no existe."))?;
    let messages = db.list_messages(conversation_id)?;
    write_atomic(path, &markdown(&conversation, &messages, now_ms()))
}

pub(crate) fn ensure_extension(path: std::path::PathBuf, extension: &str) -> std::path::PathBuf {
    let matches = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if matches {
        path
    } else {
        let mut name = path.into_os_string();
        name.push(format!(".{extension}"));
        name.into()
    }
}

/// Pide la ubicación con el selector nativo de Windows y guarda la conversación.
/// Devuelve la ruta escrita o `None` si el usuario cancela.
#[tauri::command]
pub async fn export_conversation(app: AppHandle, studio: State<'_, Arc<Studio>>, id: String) -> Result<Option<String>, String> {
    let conversation = studio.db.get_conversation(&id).map_err(|e| format!("{e:#}"))?;
    let suggested = format!("{}.md", file_stem(&conversation.title));
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Exportar conversación")
        .set_file_name(&suggested)
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = ensure_extension(picked.into_path().map_err(|e| format!("{e:#}"))?, "md");
    export_to(&studio.db, &id, &path).map_err(|e| format!("{e:#}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conversation(title: &str) -> Conversation {
        Conversation {
            id: "c".into(),
            project_id: "p".into(),
            title: title.into(),
            created_at: 0,
            updated_at: 0,
            last_agent: None,
            last_model: None,
            last_effort: None,
            agent_prefs: json!({}),
            draft: String::new(),
            draft_attachments: vec![],
            permission_prefs: json!({}),
            started: true,
            worktree_id: None,
        }
    }

    fn message(role: &str, agent: Option<&str>, content: &str, status: &str, created_at: i64) -> Message {
        Message {
            id: format!("{role}-{created_at}"),
            conversation_id: "c".into(),
            seq: created_at,
            role: role.into(),
            agent: agent.map(str::to_string),
            model: agent.map(|_| "claude-opus-5-5".to_string()),
            effort: agent.map(|_| "high".to_string()),
            content: content.into(),
            items: json!([]),
            status: status.into(),
            error: None,
            usage: json!(null),
            context_note: json!(null),
            attachments: json!([]),
            created_at,
            completed_at: None,
        }
    }

    #[test]
    fn nombres_seguros_para_windows() {
        assert_eq!(file_stem("Plan: API / v2?"), "Plan API v2");
        assert_eq!(file_stem("  ¿Qué   tal?  "), "¿Qué tal");
        assert_eq!(file_stem("CON"), "CON conversación");
        assert_eq!(file_stem("lpt1"), "lpt1 conversación");
        assert_eq!(file_stem("Notas..."), "Notas");
        assert_eq!(file_stem("   "), DEFAULT_STEM);
        assert_eq!(file_stem("a\tb\nc"), "a b c");
        let long = "á".repeat(200);
        assert_eq!(file_stem(&long).chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn fechas_utc_son_exactas() {
        assert_eq!(utc_stamp(0), "1970-01-01 00:00");
        assert_eq!(utc_stamp(951_782_400_000), "2000-02-29 00:00");
        assert_eq!(utc_stamp(1_795_000_000_000), "2026-11-18 11:06");
        assert_eq!(utc_stamp(-1_000), "1969-12-31 23:59");
    }

    #[test]
    fn exporta_mensajes_completos_sin_inventar_datos() {
        let mut claude = message("assistant", Some("claude"), "Respuesta\n\n```rust\nfn main() {}\n```\n", "done", 1_795_000_000_000);
        claude.attachments = json!([{ "path": "C:/x/foto.png", "name": "foto.png", "image": true }]);
        let failed = Message { error: Some("límite alcanzado".into()), ..message("assistant", Some("codex"), "", "failed", 1_795_000_060_000) };
        let md = markdown(
            &conversation("Mi «plan» #1"),
            &[message("user", None, "¿Qué tal?", "done", 1_795_000_000_000), claude, failed, message("system", None, "oculto", "done", 5)],
            1_795_100_000_000,
        );
        assert!(md.starts_with("# Mi «plan» #1\n\n_Exportado desde Duovra el "));
        assert!(md.contains("## Usuario · 2026-11-18 11:06 UTC\n\n¿Qué tal?"));
        assert!(md.contains("## Claude Code · claude-opus-5-5 · esfuerzo high · 2026-11-18 11:06 UTC"));
        assert!(md.contains("```rust\nfn main() {}\n```"));
        assert!(md.contains("- foto.png (`C:/x/foto.png`)"));
        assert!(md.contains("## Codex · claude-opus-5-5 · esfuerzo high"));
        assert!(md.contains("_La ejecución terminó con error: límite alcanzado._"));
        assert!(!md.contains("oculto"), "los mensajes de sistema no se exportan");
    }

    #[test]
    fn conversacion_vacia_y_titulo_con_saltos() {
        let md = markdown(&conversation("Uno\ndos"), &[], 0);
        assert!(md.starts_with("# Uno dos\n"));
        assert!(md.contains("_Esta conversación no tiene mensajes._"));
    }

    #[test]
    fn escribe_de_forma_atomica_y_sustituye_el_destino() {
        let dir = std::env::temp_dir().join(format!("duovra-export-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("salida.md");
        std::fs::write(&target, "anterior").unwrap();
        write_atomic(&target, "# nuevo\n").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "# nuevo\n");
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1, "no deben quedar temporales");
        assert!(write_atomic(&dir.join("no-existe").join("x.md"), "x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn exporta_desde_la_base_de_datos() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c1", "p", Some("Revisión")).unwrap();
        db.create_conversation("c2", "p", Some("Otra")).unwrap();
        db.insert_message("m1", "c1", "user", None, None, None, "hola", "done", &json!(null), &json!([])).unwrap();
        db.insert_message("m2", "c2", "user", None, None, None, "ajena", "done", &json!(null), &json!([])).unwrap();
        let dir = std::env::temp_dir().join(format!("duovra-export-db-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("Revisión.md");
        export_to(&db, "c1", &target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("hola") && text.contains("# Revisión"));
        assert!(!text.contains("ajena"), "no incluye otras conversaciones");
        assert!(export_to(&db, "inexistente", &dir.join("x.md")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn anade_la_extension_solo_si_falta() {
        assert_eq!(ensure_extension("a/b".into(), "md"), std::path::PathBuf::from("a/b.md"));
        assert_eq!(ensure_extension("a/b.MD".into(), "md"), std::path::PathBuf::from("a/b.MD"));
        assert_eq!(ensure_extension("a/b.txt".into(), "md"), std::path::PathBuf::from("a/b.txt.md"));
    }
}
