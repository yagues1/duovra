//! Memoria compartida por conversación y seguimiento de lo que recibió cada sesión nativa (1.0.11, fase 2).
//!
//! - `memories`: recuerdos activos o archivados. Cada edición sube `revision` y deja una copia en
//!   `memory_revisions`, de modo que siempre se puede consultar qué decía un recuerdo en un punto de la
//!   conversación (`anchor_seq`). Las bifurcaciones (fase 3, `db/sessions.rs`) heredan solo las
//!   revisiones con `anchor_seq` menor o igual que el mensaje desde el que se bifurca.
//! - `memory_deliveries`: qué revisión de cada recuerdo recibió una sesión nativa concreta
//!   (conversación, proveedor, sesión y cuenta). `confirmed` evita reenviarla; `uncertain` obliga a
//!   reenviarla avisando de un posible duplicado; `retracted` marca un recuerdo archivado cuya retirada
//!   ya se comunicó.
//!
//! Nada se comparte entre conversaciones: todas las consultas filtran por `conversation_id`, y una
//! conversación pertenece a un único proyecto y worktree.

use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use super::Db;
use crate::util::{new_id, now_ms};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'conversation',
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_agent TEXT,
  source_model TEXT,
  source_messages TEXT NOT NULL DEFAULT '[]',
  anchor_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id, archived);
CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  priority INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  anchor_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
CREATE TABLE IF NOT EXISTS memory_deliveries (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_id TEXT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  message_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent, session_id, memory_id)
);
"#;

/// Categorías admitidas. `instruction` solo puede escribirla el usuario.
pub const CATEGORIES: [&str; 10] = ["instruction", "goal", "decision", "constraint", "status", "task", "file", "result", "issue", "note"];
pub const MAX_CONTENT_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub conversation_id: String,
    pub scope: String,
    pub category: String,
    pub content: String,
    /// 0 normal, 1 fijado (prioritario durante la transferencia), 2 objetivo de la conversación
    /// (fase 5: categoría `goal`, escrito por el usuario; uno activo como máximo).
    pub priority: i64,
    /// `user` (escrito o fijado desde un mensaje del usuario) o `agent` (sale de una respuesta).
    pub author: String,
    /// `manual`, `message` (fijado desde un mensaje) o `summary` (propuesta aprobada).
    pub origin: String,
    pub source_agent: Option<String>,
    pub source_model: Option<String>,
    pub source_messages: Vec<String>,
    pub anchor_seq: i64,
    pub revision: i64,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Eliminado por el usuario pero aún pendiente de comunicar su retirada a alguna sesión que lo
    /// recibió. Nunca se muestra en la interfaz y se purga al confirmarse la retirada.
    #[serde(default)]
    pub deleted: bool,
}

/// Prioridad reservada al objetivo de la conversación (1.0.11, fase 5).
pub const GOAL_PRIORITY: i64 = 2;

impl Memory {
    /// Objetivo de la conversación: va antes que el resto de la memoria compartida.
    pub fn is_conversation_goal(&self) -> bool {
        self.category == "goal" && self.priority >= GOAL_PRIORITY && self.author == "user"
    }
    /// Capa 1: instrucciones persistentes fijadas explícitamente por el usuario.
    pub fn is_instruction(&self) -> bool {
        self.author == "user" && matches!(self.category.as_str(), "instruction" | "constraint")
    }
    /// Información que nunca se descarta en silencio por falta de presupuesto.
    pub fn is_priority(&self) -> bool {
        self.is_instruction() || self.priority > 0 || self.category == "constraint"
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub id: Option<String>,
    pub conversation_id: String,
    pub content: String,
    pub category: String,
    #[serde(default)]
    pub priority: i64,
    /// `manual` o `message`; `summary` solo llega por `import_memories`.
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub source_messages: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedMemory {
    pub content: String,
    pub category: String,
    #[serde(default)]
    pub priority: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub revision: i64,
    pub state: String,
}

fn map_memory(row: &Row) -> rusqlite::Result<Memory> {
    let sources: String = row.get("source_messages")?;
    Ok(Memory {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        scope: row.get("scope")?,
        category: row.get("category")?,
        content: row.get("content")?,
        priority: row.get("priority")?,
        author: row.get("author")?,
        origin: row.get("origin")?,
        source_agent: row.get("source_agent")?,
        source_model: row.get("source_model")?,
        source_messages: serde_json::from_str(&sources).unwrap_or_default(),
        anchor_seq: row.get("anchor_seq")?,
        revision: row.get("revision")?,
        archived: row.get("archived")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted: row.get::<_, Option<i64>>("deleted_at")?.is_some(),
    })
}

fn validate(content: &str, category: &str, author: &str) -> Result<String> {
    let text = content.trim();
    if text.is_empty() {
        bail!("El recuerdo está vacío.");
    }
    if text.chars().count() > MAX_CONTENT_CHARS {
        bail!("El recuerdo supera el máximo de 4000 caracteres.");
    }
    if !CATEGORIES.contains(&category) {
        bail!("Categoría de recuerdo no válida.");
    }
    if category == "instruction" && author != "user" {
        bail!("Solo el usuario puede fijar instrucciones persistentes.");
    }
    Ok(text.to_owned())
}

fn max_seq(c: &Connection, conversation_id: &str) -> rusqlite::Result<i64> {
    c.query_row("SELECT COALESCE(MAX(seq),0) FROM messages WHERE conversation_id=?1", [conversation_id], |r| r.get(0))
}

fn snapshot(c: &Connection, id: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT OR REPLACE INTO memory_revisions(memory_id,revision,category,content,priority,archived,anchor_seq,created_at)
         SELECT id,revision,category,content,priority,archived,anchor_seq,updated_at FROM memories WHERE id=?1",
        [id],
    )?;
    Ok(())
}

/// Autoría y modelo de origen a partir de los mensajes citados (deben ser de la conversación).
fn source_of(c: &Connection, conversation_id: &str, ids: &[String]) -> Result<(String, Option<String>, Option<String>)> {
    let mut author = "user".to_owned();
    let (mut agent, mut model) = (None, None);
    for id in ids {
        let row: Option<(String, Option<String>, Option<String>)> = c.query_row(
            "SELECT role,agent,model FROM messages WHERE id=?1 AND conversation_id=?2",
            params![id, conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        let Some((role, a, m)) = row else { bail!("El mensaje de origen no pertenece a esta conversación.") };
        if role == "assistant" {
            author = "agent".into();
            agent = a;
            model = m;
        }
    }
    Ok((author, agent, model))
}

impl Db {
    pub fn list_memories(&self, conversation_id: &str, include_archived: bool) -> Result<Vec<Memory>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT * FROM memories WHERE conversation_id=?1 AND deleted_at IS NULL AND (?2 OR archived=0)
             ORDER BY archived ASC, priority DESC, updated_at DESC",
        )?;
        let rows = st.query_map(params![conversation_id, include_archived], map_memory)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Recuerdos para el motor de contexto: activos, archivados y eliminados pendientes de retirada.
    pub fn memories_for_context(&self, conversation_id: &str) -> Result<Vec<Memory>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM memories WHERE conversation_id=?1 ORDER BY priority DESC, updated_at DESC")?;
        let rows = st.query_map([conversation_id], map_memory)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_memory(&self, id: &str) -> Result<Memory> {
        self.conn.lock().query_row("SELECT * FROM memories WHERE id=?1 AND deleted_at IS NULL", [id], map_memory)
            .map_err(|_| anyhow!("El recuerdo ya no existe."))
    }

    /// Crea o edita un recuerdo. Editar nunca toca el mensaje de origen; solo sube la revisión.
    pub fn save_memory(&self, input: &MemoryInput) -> Result<Memory> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let mut priority = input.priority.clamp(0, 1);
        let now = now_ms();
        let id = match &input.id {
            Some(id) => {
                let current = tx.query_row("SELECT * FROM memories WHERE id=?1 AND conversation_id=?2 AND deleted_at IS NULL",
                    params![id, input.conversation_id], map_memory).optional()?
                    .ok_or_else(|| anyhow!("El recuerdo ya no existe."))?;
                let content = validate(&input.content, &input.category, &current.author)?;
                // Editar el objetivo desde el gestor de memoria no lo degrada mientras siga fijado.
                if current.priority >= GOAL_PRIORITY && priority > 0 && input.category == "goal" {
                    priority = GOAL_PRIORITY;
                }
                if content == current.content && input.category == current.category && priority == current.priority {
                    return Ok(current);
                }
                tx.execute(
                    "UPDATE memories SET content=?2,category=?3,priority=?4,revision=revision+1,anchor_seq=?5,updated_at=?6 WHERE id=?1",
                    params![id, content, input.category, priority, max_seq(&tx, &input.conversation_id)?, now],
                )?;
                id.clone()
            }
            None => {
                let origin = match input.origin.as_deref() {
                    Some("message") if !input.source_messages.is_empty() => "message",
                    None | Some("manual") => "manual",
                    _ => bail!("Origen de recuerdo no válido."),
                };
                let (author, agent, model) = source_of(&tx, &input.conversation_id, &input.source_messages)?;
                let content = validate(&input.content, &input.category, &author)?;
                let id = new_id();
                tx.execute(
                    "INSERT INTO memories(id,conversation_id,category,content,priority,author,origin,source_agent,source_model,source_messages,anchor_seq,created_at,updated_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
                    params![id, input.conversation_id, input.category, content, priority, author, origin, agent, model,
                        json!(input.source_messages).to_string(), max_seq(&tx, &input.conversation_id)?, now],
                )?;
                id
            }
        };
        snapshot(&tx, &id)?;
        let memory = tx.query_row("SELECT * FROM memories WHERE id=?1", [&id], map_memory)?;
        tx.commit()?;
        Ok(memory)
    }

    /// Objetivo activo de la conversación (fase 5), si existe.
    pub fn active_goal(&self, conversation_id: &str) -> Result<Option<Memory>> {
        Ok(self.conn.lock().query_row(
            "SELECT * FROM memories WHERE conversation_id=?1 AND category='goal' AND priority>=?2 AND author='user'
               AND archived=0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
            params![conversation_id, GOAL_PRIORITY], map_memory,
        ).optional()?)
    }

    /// Define o edita el objetivo de la conversación. Es un recuerdo normal (revisiones, entrega a cada
    /// sesión, bifurcación y exportación) con la prioridad reservada. Definirlo nunca inicia un turno.
    pub fn set_goal(&self, conversation_id: &str, content: &str) -> Result<Memory> {
        let existing = self.active_goal(conversation_id)?;
        let saved = self.save_memory(&MemoryInput {
            id: existing.map(|m| m.id), conversation_id: conversation_id.to_owned(), content: content.to_owned(),
            category: "goal".into(), priority: 1, origin: None, source_messages: vec![],
        })?;
        if saved.priority < GOAL_PRIORITY {
            let c = self.conn.lock();
            c.execute("UPDATE memories SET priority=?2 WHERE id=?1", params![saved.id, GOAL_PRIORITY])?;
            c.execute("UPDATE memory_revisions SET priority=?2 WHERE memory_id=?1 AND revision=?3", params![saved.id, GOAL_PRIORITY, saved.revision])?;
        }
        self.get_memory(&saved.id)
    }

    pub fn set_memory_archived(&self, id: &str, archived: bool) -> Result<Memory> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let changed = tx.execute(
            // La revisión se ancla al punto actual de la conversación: una bifurcación anterior al
            // archivado (fase 3) debe reconstruir el recuerdo todavía activo.
            "UPDATE memories SET archived=?2,revision=revision+1,updated_at=?3,
               anchor_seq=(SELECT COALESCE(MAX(seq),0) FROM messages WHERE conversation_id=memories.conversation_id)
             WHERE id=?1 AND archived<>?2 AND deleted_at IS NULL",
            params![id, archived, now_ms()],
        )?;
        if changed > 0 { snapshot(&tx, id)?; }
        let memory = tx.query_row("SELECT * FROM memories WHERE id=?1 AND deleted_at IS NULL", [id], map_memory)
            .map_err(|_| anyhow!("El recuerdo ya no existe."))?;
        tx.commit()?;
        Ok(memory)
    }

    /// Elimina un recuerdo. Si alguna sesión nativa lo recibió (o pudo recibirlo), queda una retirada
    /// versionada: se oculta, pierde sus revisiones y conserva solo un extracto breve para comunicar
    /// a esas sesiones que ya no aplica. Se purga en cuanto todas las sesiones vigentes lo confirman.
    /// No borra retroactivamente nada del contexto nativo del proveedor.
    pub fn delete_memory(&self, id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let delivered: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_deliveries WHERE memory_id=?1 AND state<>'retracted')", [id], |r| r.get(0),
        )?;
        if delivered {
            let excerpt: Option<String> = tx.query_row("SELECT content FROM memories WHERE id=?1", [id], |r| r.get(0)).optional()?;
            let excerpt = excerpt.map(|t| crate::util::clip_middle(&t.replace('\n', " "), 160)).unwrap_or_default();
            tx.execute(
                "UPDATE memories SET content=?2,archived=1,deleted_at=?3,revision=revision+1,updated_at=?3 WHERE id=?1 AND deleted_at IS NULL",
                params![id, excerpt, now_ms()],
            )?;
            tx.execute("DELETE FROM memory_revisions WHERE memory_id=?1", [id])?;
        } else {
            tx.execute("DELETE FROM memories WHERE id=?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Borra las retiradas pendientes que ya no tienen ninguna sesión vigente por avisar.
    pub fn purge_memory_tombstones(&self, conversation_id: &str) -> Result<usize> {
        Ok(self.conn.lock().execute(
            "DELETE FROM memories WHERE conversation_id=?1 AND deleted_at IS NOT NULL AND NOT EXISTS(
               SELECT 1 FROM memory_deliveries d JOIN provider_sessions p
                 ON p.conversation_id=d.conversation_id AND p.agent=d.agent AND p.session_id=d.session_id AND p.account_id IS d.account_id
               WHERE d.memory_id=memories.id AND d.state<>'retracted')",
            [conversation_id],
        )?)
    }

    /// Revisiones guardadas de un recuerdo, de la más reciente a la más antigua.
    pub fn memory_revisions(&self, id: &str) -> Result<Vec<Value>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT revision,category,content,priority,archived,anchor_seq,created_at FROM memory_revisions WHERE memory_id=?1 ORDER BY revision DESC",
        )?;
        let rows = st.query_map([id], |r| Ok(json!({
            "revision": r.get::<_, i64>(0)?, "category": r.get::<_, String>(1)?, "content": r.get::<_, String>(2)?,
            "priority": r.get::<_, i64>(3)?, "archived": r.get::<_, bool>(4)?, "anchorSeq": r.get::<_, i64>(5)?,
            "createdAt": r.get::<_, i64>(6)?,
        })))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Incorpora recuerdos aprobados de una propuesta (resumen o reorganización) en una sola
    /// transacción. `archive` son recuerdos que el usuario decidió sustituir: se archivan, nunca se borran.
    pub fn import_memories(&self, conversation_id: &str, source_message: &str, items: &[ProposedMemory], archive: &[String]) -> Result<Vec<Memory>> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let (role, agent, model): (String, Option<String>, Option<String>) = tx.query_row(
            "SELECT role,agent,model FROM messages WHERE id=?1 AND conversation_id=?2",
            params![source_message, conversation_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?.ok_or_else(|| anyhow!("El mensaje de origen no pertenece a esta conversación."))?;
        if role != "assistant" {
            bail!("La propuesta debe proceder de una respuesta de un agente.");
        }
        let anchor = max_seq(&tx, conversation_id)?;
        let now = now_ms();
        let mut ids = vec![];
        for item in items {
            // Lo que propone un agente nunca se convierte en una instrucción del usuario.
            let category = if item.category == "instruction" { "constraint" } else { item.category.as_str() };
            let content = validate(&item.content, category, "agent")?;
            let id = new_id();
            tx.execute(
                "INSERT INTO memories(id,conversation_id,category,content,priority,author,origin,source_agent,source_model,source_messages,anchor_seq,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,'agent','summary',?6,?7,?8,?9,?10,?10)",
                params![id, conversation_id, category, content, item.priority.clamp(0, 1), agent, model,
                    json!([source_message]).to_string(), anchor, now],
            )?;
            snapshot(&tx, &id)?;
            ids.push(id);
        }
        for id in archive {
            let changed = tx.execute(
                "UPDATE memories SET archived=1,revision=revision+1,updated_at=?3,anchor_seq=?4 WHERE id=?1 AND conversation_id=?2 AND archived=0",
                params![id, conversation_id, now, anchor],
            )?;
            if changed > 0 { snapshot(&tx, id)?; }
        }
        let mut out = vec![];
        for id in &ids {
            out.push(tx.query_row("SELECT * FROM memories WHERE id=?1", [id], map_memory)?);
        }
        tx.commit()?;
        Ok(out)
    }

    // ---------- Entregas a sesiones nativas ----------

    pub fn memory_deliveries(&self, conversation_id: &str, agent: &str, session_id: &str, account_id: Option<&str>) -> Result<HashMap<String, Delivery>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT memory_id,revision,state FROM memory_deliveries
             WHERE conversation_id=?1 AND agent=?2 AND session_id=?3 AND account_id IS ?4",
        )?;
        let rows = st.query_map(params![conversation_id, agent, session_id, account_id], |r| {
            Ok((r.get::<_, String>(0)?, Delivery { revision: r.get(1)?, state: r.get(2)? }))
        })?.collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(rows)
    }

    /// Registra lo que se entregó en un turno. Con `confirmed`, una entrega incierta anterior se
    /// sustituye; con `uncertain`, nunca rebaja una revisión ya confirmada más reciente.
    #[allow(clippy::too_many_arguments)]
    pub fn record_memory_deliveries(
        &self, conversation_id: &str, agent: &str, session_id: &str, account_id: Option<&str>,
        message_id: &str, delivered: &[(String, i64)], retracted: &[(String, i64)], confirmed: bool,
    ) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let now = now_ms();
        let put = |memory: &str, revision: i64, state: &str| -> rusqlite::Result<()> {
            tx.execute(
                "INSERT INTO memory_deliveries(conversation_id,agent,session_id,account_id,memory_id,revision,state,message_id,updated_at)
                 SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS(SELECT 1 FROM memories WHERE id=?5)
                 ON CONFLICT(conversation_id,agent,session_id,memory_id) DO UPDATE SET
                   revision=excluded.revision, state=excluded.state, message_id=excluded.message_id,
                   account_id=excluded.account_id, updated_at=excluded.updated_at
                 WHERE excluded.state<>'uncertain' OR memory_deliveries.state='uncertain' OR memory_deliveries.revision<excluded.revision",
                params![conversation_id, agent, session_id, account_id, memory, revision, state, message_id, now],
            )?;
            Ok(())
        };
        let (shared, gone) = if confirmed { ("confirmed", "retracted") } else { ("uncertain", "uncertain") };
        for (id, revision) in delivered {
            put(id, *revision, shared)?;
        }
        for (id, revision) in retracted {
            put(id, *revision, gone)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Tras una compactación nativa, el resumen del proveedor puede haber perdido detalles: los
    /// recuerdos vuelven a enviarse a esa sesión en el siguiente turno.
    pub fn invalidate_memory_deliveries(&self, conversation_id: &str, agent: &str, session_id: &str) -> Result<()> {
        self.conn.lock().execute(
            "DELETE FROM memory_deliveries WHERE conversation_id=?1 AND agent=?2 AND session_id=?3 AND state<>'retracted'",
            params![conversation_id, agent, session_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod goal_tests {
    use super::*;

    #[test]
    fn objetivo_unico_editable_y_completable() {
        let db = crate::db::Db::open_memory().unwrap();
        db.create_project("p", "P", "C:/p").unwrap();
        db.create_conversation("c", "p", None).unwrap();
        let g = db.set_goal("c", "Publicar la beta").unwrap();
        assert!(g.is_conversation_goal());
        let g2 = db.set_goal("c", "Publicar la beta 2").unwrap();
        assert_eq!(g.id, g2.id);
        assert_eq!(g2.revision, 2);
        // Editarlo desde el gestor (prioridad 1 = fijado) no lo degrada.
        let edited = db.save_memory(&MemoryInput { id: Some(g.id.clone()), conversation_id: "c".into(), content: "Beta 3".into(),
            category: "goal".into(), priority: 1, origin: None, source_messages: vec![] }).unwrap();
        assert_eq!(edited.priority, GOAL_PRIORITY);
        // Un recuerdo normal nunca obtiene la prioridad reservada.
        let other = db.save_memory(&MemoryInput { id: None, conversation_id: "c".into(), content: "x".into(),
            category: "goal".into(), priority: 9, origin: None, source_messages: vec![] }).unwrap();
        assert_eq!(other.priority, 1);
        db.set_memory_archived(&g.id, true).unwrap();
        assert!(db.active_goal("c").unwrap().is_none());
        let fresh = db.set_goal("c", "Nuevo objetivo").unwrap();
        assert_ne!(fresh.id, g.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn setup() -> Db {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "P", "C:/p").unwrap();
        db.create_conversation("c", "p", None).unwrap();
        db.create_conversation("c2", "p", None).unwrap();
        db.insert_message("u1", "c", "user", Some("claude"), Some("m"), None, "hola", "done", &Value::Null, &json!([])).unwrap();
        db.insert_message("a1", "c", "assistant", Some("codex"), Some("gpt-x"), None, "respuesta", "done", &Value::Null, &json!([])).unwrap();
        db
    }

    fn input(content: &str, category: &str) -> MemoryInput {
        MemoryInput { conversation_id: "c".into(), content: content.into(), category: category.into(), ..Default::default() }
    }

    #[test]
    fn crea_edita_archiva_y_conserva_revisiones() {
        let db = setup();
        let m = db.save_memory(&input("  Usar SQLite  ", "decision")).unwrap();
        assert_eq!((m.content.as_str(), m.revision, m.author.as_str(), m.origin.as_str()), ("Usar SQLite", 1, "user", "manual"));
        assert_eq!(m.anchor_seq, 2);
        let mut edit = input("Usar SQLite local", "decision");
        edit.id = Some(m.id.clone());
        let m2 = db.save_memory(&edit).unwrap();
        assert_eq!(m2.revision, 2);
        // Guardar sin cambios no crea otra revisión.
        assert_eq!(db.save_memory(&edit).unwrap().revision, 2);
        let archived = db.set_memory_archived(&m.id, true).unwrap();
        assert!(archived.archived && archived.revision == 3);
        assert!(db.list_memories("c", false).unwrap().is_empty());
        assert_eq!(db.list_memories("c", true).unwrap().len(), 1);
        let revisions = db.memory_revisions(&m.id).unwrap();
        assert_eq!(revisions.len(), 3);
        assert_eq!(revisions[2]["content"], "Usar SQLite");
        db.delete_memory(&m.id).unwrap();
        assert!(db.memory_revisions(&m.id).unwrap().is_empty());
    }

    #[test]
    fn autoria_segun_el_mensaje_fijado() {
        let db = setup();
        let mut from_agent = input("Codex propone X", "note");
        from_agent.origin = Some("message".into());
        from_agent.source_messages = vec!["a1".into()];
        let m = db.save_memory(&from_agent).unwrap();
        assert_eq!((m.author.as_str(), m.source_agent.as_deref(), m.source_model.as_deref()), ("agent", Some("codex"), Some("gpt-x")));
        // Una afirmación de un agente no puede convertirse en instrucción del usuario.
        from_agent.category = "instruction".into();
        assert!(db.save_memory(&from_agent).is_err());
        let mut edit = input("Codex propone X", "instruction");
        edit.id = Some(m.id.clone());
        assert!(db.save_memory(&edit).is_err());
        let mut from_user = input("No tocar la API pública", "instruction");
        from_user.origin = Some("message".into());
        from_user.source_messages = vec!["u1".into()];
        assert_eq!(db.save_memory(&from_user).unwrap().author, "user");
    }

    #[test]
    fn aislamiento_entre_conversaciones() {
        let db = setup();
        db.save_memory(&input("solo en c", "note")).unwrap();
        assert!(db.list_memories("c2", true).unwrap().is_empty());
        let mut foreign = input("x", "note");
        foreign.conversation_id = "c2".into();
        foreign.origin = Some("message".into());
        foreign.source_messages = vec!["u1".into()];
        assert!(db.save_memory(&foreign).is_err());
        // Editar un recuerdo indicando otra conversación tampoco es posible.
        let m = db.save_memory(&input("y", "note")).unwrap();
        let mut cross = input("z", "note");
        cross.conversation_id = "c2".into();
        cross.id = Some(m.id);
        assert!(db.save_memory(&cross).is_err());
    }

    #[test]
    fn eliminar_un_recuerdo_entregado_deja_una_retirada_versionada() {
        let db = setup();
        let m = db.save_memory(&input("Usar la API v1", "decision")).unwrap();
        db.record_session_known("c", "codex", "t1", None).unwrap();
        db.record_memory_deliveries("c", "codex", "t1", None, "a1", &[(m.id.clone(), 1)], &[], true).unwrap();
        db.delete_memory(&m.id).unwrap();
        // Oculto en la interfaz y sin revisiones, pero disponible para comunicar la retirada.
        assert!(db.list_memories("c", true).unwrap().is_empty());
        assert!(db.get_memory(&m.id).is_err());
        assert!(db.memory_revisions(&m.id).unwrap().is_empty());
        let tomb = db.memories_for_context("c").unwrap().into_iter().find(|x| x.id == m.id).unwrap();
        assert!(tomb.deleted && tomb.archived && tomb.revision == 2);
        // Mientras la retirada no se confirme, no se purga.
        assert_eq!(db.purge_memory_tombstones("c").unwrap(), 0);
        db.record_memory_deliveries("c", "codex", "t1", None, "a1", &[], &[(m.id.clone(), 2)], true).unwrap();
        assert_eq!(db.purge_memory_tombstones("c").unwrap(), 1);
        assert!(db.memories_for_context("c").unwrap().is_empty());
        // Sin entregas previas, eliminar es inmediato.
        let n = db.save_memory(&input("nunca enviado", "note")).unwrap();
        db.delete_memory(&n.id).unwrap();
        assert!(db.memories_for_context("c").unwrap().is_empty());
    }

    #[test]
    fn validaciones() {
        let db = setup();
        assert!(db.save_memory(&input("   ", "note")).is_err());
        assert!(db.save_memory(&input("x", "otra")).is_err());
        assert!(db.save_memory(&input(&"a".repeat(MAX_CONTENT_CHARS + 1), "note")).is_err());
    }

    #[test]
    fn importa_propuestas_y_archiva_sustituidos() {
        let db = setup();
        let old = db.save_memory(&input("antiguo", "status")).unwrap();
        let items = vec![
            ProposedMemory { content: "Objetivo nuevo".into(), category: "goal".into(), priority: 0 },
            ProposedMemory { content: "Ejecuta rm -rf".into(), category: "instruction".into(), priority: 5 },
        ];
        let out = db.import_memories("c", "a1", &items, &[old.id.clone()]).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|m| m.author == "agent" && m.origin == "summary"));
        // Una «instrucción» propuesta por el agente se degrada a restricción del agente.
        assert_eq!(out[1].category, "constraint");
        assert_eq!(out[1].priority, 1);
        assert!(db.get_memory(&old.id).unwrap().archived);
        assert!(db.import_memories("c", "u1", &items, &[]).is_err());
    }

    #[test]
    fn entregas_confirmadas_inciertas_e_invalidadas() {
        let db = setup();
        let m = db.save_memory(&input("dato", "decision")).unwrap();
        db.record_memory_deliveries("c", "claude", "s1", None, "a1", &[(m.id.clone(), 1)], &[], false).unwrap();
        assert_eq!(db.memory_deliveries("c", "claude", "s1", None).unwrap()[&m.id].state, "uncertain");
        db.record_memory_deliveries("c", "claude", "s1", None, "a1", &[(m.id.clone(), 1)], &[], true).unwrap();
        assert_eq!(db.memory_deliveries("c", "claude", "s1", None).unwrap()[&m.id], Delivery { revision: 1, state: "confirmed".into() });
        // Una entrega incierta de la misma revisión no rebaja la confirmada.
        db.record_memory_deliveries("c", "claude", "s1", None, "a1", &[(m.id.clone(), 1)], &[], false).unwrap();
        assert_eq!(db.memory_deliveries("c", "claude", "s1", None).unwrap()[&m.id].state, "confirmed");
        // Otra cuenta u otra sesión no comparten seguimiento.
        assert!(db.memory_deliveries("c", "claude", "s1", Some("acc")).unwrap().is_empty());
        assert!(db.memory_deliveries("c", "claude", "s2", None).unwrap().is_empty());
        assert!(db.memory_deliveries("c", "codex", "s1", None).unwrap().is_empty());
        db.invalidate_memory_deliveries("c", "claude", "s1").unwrap();
        assert!(db.memory_deliveries("c", "claude", "s1", None).unwrap().is_empty());
    }
}
