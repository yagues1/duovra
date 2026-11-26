//! Exportación local de una conversación: Markdown, JSON versionado, HTML y memoria resumida (1.0.11).
//!
//! El contenido sale siempre de SQLite (no de la vista cargada), solo de la conversación
//! pedida y sin enviar nada fuera del equipo ni llamar a ningún modelo. El archivo se escribe de forma
//! atómica: si algo falla a mitad, el destino anterior queda intacto.
//!
//! Nunca se exportan credenciales, cuentas, directorios de configuración, sesiones nativas ni la
//! cronología interna de herramientas (salidas de comandos): solo el texto de cada mensaje con su
//! atribución (usuario, agente, modelo y razonamiento), su estado, sus adjuntos y la memoria compartida.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
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

/// Formato de exportación y si se copian los adjuntos junto al archivo.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub include_attachments: bool,
}

pub const FORMATS: [(&str, &str, &str); 4] = [
    ("markdown", "md", "Markdown"),
    ("json", "json", "JSON"),
    ("html", "html", "HTML"),
    ("memory", "md", "Markdown"),
];

/// Versión del formato JSON de Duovra. Cambios compatibles no la suben; un cambio incompatible sí.
pub const JSON_FORMAT: &str = "duovra.conversation";
pub const JSON_VERSION: i64 = 1;

/// Adjuntos copiados junto a la exportación: ruta original → ruta relativa al archivo exportado.
type Copied = std::collections::HashMap<String, String>;

/// Documento Markdown completo de la conversación. Conserva el texto de cada mensaje tal cual
/// (incluidos los bloques de código) y solo añade encabezados, estados y referencias a adjuntos.
#[cfg(test)]
pub fn markdown(conversation: &Conversation, messages: &[Message], exported_at: i64) -> String {
    markdown_with(conversation, messages, exported_at, None)
}

/// Ruta como código Markdown sin romper el formato aunque contenga comillas invertidas.
fn md_code(text: &str) -> String {
    let fence = if text.contains('`') { "``" } else { "`" };
    format!("{fence}{}{fence}", text.replace(['\n', '\r'], " "))
}

fn markdown_with(conversation: &Conversation, messages: &[Message], exported_at: i64, copied: Option<&Copied>) -> String {
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
                match copied.and_then(|c| c.get(path)) {
                    Some(rel) => out.push_str(&format!("- [{}](<{}>)\n", name.replace(['[', ']'], ""), rel.replace('>', "%3E"))),
                    None => out.push_str(&format!("- {name} ({})\n", md_code(path))),
                }
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

/// Exporta una conversación persistida a `path` en Markdown. Lo usan el comando y las pruebas.
#[cfg(test)]
pub fn export_to(db: &Db, conversation_id: &str, path: &Path) -> Result<()> {
    export_with(db, conversation_id, path, &ExportOptions::default())
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn agent_name(agent: Option<&str>) -> &'static str {
    match agent {
        Some("claude") => "Claude Code",
        Some("codex") => "Codex",
        _ => "Asistente",
    }
}

fn visible(messages: &[Message]) -> Vec<&Message> {
    messages.iter().filter(|m| m.role == "user" || m.role == "assistant").collect()
}

/// Procedencia sin datos internos: tipo, propósito, conversación original y punto de corte o agente
/// importado. Nunca identificadores de sesiones nativas ni cuentas.
fn public_origin(origin: &Value) -> Value {
    match origin["kind"].as_str() {
        Some("fork") => json!({ "kind": "fork", "purpose": origin["purpose"], "conversationId": origin["conversationId"],
            "title": origin["title"], "seq": origin["seq"] }),
        Some("import") => json!({ "kind": "import", "agent": origin["agent"], "importedAt": origin["importedAt"] }),
        _ => Value::Null,
    }
}

fn attachments_json(message: &Message, copied: Option<&Copied>) -> Value {
    Value::Array(message.attachments.as_array().into_iter().flatten().map(|a| {
        let path = a["path"].as_str().unwrap_or_default();
        json!({
            "name": a["name"], "image": a["image"] == true, "projectReference": a["projectReference"] == true,
            "path": path, "file": copied.and_then(|c| c.get(path)),
        })
    }).collect())
}

/// JSON versionado: suficiente para una recuperación o importación compatible en el futuro.
pub fn json_document(conversation: &Conversation, messages: &[Message], memories: &[crate::db::memory::Memory], exported_at: i64, copied: Option<&Copied>) -> Value {
    json!({
        "format": JSON_FORMAT,
        "version": JSON_VERSION,
        "exportedAt": exported_at,
        "generator": format!("Duovra {}", env!("CARGO_PKG_VERSION")),
        "conversation": {
            "id": conversation.id, "title": conversation.title, "createdAt": conversation.created_at, "updatedAt": conversation.updated_at,
            "origin": public_origin(&conversation.origin),
        },
        "messages": visible(messages).into_iter().map(|m| json!({
            "id": m.id, "seq": m.seq, "role": m.role, "agent": m.agent, "model": m.model, "effort": m.effort,
            "requestedModel": m.usage["requestedModel"], "status": m.status, "error": m.error, "content": m.content,
            "attachments": attachments_json(m, copied), "createdAt": m.created_at, "completedAt": m.completed_at,
        })).collect::<Vec<_>>(),
        "memories": memories.iter().map(|m| json!({
            "category": m.category, "content": m.content, "priority": m.priority, "author": m.author, "origin": m.origin,
            "sourceAgent": m.source_agent, "sourceModel": m.source_model, "archived": m.archived, "revision": m.revision,
            "createdAt": m.created_at, "updatedAt": m.updated_at,
        })).collect::<Vec<_>>(),
    })
}

/// Página HTML autónoma. Todo el contenido se escapa: ningún mensaje puede inyectar marcado ni scripts.
pub fn html_document(conversation: &Conversation, messages: &[Message], exported_at: i64, copied: Option<&Copied>) -> String {
    let title = esc(&conversation.title.split_whitespace().collect::<Vec<_>>().join(" "));
    let mut body = String::new();
    for m in visible(messages) {
        let who = if m.role == "user" { "Usuario".to_owned() } else { agent_name(m.agent.as_deref()).to_owned() };
        let mut meta = vec![];
        if m.role == "assistant" {
            if let Some(model) = m.model.as_deref().filter(|x| !x.trim().is_empty()) { meta.push(esc(model)); }
            if let Some(effort) = m.effort.as_deref().filter(|x| !x.trim().is_empty()) { meta.push(format!("esfuerzo {}", esc(effort))); }
        }
        meta.push(format!("{} UTC", utc_stamp(m.created_at)));
        let status = match m.status.as_str() {
            "failed" => format!("<p class=\"st\">La ejecución terminó con error{}.</p>", m.error.as_deref().map(|e| format!(": {}", esc(e))).unwrap_or_default()),
            "interrupted" => "<p class=\"st\">La ejecución se interrumpió antes de terminar.</p>".into(),
            "cancelled" => "<p class=\"st\">La ejecución se canceló.</p>".into(),
            "running" => "<p class=\"st\">La respuesta seguía en curso al exportar.</p>".into(),
            _ => String::new(),
        };
        let files: Vec<String> = m.attachments.as_array().into_iter().flatten().map(|a| {
            let name = esc(a["name"].as_str().unwrap_or("archivo"));
            let path = a["path"].as_str().unwrap_or_default();
            match copied.and_then(|c| c.get(path)) {
                Some(rel) => format!("<li><a href=\"{}\">{name}</a></li>", esc(&rel.replace('#', "%23").replace('?', "%3F"))),
                None => format!("<li>{name} <code>{}</code></li>", esc(path)),
            }
        }).collect();
        body.push_str(&format!(
            "<article class=\"{}\" data-agent=\"{}\"><header><strong>{}</strong> <span>{}</span></header><div class=\"tx\">{}</div>{}{}</article>\n",
            if m.role == "user" { "user" } else { "agent" }, esc(m.agent.as_deref().unwrap_or("")), esc(&who), meta.join(" · "),
            esc(m.content.trim_end()), status,
            if files.is_empty() { String::new() } else { format!("<ul class=\"files\">{}</ul>", files.join("")) },
        ));
    }
    if body.is_empty() {
        body.push_str("<p class=\"st\">Esta conversación no tiene mensajes.</p>");
    }
    format!(r#"<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>{title}</title>
<style>
:root{{color-scheme:dark;--bg:#0b0f16;--panel:#121824;--line:#222c3c;--tx:#dfe6f1;--mute:#8b97a9;--claude:#d9a37a;--codex:#86b4ff}}
body{{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 "Segoe UI",system-ui,sans-serif}}
main{{max-width:820px;margin:0 auto;padding:40px 20px 80px}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mute);margin:0 0 28px;font-size:13px}}
article{{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:14px 0}}
article.user{{margin-left:12%}} header{{font-size:12.5px;color:var(--mute);margin-bottom:6px}} header strong{{color:var(--tx)}}
article[data-agent=claude] header strong{{color:var(--claude)}} article[data-agent=codex] header strong{{color:var(--codex)}}
.tx{{white-space:pre-wrap;overflow-wrap:anywhere}} .st{{color:var(--mute);font-style:italic;font-size:13px}}
.files{{margin:8px 0 0;padding-left:18px;font-size:13px}} code{{font:12px Consolas,monospace;color:var(--mute)}} a{{color:var(--codex)}}
</style></head><body><main><h1>{title}</h1><p class="sub">Exportado desde Duovra el {} UTC.</p>
{body}</main></body></html>
"#, utc_stamp(exported_at))
}

const CATEGORY_LABELS: [(&str, &str); 10] = [
    ("instruction", "Instrucciones"), ("constraint", "Restricciones"), ("goal", "Objetivos"), ("decision", "Decisiones"),
    ("status", "Estado"), ("task", "Tareas"), ("file", "Archivos"), ("result", "Resultados"), ("issue", "Problemas"), ("note", "Notas"),
];

/// Memoria resumida: los recuerdos existentes agrupados por categoría, sin llamar a ningún modelo.
pub fn memory_markdown(conversation: &Conversation, memories: &[crate::db::memory::Memory], exported_at: i64) -> String {
    let title = conversation.title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = format!("# Memoria · {title}\n\n_Exportado desde Duovra el {} UTC. Resumen local de la memoria compartida; no se ha usado ningún modelo._\n\n", utc_stamp(exported_at));
    let active: Vec<_> = memories.iter().filter(|m| !m.archived && !m.deleted).collect();
    if active.is_empty() {
        out.push_str("_Esta conversación no tiene recuerdos activos._\n");
    }
    for (category, label) in CATEGORY_LABELS {
        let items: Vec<_> = active.iter().filter(|m| m.category == category).collect();
        if items.is_empty() { continue; }
        out.push_str(&format!("## {label}\n\n"));
        for m in items {
            let who = if m.author == "user" { "usuario".to_owned() } else {
                [Some(agent_name(m.source_agent.as_deref()).to_owned()), m.source_model.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ")
            };
            let pin = if m.priority > 0 { " · fijado" } else { "" };
            out.push_str(&format!("- {} _({who}{pin})_\n", m.content.trim().replace('\n', "\n  ")));
        }
        out.push('\n');
    }
    let archived = memories.iter().filter(|m| m.archived && !m.deleted).count();
    if archived > 0 {
        out.push_str(&format!("_{archived} recuerdos archivados no se incluyen en el resumen._\n"));
    }
    out
}

/// Copia los adjuntos existentes a `<nombre> - adjuntos/` junto al archivo. Omite los que ya no
/// existen o superan 50 MB, y las referencias a archivos del proyecto (son rutas, no adjuntos).
fn copy_attachments(messages: &[Message], target: &Path) -> Result<Copied> {
    const MAX: u64 = 50 * 1024 * 1024;
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("Conversación");
    let folder_name = format!("{stem} - adjuntos");
    let folder = target.with_file_name(&folder_name);
    let mut copied = Copied::new();
    let mut used = std::collections::HashSet::new();
    for m in visible(messages) {
        for a in m.attachments.as_array().into_iter().flatten() {
            let Some(path) = a["path"].as_str() else { continue };
            if a["projectReference"] == true || copied.contains_key(path) { continue; }
            let source = Path::new(path);
            if !std::fs::metadata(source).is_ok_and(|md| md.is_file() && md.len() <= MAX) { continue; }
            let name = file_stem(source.file_stem().and_then(|s| s.to_str()).unwrap_or("archivo"));
            let ext = source.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
            let mut leaf = format!("{name}{ext}");
            let mut n = 2;
            while !used.insert(leaf.to_lowercase()) {
                leaf = format!("{name} ({n}){ext}");
                n += 1;
            }
            std::fs::create_dir_all(&folder)?;
            std::fs::copy(source, folder.join(&leaf)).with_context(|| format!("No se pudo copiar el adjunto {leaf}"))?;
            copied.insert(path.to_owned(), format!("{folder_name}/{leaf}"));
        }
    }
    Ok(copied)
}

/// Exporta una conversación persistida a `path` en el formato pedido.
pub fn export_with(db: &Db, conversation_id: &str, path: &Path, options: &ExportOptions) -> Result<()> {
    let conversation = db.get_conversation(conversation_id).map_err(|_| anyhow!("La conversación ya no existe."))?;
    let messages = db.list_messages(conversation_id)?;
    let format = options.format.as_deref().unwrap_or("markdown");
    let copied = if options.include_attachments && format != "memory" { Some(copy_attachments(&messages, path)?) } else { None };
    let now = now_ms();
    let content = match format {
        "markdown" => markdown_with(&conversation, &messages, now, copied.as_ref()),
        "json" => {
            let memories = db.list_memories(conversation_id, true)?;
            serde_json::to_string_pretty(&json_document(&conversation, &messages, &memories, now, copied.as_ref()))? + "\n"
        }
        "html" => html_document(&conversation, &messages, now, copied.as_ref()),
        "memory" => memory_markdown(&conversation, &db.list_memories(conversation_id, true)?, now),
        _ => bail!("Formato de exportación no admitido."),
    };
    write_atomic(path, &content)
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
/// Devuelve la ruta escrita o `None` si el usuario cancela. Sin opciones: Markdown, como antes.
#[tauri::command]
pub async fn export_conversation(app: AppHandle, studio: State<'_, Arc<Studio>>, id: String, options: Option<ExportOptions>) -> Result<Option<String>, String> {
    let options = options.unwrap_or_default();
    let format = options.format.clone().unwrap_or_else(|| "markdown".into());
    let (_, extension, filter) = FORMATS.iter().find(|(f, ..)| *f == format).copied().ok_or("Formato de exportación no admitido.")?;
    let conversation = studio.db.get_conversation(&id).map_err(|e| format!("{e:#}"))?;
    let stem = file_stem(&conversation.title);
    let suggested = if format == "memory" { format!("{stem} - memoria.{extension}") } else { format!("{stem}.{extension}") };
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Exportar conversación")
        .set_file_name(&suggested)
        .add_filter(filter, &[extension])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = ensure_extension(picked.into_path().map_err(|e| format!("{e:#}"))?, extension);
    let db = studio.db.clone();
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || export_with(&db, &id, &written, &options))
        .await.map_err(|e| format!("{e:#}"))?.map_err(|e| format!("{e:#}"))?;
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
            context_prefs: json!({}),
            pinned_at: None,
            archived_at: None,
            origin: json!({}),
            work_modes: json!({}),
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
    fn json_versionado_html_escapado_y_memoria_local() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c", "p", Some("<b>Plan</b>")).unwrap();
        db.insert_message("u", "c", "user", Some("codex"), None, None, "<script>alert(1)</script> & \"x\"", "done", &json!(null),
            &json!([{ "path": "C:/x/<a>.txt", "name": "<a>.txt", "image": false }])).unwrap();
        db.insert_message("a", "c", "assistant", Some("codex"), Some("gpt-6-luna"), Some("high"), "ok", "done", &json!(null), &json!([])).unwrap();
        db.save_memory(&crate::db::memory::MemoryInput { conversation_id: "c".into(), content: "Usar SQLite".into(), category: "decision".into(), ..Default::default() }).unwrap();
        db.upsert_provider_session("c", "codex", "thread-secreto", 2, Some("cuenta")).unwrap();
        let conv = db.get_conversation("c").unwrap();
        let messages = db.list_messages("c").unwrap();
        let memories = db.list_memories("c", true).unwrap();

        let doc = json_document(&conv, &messages, &memories, 1, None);
        assert_eq!((doc["format"].as_str(), doc["version"].as_i64()), (Some(JSON_FORMAT), Some(1)));
        assert_eq!(doc["messages"][1]["agent"], "codex");
        assert_eq!(doc["messages"][1]["model"], "gpt-6-luna");
        assert_eq!(doc["messages"][1]["effort"], "high");
        assert_eq!(doc["memories"][0]["content"], "Usar SQLite");
        let text = doc.to_string();
        assert!(!text.contains("thread-secreto") && !text.contains("cuenta"), "sin sesiones nativas ni cuentas");

        let html = html_document(&conv, &messages, 1, None);
        assert!(!html.contains("<script>") && html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;"));
        assert!(html.contains("<title>&lt;b&gt;Plan&lt;/b&gt;</title>"));
        assert!(html.contains("<code>C:/x/&lt;a&gt;.txt</code>"));
        assert!(html.contains("default-src 'none'"));

        let memory = memory_markdown(&conv, &memories, 1);
        assert!(memory.contains("## Decisiones") && memory.contains("- Usar SQLite _(usuario)_"));
    }

    #[test]
    fn copia_adjuntos_solo_si_se_pide() {
        let dir = std::env::temp_dir().join(format!("duovra-export-att-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("datos.txt");
        std::fs::write(&file, "contenido").unwrap();
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c", "p", Some("Con adjuntos")).unwrap();
        db.insert_message("u", "c", "user", None, None, None, "mira", "done", &json!(null),
            &json!([{ "path": file.to_string_lossy(), "name": "datos.txt", "image": false },
                    { "path": "C:/no/existe.png", "name": "existe.png", "image": true }])).unwrap();
        let out = dir.join("salida").join("Con adjuntos.html");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        export_with(&db, "c", &out, &ExportOptions { format: Some("html".into()), include_attachments: false }).unwrap();
        assert!(!out.with_file_name("Con adjuntos - adjuntos").exists());
        export_with(&db, "c", &out, &ExportOptions { format: Some("html".into()), include_attachments: true }).unwrap();
        let copied = out.with_file_name("Con adjuntos - adjuntos").join("datos.txt");
        assert_eq!(std::fs::read_to_string(copied).unwrap(), "contenido");
        assert!(std::fs::read_to_string(&out).unwrap().contains("href=\"Con adjuntos - adjuntos/datos.txt\""));
        assert!(export_with(&db, "c", &out, &ExportOptions { format: Some("pdf".into()), include_attachments: false }).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn anade_la_extension_solo_si_falta() {
        assert_eq!(ensure_extension("a/b".into(), "md"), std::path::PathBuf::from("a/b.md"));
        assert_eq!(ensure_extension("a/b.MD".into(), "md"), std::path::PathBuf::from("a/b.MD"));
        assert_eq!(ensure_extension("a/b.txt".into(), "md"), std::path::PathBuf::from("a/b.txt.md"));
    }
}
