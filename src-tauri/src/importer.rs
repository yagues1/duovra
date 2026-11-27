//! Importación de sesiones externas de Codex y Claude Code (1.0.11, fase 3).
//!
//! - **Codex 0.169.0**: interfaz oficial del app-server. `thread/list` (paginado, búsqueda por título),
//!   `thread/turns/list` (turnos completos, paginados; `thread/read` con turnos como respaldo). Ninguno
//!   carga ni modifica el hilo.
//! - **Claude Code 2.1.325**: la CLI no ofrece listar ni leer sesiones desde nuestro transporte (`-p`
//!   stream-json). Se leen en modo lectura solo las transcripciones locales de la cuenta elegida,
//!   `<config>/projects/<carpeta>/<sesión>.jsonl`, sin abrir ningún otro archivo (credenciales, ajustes
//!   ni historial ajeno). Se sigue la cadena `parentUuid` desde el último mensaje, se descartan
//!   ramas laterales (`isSidechain`), mensajes internos (`isMeta`) y resultados de herramientas.
//!
//! Nada se escribe en las sesiones originales. Lo que no consta en la sesión no se inventa: un mensaje
//! sin modelo conocido queda sin modelo.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::agents::{claude, Studio};
use crate::db::sessions::{ImportSpec, ImportedMessage};

const PAGE: usize = 20;
/// Máximo de mensajes que se importan de una sesión (los más antiguos se conservan).
const MAX_MESSAGES: usize = 2000;
const PREVIEW_MESSAGES: usize = 4;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTarget {
    pub agent: String,
    /// Cuenta de Duovra. `None`: configuración predeterminada de la CLI.
    pub account_id: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max { t } else { format!("{}…", t.chars().take(max).collect::<String>().trim_end()) }
}

/// `2026-11-26T10:11:12.345Z` → milisegundos UTC. Solo el formato que escribe Claude Code.
pub fn iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let ms = if b.get(19) == Some(&b'.') {
        let digits: String = text[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        format!("{digits:0<3}").parse::<i64>().ok()?
    } else { 0 };
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + s) * 1000) + ms)
}

impl Studio {
    fn import_config_dir(&self, target: &ImportTarget) -> Result<Option<String>> {
        if !crate::agents::AGENTS.contains(&target.agent.as_str()) {
            bail!("Agente desconocido: {}", target.agent);
        }
        match &target.account_id {
            None => Ok(None),
            Some(id) => {
                let account = self.db.list_accounts()?.into_iter().find(|a| &a.id == id && a.agent == target.agent)
                    .ok_or_else(|| anyhow!("La cuenta elegida ya no existe."))?;
                Ok(account.config_dir)
            }
        }
    }

    /// Página de sesiones externas. `cursor` es opaco: el de Codex o una posición en la lista de Claude Code.
    pub async fn import_list(self: &Arc<Self>, target: ImportTarget, query: String, cursor: Option<String>) -> Result<Value> {
        let config = self.import_config_dir(&target)?;
        let query = query.trim().to_owned();
        let (mut items, next) = if target.agent == "codex" {
            let server = self.codex_server_for(config).await?;
            let mut params = json!({ "limit": PAGE, "sortKey": "updated_at", "cursor": cursor });
            if !query.is_empty() {
                params["searchTerm"] = json!(query);
            }
            let page = server.request("thread/list", params).await?;
            let items: Vec<Value> = page["data"].as_array().cloned().unwrap_or_default().into_iter()
                .filter(|t| t["ephemeral"] != true && t["parentThreadId"].is_null())
                .map(|t| {
                    let preview = t["preview"].as_str().unwrap_or_default();
                    let title = t["name"].as_str().filter(|n| !n.trim().is_empty()).map(|n| clip(n, 90))
                        .unwrap_or_else(|| clip(preview.lines().next().unwrap_or_default(), 90));
                    json!({
                        "sessionId": t["id"], "title": title, "preview": clip(preview, 240), "cwd": t["cwd"],
                        "createdAt": t["createdAt"].as_i64().map(|s| s * 1000), "updatedAt": t["updatedAt"].as_i64().map(|s| s * 1000),
                        "model": t["model"], "source": t["source"], "cliVersion": t["cliVersion"],
                    })
                }).collect();
            (items, page["nextCursor"].as_str().map(str::to_owned))
        } else {
            let dir = claude::projects_dir(config.as_deref());
            tauri::async_runtime::spawn_blocking(move || claude_list(dir.as_deref(), &query, cursor.as_deref()))
                .await.map_err(|e| anyhow!("{e}"))??
        };
        for item in &mut items {
            let id = item["sessionId"].as_str().unwrap_or_default().to_owned();
            item["conversationId"] = json!(self.db.session_owner(&target.agent, &id)?);
        }
        Ok(json!({ "items": items, "nextCursor": next }))
    }

    /// Primeros mensajes de una sesión, recortados, para reconocerla antes de importarla.
    pub async fn import_preview(self: &Arc<Self>, target: ImportTarget, session_id: String) -> Result<Value> {
        let (messages, _) = self.read_external(&target, &session_id, Some(PREVIEW_MESSAGES)).await?;
        let shown: Vec<Value> = messages.iter().take(PREVIEW_MESSAGES)
            .map(|m| json!({ "role": m.role, "text": clip(&m.content, 280), "model": m.model, "createdAt": m.created_at }))
            .collect();
        Ok(json!({ "messages": shown }))
    }

    async fn read_external(self: &Arc<Self>, target: &ImportTarget, session_id: &str, limit: Option<usize>) -> Result<(Vec<ImportedMessage>, Value)> {
        let config = self.import_config_dir(target)?;
        if target.agent == "codex" {
            let server = self.codex_server_for(config).await?;
            codex_read(&server, session_id, limit).await
        } else {
            let file = claude::session_file(config.as_deref(), session_id)
                .ok_or_else(|| anyhow!("La sesión de Claude Code ya no está disponible en esta cuenta."))?;
            tauri::async_runtime::spawn_blocking(move || claude_read(&file, limit)).await.map_err(|e| anyhow!("{e}"))?
        }
    }

    /// Importa sesiones en un proyecto (o worktree). Devuelve las conversaciones creadas y los fallos.
    pub async fn import_sessions(
        self: &Arc<Self>, target: ImportTarget, project_id: String, worktree_id: Option<String>, sessions: Vec<String>, native: bool,
    ) -> Result<Value> {
        let root = match &worktree_id {
            Some(w) => self.db.space_root(w)?,
            None => self.db.get_project(&project_id)?.path,
        };
        let mut created = vec![];
        let mut failed = vec![];
        for session in sessions.iter().take(50) {
            let result = async {
                if self.db.session_owner(&target.agent, session)?.is_some() {
                    bail!("Esta sesión ya está en Duovra.");
                }
                let (messages, meta) = self.read_external(&target, session, None).await?;
                // Claude Code guarda las sesiones por carpeta: desde otra carpeta no se bifurcan con seguridad.
                let same_dir = meta["cwd"].as_str().is_some_and(|cwd| same_path(cwd, &root));
                let native = native && (target.agent == "codex" || same_dir);
                let title = meta["title"].as_str().map(|t| clip(t, 90)).filter(|t| !t.is_empty())
                    .or_else(|| messages.iter().find(|m| m.role == "user").map(|m| clip(m.content.lines().next().unwrap_or_default(), 60)))
                    .unwrap_or_else(|| "Sesión importada".into());
                let conv = self.db.import_conversation(&ImportSpec {
                    project_id: &project_id, worktree_id: worktree_id.as_deref(), agent: &target.agent,
                    account_id: target.account_id.as_deref(), session_id: session, title: &title, messages: &messages,
                    meta, native,
                })?;
                Ok(conv)
            }.await;
            match result {
                Ok(conv) => created.push(json!(conv)),
                Err(err) => failed.push(json!({ "sessionId": session, "error": format!("{err:#}") })),
            }
        }
        Ok(json!({ "created": created, "failed": failed }))
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let n = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    n(a) == n(b)
}

// ---------- Codex ----------

fn codex_status(turn: &Value) -> &'static str {
    match turn["status"].as_str() {
        Some("completed") => "done",
        Some("failed") => "failed",
        _ => "interrupted",
    }
}

fn codex_turn(turn: &Value, out: &mut Vec<ImportedMessage>) {
    let started = turn["startedAt"].as_i64().map(|s| s * 1000).unwrap_or(0);
    let completed = turn["completedAt"].as_i64().map(|s| s * 1000);
    let items = turn["items"].as_array().cloned().unwrap_or_default();
    let mut answer: Vec<String> = vec![];
    for item in &items {
        match item["type"].as_str() {
            Some("userMessage") => {
                let mut text = vec![];
                let mut files = vec![];
                for input in item["content"].as_array().into_iter().flatten() {
                    match input["type"].as_str() {
                        Some("text") => text.push(input["text"].as_str().unwrap_or_default().to_owned()),
                        Some("localImage") => if let Some(path) = input["path"].as_str() {
                            let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path);
                            files.push(json!({ "path": path, "name": name, "image": true }));
                        },
                        _ => {}
                    }
                }
                let content = text.join("\n").trim().to_owned();
                if !content.is_empty() || !files.is_empty() {
                    out.push(ImportedMessage { role: "user".into(), content, model: None, status: "done".into(), created_at: started, completed_at: None, attachments: files });
                }
            }
            Some("agentMessage") => {
                // Campos de visibilidad de 0.172: lo que el proveedor oculta o bloquea no se recupera.
                if crate::agents::codex::hidden_by_provider(item) {
                    answer.push("_(Codex indica que esta respuesta no debe mostrarse.)_".to_owned());
                } else if let Some(text) = item["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                    answer.push(text.to_owned());
                }
            }
            _ => {}
        }
    }
    let status = codex_status(turn);
    if !answer.is_empty() || status != "done" {
        out.push(ImportedMessage {
            role: "assistant".into(), content: answer.join("\n\n"), model: None, status: status.into(),
            created_at: started, completed_at: completed.or(Some(started)), attachments: vec![],
        });
    }
}

async fn codex_read(server: &crate::agents::codex::CodexServer, thread: &str, limit: Option<usize>) -> Result<(Vec<ImportedMessage>, Value)> {
    let read = server.request("thread/read", json!({ "threadId": thread })).await
        .context("Codex no encontró la sesión")?;
    let t = &read["thread"];
    let meta = json!({
        "cwd": t["cwd"], "title": t["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(t["preview"].as_str().unwrap_or_default()),
        "model": t["model"], "createdAt": t["createdAt"].as_i64().map(|s| s * 1000), "updatedAt": t["updatedAt"].as_i64().map(|s| s * 1000),
        "cliVersion": t["cliVersion"], "forkedFromId": t["forkedFromId"],
    });
    let mut out = vec![];
    let mut cursor: Option<String> = None;
    let page_size = limit.map(|n| n.max(2)).unwrap_or(50);
    for _ in 0..80 {
        let params = json!({ "threadId": thread, "limit": page_size, "sortDirection": "asc", "itemsView": "full", "cursor": cursor });
        let page = match server.request("thread/turns/list", params).await {
            Ok(page) => page,
            Err(_) if cursor.is_none() => {
                // Respaldo: lectura completa del hilo (deprecada para hilos paginados, pero oficial).
                let full = server.request("thread/read", json!({ "threadId": thread, "includeTurns": true })).await?;
                json!({ "data": full["thread"]["turns"], "nextCursor": null })
            }
            Err(e) => return Err(e),
        };
        for turn in page["data"].as_array().into_iter().flatten() {
            codex_turn(turn, &mut out);
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() || out.len() >= limit.unwrap_or(MAX_MESSAGES) {
            break;
        }
    }
    out.truncate(MAX_MESSAGES);
    Ok((out, meta))
}

// ---------- Claude Code ----------

/// Lee un fragmento acotado del principio y del final de un archivo grande.
fn head_tail(path: &Path, size: usize) -> Result<(String, String)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len() as usize;
    let mut head = vec![0; size.min(len)];
    file.read_exact(&mut head)?;
    let mut tail = vec![];
    if len > size {
        let start = len.saturating_sub(size).max(size);
        file.seek(SeekFrom::Start(start as u64))?;
        file.read_to_end(&mut tail)?;
    }
    Ok((String::from_utf8_lossy(&head).into_owned(), String::from_utf8_lossy(&tail).into_owned()))
}

/// Texto visible de un mensaje de Claude Code (sin herramientas, razonamiento ni envoltorios internos).
fn claude_text(message: &Value, role: &str) -> String {
    let content = &message["content"];
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    };
    let trimmed = text.trim();
    // Comandos locales y avisos internos de la CLI no son mensajes de la conversación.
    if role == "user" && (trimmed.starts_with('<') || trimmed.starts_with("Caveat:")) {
        return String::new();
    }
    trimmed.to_owned()
}

fn visible(entry: &Value) -> bool {
    matches!(entry["type"].as_str(), Some("user" | "assistant")) && entry["isSidechain"] != true && entry["isMeta"] != true
}

struct ClaudeSummary {
    title: Option<String>,
    first: Option<String>,
    cwd: Option<String>,
    created: Option<i64>,
}

fn claude_summary(path: &Path) -> Result<ClaudeSummary> {
    let (head, tail) = head_tail(path, 96 * 1024)?;
    let mut s = ClaudeSummary { title: None, first: None, cwd: None, created: None };
    for line in head.lines().chain(tail.lines()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if s.cwd.is_none() { s.cwd = entry["cwd"].as_str().map(str::to_owned); }
        if s.created.is_none() { s.created = entry["timestamp"].as_str().and_then(iso_ms); }
        match entry["type"].as_str() {
            Some("custom-title") => s.title = entry["customTitle"].as_str().map(str::to_owned).or(s.title.take()),
            Some("summary") if s.title.is_none() => s.title = entry["summary"].as_str().map(str::to_owned),
            Some("user") if s.first.is_none() && visible(&entry) => {
                let text = claude_text(&entry["message"], "user");
                if !text.is_empty() { s.first = Some(text); }
            }
            _ => {}
        }
    }
    Ok(s)
}

type Listing = (Vec<Value>, Option<String>);

fn claude_list(projects: Option<&Path>, query: &str, cursor: Option<&str>) -> Result<Listing> {
    let Some(projects) = projects.filter(|p| p.is_dir()) else { return Ok((vec![], None)) };
    let mut files: Vec<(PathBuf, i64)> = vec![];
    for dir in std::fs::read_dir(projects)?.flatten().filter(|e| e.path().is_dir()) {
        for f in std::fs::read_dir(dir.path())?.flatten() {
            let path = f.path();
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") || !claude::valid_session_id(id) {
                continue;
            }
            let modified = f.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            files.push((path, modified));
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let q = query.to_lowercase();
    let mut at: usize = cursor.and_then(|c| c.parse().ok()).unwrap_or(0);
    let mut items = vec![];
    let mut scanned = 0;
    while at < files.len() && items.len() < PAGE && scanned < 400 {
        let (path, modified) = &files[at];
        at += 1;
        scanned += 1;
        let Ok(s) = claude_summary(path) else { continue };
        let Some(first) = s.first.clone() else { continue };
        let title = s.title.clone().unwrap_or_else(|| first.lines().next().unwrap_or_default().to_owned());
        let cwd = s.cwd.clone().unwrap_or_default();
        if !q.is_empty() && ![&title, &first, &cwd].iter().any(|t| t.to_lowercase().contains(&q)) {
            continue;
        }
        items.push(json!({
            "sessionId": path.file_stem().and_then(|s| s.to_str()), "title": clip(&title, 90), "preview": clip(&first, 240),
            "cwd": s.cwd, "createdAt": s.created, "updatedAt": modified,
        }));
    }
    Ok((items, (at < files.len()).then(|| at.to_string())))
}

fn claude_read(path: &Path, limit: Option<usize>) -> Result<(Vec<ImportedMessage>, Value)> {
    let text = std::fs::read_to_string(path).context("No se pudo leer la sesión de Claude Code")?;
    let entries: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
    let mut by_uuid = std::collections::HashMap::new();
    let (mut title, mut summary, mut cwd, mut version) = (None, None, None, None);
    for (i, e) in entries.iter().enumerate() {
        if let Some(u) = e["uuid"].as_str() { by_uuid.insert(u.to_owned(), i); }
        match e["type"].as_str() {
            Some("custom-title") => title = e["customTitle"].as_str().map(str::to_owned),
            Some("summary") => summary = e["summary"].as_str().map(str::to_owned),
            _ => {}
        }
        if cwd.is_none() { cwd = e["cwd"].as_str().map(str::to_owned); }
        if version.is_none() { version = e["version"].as_str().map(str::to_owned); }
    }
    // Rama activa: desde el último mensaje visible hacia atrás por `parentUuid`.
    let mut chain = vec![];
    let mut cursor = entries.iter().rposition(visible);
    let mut guard = 0;
    while let Some(i) = cursor {
        guard += 1;
        if guard > 200_000 { break; }
        chain.push(i);
        cursor = entries[i]["parentUuid"].as_str().and_then(|p| by_uuid.get(p).copied());
    }
    chain.reverse();
    let mut out: Vec<ImportedMessage> = vec![];
    for i in chain {
        let e = &entries[i];
        if !visible(e) { continue; }
        let role = e["type"].as_str().unwrap_or_default();
        let content = claude_text(&e["message"], role);
        if content.is_empty() { continue; }
        let at = e["timestamp"].as_str().and_then(iso_ms).unwrap_or(0);
        let model = (role == "assistant").then(|| e["message"]["model"].as_str().map(str::to_owned)).flatten()
            .filter(|m| !m.starts_with('<'));
        // Varios bloques de texto seguidos del mismo turno se unen en un único mensaje.
        if let Some(last) = out.last_mut().filter(|l| l.role == role && role == "assistant") {
            last.content.push_str("\n\n");
            last.content.push_str(&content);
            last.completed_at = Some(at);
            if last.model.is_none() { last.model = model; }
            continue;
        }
        out.push(ImportedMessage {
            role: role.into(), content, model, status: "done".into(), created_at: at,
            completed_at: (role == "assistant").then_some(at), attachments: vec![],
        });
        if limit.is_some_and(|n| out.len() >= n) { break; }
    }
    out.truncate(MAX_MESSAGES);
    let created = entries.iter().find_map(|e| e["timestamp"].as_str().and_then(iso_ms));
    Ok((out, json!({ "cwd": cwd, "title": title.or(summary), "cliVersion": version, "createdAt": created })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fechas_iso_de_claude_code() {
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_ms("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        assert_eq!(iso_ms("2026-11-18T11:06:40.5Z"), Some(1_795_000_000_500));
        assert_eq!(iso_ms("no"), None);
    }

    fn line(v: Value) -> String { v.to_string() + "\n" }

    #[test]
    fn lee_la_rama_activa_sin_herramientas_ni_ramas_laterales() {
        let dir = std::env::temp_dir().join(format!("duovra-import-{}", crate::util::new_id()));
        let project = dir.join("projects").join("C--p");
        std::fs::create_dir_all(&project).unwrap();
        let id = "0b0a1c2d-0000-4000-8000-000000000001";
        let mut s = String::new();
        s += &line(json!({ "type": "user", "uuid": "u1", "parentUuid": null, "cwd": "C:\\p", "timestamp": "2026-11-18T11:06:40.000Z", "version": "2.1.325", "message": { "role": "user", "content": "Arregla el login" } }));
        s += &line(json!({ "type": "assistant", "uuid": "a1", "parentUuid": "u1", "timestamp": "2026-11-18T11:06:41.000Z", "message": { "role": "assistant", "model": "claude-haiku-5-5", "content": [{ "type": "thinking", "thinking": "x" }, { "type": "text", "text": "Voy" }, { "type": "tool_use", "id": "t", "name": "Bash", "input": {} }] } }));
        s += &line(json!({ "type": "user", "uuid": "r1", "parentUuid": "a1", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t", "content": "secreto de salida" }] } }));
        s += &line(json!({ "type": "assistant", "uuid": "a2", "parentUuid": "r1", "timestamp": "2026-11-18T11:06:50.000Z", "message": { "role": "assistant", "model": "claude-haiku-5-5", "content": [{ "type": "text", "text": "Hecho" }] } }));
        s += &line(json!({ "type": "user", "uuid": "side", "parentUuid": "a2", "isSidechain": true, "message": { "role": "user", "content": "subagente" } }));
        s += &line(json!({ "type": "user", "uuid": "old", "parentUuid": "u1", "message": { "role": "user", "content": "rama descartada" } }));
        s += &line(json!({ "type": "user", "uuid": "meta", "parentUuid": "a2", "isMeta": true, "message": { "role": "user", "content": "interno" } }));
        s += &line(json!({ "type": "user", "uuid": "u2", "parentUuid": "a2", "timestamp": "2026-11-18T11:07:00.000Z", "message": { "role": "user", "content": "<command-name>/clear</command-name>" } }));
        s += &line(json!({ "type": "custom-title", "customTitle": "Login roto", "sessionId": id }));
        std::fs::write(project.join(format!("{id}.jsonl")), s).unwrap();
        std::fs::write(project.join("no-es-sesion.jsonl"), "{}").unwrap();

        let file = claude::session_file(Some(dir.to_str().unwrap()), id).unwrap();
        let (messages, meta) = claude_read(&file, None).unwrap();
        assert_eq!(meta["title"], "Login roto");
        assert_eq!(meta["cwd"], "C:\\p");
        let texts: Vec<_> = messages.iter().map(|m| (m.role.as_str(), m.content.as_str())).collect();
        assert_eq!(texts, [("user", "Arregla el login"), ("assistant", "Voy\n\nHecho")]);
        assert_eq!(messages[1].model.as_deref(), Some("claude-haiku-5-5"));
        assert!(!messages.iter().any(|m| m.content.contains("secreto") || m.content.contains("descartada") || m.content.contains("subagente")));

        let (items, next) = claude_list(Some(&dir.join("projects")), "login", None).unwrap();
        assert_eq!((items.len(), next), (1, None));
        assert_eq!(items[0]["title"], "Login roto");
        assert!(claude_list(Some(&dir.join("projects")), "nada", None).unwrap().0.is_empty());
        // Identificadores con rutas no se aceptan.
        assert!(claude::session_file(Some(dir.to_str().unwrap()), "..\\..\\x").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn turnos_de_codex_con_atribucion_y_estado() {
        let mut out = vec![];
        codex_turn(&json!({ "status": "completed", "startedAt": 10, "completedAt": 12, "items": [
            { "type": "userMessage", "id": "1", "content": [{ "type": "text", "text": "hola" }, { "type": "localImage", "path": "C:\\a.png" }] },
            { "type": "reasoning", "id": "2" },
            { "type": "agentMessage", "id": "3", "text": "uno" },
            { "type": "commandExecution", "id": "4" },
            { "type": "agentMessage", "id": "5", "text": "dos" },
        ] }), &mut out);
        codex_turn(&json!({ "status": "interrupted", "startedAt": 20, "items": [
            { "type": "userMessage", "id": "6", "content": [{ "type": "text", "text": "sigue" }] },
        ] }), &mut out);
        assert_eq!(out.len(), 4);
        assert_eq!((out[0].created_at, out[0].attachments[0]["name"].as_str()), (10_000, Some("a.png")));
        assert_eq!((out[1].content.as_str(), out[1].completed_at), ("uno\n\ndos", Some(12_000)));
        assert_eq!((out[3].role.as_str(), out[3].status.as_str(), out[3].content.as_str()), ("assistant", "interrupted", ""));
    }
}
