//! Persistencia local en SQLite.
//!
//! No se guardan secretos: las credenciales viven en la configuración de cada CLI
//! (`~/.codex`, `~/.claude` o el directorio de la cuenta seleccionada). Aquí solo hay
//! proyectos, conversaciones, mensajes, referencias de sesión de proveedor y ajustes.

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

use crate::util::now_ms;

mod background_images;
pub(crate) use background_images::parse_image_id as background_image_id;
pub mod queue;
pub mod insights;
pub mod instructions;
pub mod interactions;
pub mod memory;
pub mod prompts;
pub mod sessions;
pub mod worktrees;

const DEFAULT_CONVERSATION_TITLE: &str = "Nueva conversación";

pub struct Db {
    conn: Mutex<Connection>,
    _owner: Option<Mutex<Connection>>,
    /// Carpeta de datos de la instancia. `None` solo en las pruebas en memoria.
    dir: Option<std::path::PathBuf>,
}

/// Abre la base con el modo WAL y aplica el esquema y las migraciones aditivas.
fn connect(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    backup_before_schema_update(&conn, path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    init_schema(&mut conn)?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_agent: Option<String>,
    pub last_model: Option<String>,
    pub last_effort: Option<String>,
    /// Última combinación de modelo y esfuerzo usada con cada agente: `{ "claude": { "model", "effort" }, ... }`.
    pub agent_prefs: Value,
    pub draft: String,
    pub draft_attachments: Vec<String>,
    /// Permisos elegidos en el compositor para cada agente: `{ "claude": { "mode" }, "codex": { "sandbox", "approval" } }`.
    pub permission_prefs: Value,
    /// Tiene al menos un mensaje. Sin mensajes es un chat provisional (1.0.9).
    pub started: bool,
    /// Worktree en el que trabaja (1.0.9). `None`: directorio principal del proyecto.
    pub worktree_id: Option<String>,
    /// Transferencia de contexto compartido (1.0.11): `{ mode, memories, messages }`.
    pub context_prefs: Value,
    /// Fijada en la barra lateral (1.0.11, fase 3): momento en que se fijó.
    #[serde(default)]
    pub pinned_at: Option<i64>,
    /// Archivada (1.0.11, fase 3): fuera de la lista habitual, sin perder nada.
    #[serde(default)]
    pub archived_at: Option<i64>,
    /// Procedencia (1.0.11, fase 3): `{}` o `{ kind: "fork" | "import", ... }`. Ver `db/sessions.rs`.
    #[serde(default)]
    pub origin: Value,
    /// Modo de trabajo elegido para cada agente (1.0.11, fase 4): `{ "claude": "plan", "codex": "build" }`.
    /// Sin entrada, el agente trabaja en modo Construir.
    #[serde(default)]
    pub work_modes: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub role: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub content: String,
    pub items: Value,
    pub status: String,
    pub error: Option<String>,
    pub usage: Value,
    pub context_note: Value,
    pub attachments: Value,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub conversation_id: String,
    pub agent: String,
    pub session_id: String,
    /// Último mensaje cuya recepción por la sesión nativa está confirmada.
    pub last_seq: i64,
    pub account_id: Option<String>,
    /// Primer mensaje de usuario cuya entrega a esta sesión no pudo confirmarse (1.0.11).
    pub uncertain_seq: Option<i64>,
    /// Estado nativo conocido de la sesión: compactaciones solicitadas o completadas (1.0.11).
    pub native_context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub agent: String,
    pub label: String,
    /// Directorio de configuración de la CLI (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`).
    /// `None` = configuración por defecto del usuario.
    pub config_dir: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub agent: String,
    pub model: String,
    pub runs: i64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: Option<f64>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_agent TEXT,
  last_model TEXT,
  last_effort TEXT,
  draft TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  effort TEXT,
  content TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT,
  usage TEXT NOT NULL DEFAULT 'null',
  context_note TEXT NOT NULL DEFAULT 'null',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_seq ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS provider_sessions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  account_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);
"#;

const SESSION_SELECT: &str =
    "SELECT conversation_id,agent,session_id,last_seq,account_id,uncertain_seq,native_context FROM provider_sessions";

fn map_session(r: &Row) -> rusqlite::Result<ProviderSession> {
    Ok(ProviderSession {
        conversation_id: r.get(0)?,
        agent: r.get(1)?,
        session_id: r.get(2)?,
        last_seq: r.get(3)?,
        account_id: r.get(4)?,
        uncertain_seq: r.get(5)?,
        native_context: r.get::<_, String>(6).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({})),
    })
}

fn json_col(row: &Row, idx: &str) -> rusqlite::Result<Value> {
    let s: String = row.get(idx)?;
    Ok(serde_json::from_str(&s).unwrap_or(Value::Null))
}

fn map_message(row: &Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        seq: row.get("seq")?,
        role: row.get("role")?,
        agent: row.get("agent")?,
        model: row.get("model")?,
        effort: row.get("effort")?,
        content: row.get("content")?,
        items: json_col(row, "items")?,
        status: row.get("status")?,
        error: row.get("error")?,
        usage: json_col(row, "usage")?,
        context_note: json_col(row, "context_note")?,
        attachments: json_col(row, "attachments")?,
        created_at: row.get("created_at")?,
        completed_at: row.get("completed_at")?,
    })
}

fn map_conversation(row: &Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_agent: row.get("last_agent")?,
        last_model: row.get("last_model")?,
        last_effort: row.get("last_effort")?,
        agent_prefs: json_col(row, "agent_prefs").map(|v| if v.is_object() { v } else { json!({}) })?,
        draft: row.get("draft")?,
        draft_attachments: serde_json::from_value(json_col(row, "draft_attachments")?).unwrap_or_default(),
        permission_prefs: json_col(row, "permission_prefs").map(|v| if v.is_object() { v } else { json!({}) })?,
        started: row.get("started")?,
        worktree_id: row.get("worktree_id")?,
        context_prefs: json_col(row, "context_prefs").map(|v| if v.is_object() { v } else { json!({}) })?,
        pinned_at: row.get("pinned_at")?,
        archived_at: row.get("archived_at")?,
        origin: json_col(row, "origin").map(|v| if v.is_object() { v } else { json!({}) })?,
        work_modes: json_col(row, "work_modes").map(|v| if v.is_object() { v } else { json!({}) })?,
    })
}

/// Migraciones aditivas: solo añaden columnas con valor por defecto, nunca borran datos.
fn migrate(conn: &Connection) -> Result<()> {
    let has = |table: &str, col: &str| -> Result<bool> {
        let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names.iter().any(|n| n == col))
    };
    if !has("conversations", "agent_prefs")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN agent_prefs TEXT NOT NULL DEFAULT '{}';")?;
        // Conserva la última selección conocida como preferencia de su agente.
        conn.execute_batch(
            "UPDATE conversations SET agent_prefs = json_object(last_agent, json_object('model', last_model, 'effort', last_effort))              WHERE last_agent IS NOT NULL AND last_model IS NOT NULL;",
        )?;
    }
    if !has("conversations", "draft_attachments")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN draft_attachments TEXT NOT NULL DEFAULT '[]';")?;
    }
    if !has("conversations", "auto_title_pending")? {
        conn.execute_batch(
            "ALTER TABLE conversations ADD COLUMN auto_title_pending INTEGER NOT NULL DEFAULT 0;
             UPDATE conversations SET auto_title_pending=1 WHERE title='Nueva conversación'
               AND NOT EXISTS (
                 SELECT 1 FROM messages WHERE conversation_id=conversations.id
                   AND role='user' AND trim(content, char(9, 10, 13, 32)) <> ''
               );",
        )?;
    }
    if !has("conversations", "worktree_id")? {
        // Las conversaciones existentes quedan en el directorio principal de su proyecto.
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN worktree_id TEXT;")?;
    }
    if !has("conversations", "permission_prefs")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN permission_prefs TEXT NOT NULL DEFAULT '{}';")?;
    }
    // 1.0.11 · Context Engine 2.0. Las conversaciones existentes quedan en modo automático.
    if !has("conversations", "context_prefs")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN context_prefs TEXT NOT NULL DEFAULT '{}';")?;
    }
    if !has("provider_sessions", "uncertain_seq")? {
        conn.execute_batch("ALTER TABLE provider_sessions ADD COLUMN uncertain_seq INTEGER;")?;
    }
    let has_memories: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memories')", [], |r| r.get(0))?;
    if has_memories && !has("memories", "deleted_at")? {
        conn.execute_batch("ALTER TABLE memories ADD COLUMN deleted_at INTEGER;")?;
    }
    if !has("provider_sessions", "native_context")? {
        conn.execute_batch("ALTER TABLE provider_sessions ADD COLUMN native_context TEXT NOT NULL DEFAULT '{}';")?;
    }
    // 1.0.11 · Session Manager. Las conversaciones existentes quedan sin fijar, sin archivar y sin procedencia.
    if !has("conversations", "pinned_at")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN pinned_at INTEGER;")?;
    }
    if !has("conversations", "archived_at")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN archived_at INTEGER;")?;
    }
    if !has("conversations", "origin")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT '{}';")?;
    }
    // 1.0.11 · Planning & Decisions. Las conversaciones existentes trabajan en modo Construir.
    if !has("conversations", "work_modes")? {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN work_modes TEXT NOT NULL DEFAULT '{}';")?;
    }
    insights::migrate(conn)
}

/// Columnas de una conversación más `started` (si ya tiene mensajes).
const CONVERSATION_SELECT: &str =
    "SELECT conversations.*, EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id) AS started FROM conversations";

/// Una conversación está vacía si no conserva nada del usuario: ni mensajes, ni borrador, ni
/// adjuntos, ni encargos de la cola (en cualquier estado), ni sesiones de proveedor, ni intervenciones.
const EMPTY_CONVERSATION: &str = "trim(conversations.draft, char(9, 10, 13, 32))=''
    AND conversations.draft_attachments IN ('[]', '')
    AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM execution_queue WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM queue_pauses WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM steer_attempts WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM provider_sessions WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM memories WHERE conversation_id=conversations.id)
    AND NOT EXISTS(SELECT 1 FROM instructions WHERE conversation_id=conversations.id)";

fn init_schema(conn: &mut Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", true)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(SCHEMA)?;
    tx.execute_batch(queue::SCHEMA)?;
    tx.execute_batch(background_images::SCHEMA)?;
    tx.execute_batch(worktrees::SCHEMA)?;
    tx.execute_batch(memory::SCHEMA)?;
    tx.execute_batch(sessions::SCHEMA)?;
    tx.execute_batch(interactions::SCHEMA)?;
    // Compatibilidad con datos de las funciones retiradas de la fase 6 (sin cambiar user_version).
    let had_retirements: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='legacy_instruction_context')",
        [], |r| r.get(0),
    )?;
    tx.execute_batch(instructions::SCHEMA)?;
    tx.execute_batch(prompts::SCHEMA)?;
    migrate(&tx)?;
    if !had_retirements {
        instructions::migrate_retirements(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

fn backup_before_schema_update(conn: &Connection, path: &Path) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let legacy: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projects')",
        [], |r| r.get(0),
    )?;
    if !legacy {
        return Ok(());
    }
    let has_background_images: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='background_images')",
        [], |r| r.get(0),
    )?;
    let backup = if version == 0 {
        path.with_extension("pre-0.6.0.sqlite3.bak")
    } else if !has_background_images {
        path.with_extension("pre-1.0.0.sqlite3.bak")
    } else {
        return Ok(());
    };
    if backup.try_exists()? {
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.sqlite3.tmp", crate::util::new_id()));
    let result = (|| -> Result<()> {
        let target = temporary.to_str().context("Ruta de respaldo no válida")?;
        // SQLite toma una instantánea coherente, incluidas las transacciones del WAL.
        conn.execute("VACUUM INTO ?1", [target])?;
        std::fs::OpenOptions::new().write(true).open(&temporary)?.sync_all()?;
        std::fs::rename(&temporary, &backup)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("No se pudo guardar el respaldo previo a la migración")
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        // Solo la instancia propietaria de los datos puede reconciliar la cola al abrir.
        let owner = Connection::open(path.with_extension("sqlite3.lock"))?;
        owner.busy_timeout(std::time::Duration::ZERO)?;
        owner.execute_batch("BEGIN EXCLUSIVE").map_err(|err| {
            anyhow!("No se pudo obtener acceso exclusivo a los datos de Duovra: {err}")
        })?;
        // Una restauración preparada se aplica con el bloqueo tomado y antes de abrir los datos.
        let restored = crate::backup::apply_pending(path)?;
        let conn = match connect(path) {
            Ok(conn) => {
                if let Some(restored) = restored {
                    restored.finish(path);
                }
                conn
            }
            Err(error) => match restored {
                // La copia restaurada no abre: se devuelven los datos anteriores intactos.
                Some(restored) => {
                    restored.rollback(path, &error)?;
                    connect(path)?
                }
                None => return Err(error),
            },
        };
        let db = Db {
            dir: path.parent().map(Path::to_path_buf),
            _owner: Some(Mutex::new(owner)),
            conn: Mutex::new(conn),
        };
        db.recover_interrupted()?;
        db.recover_interactions()?;
        let _ = db.recover_background_images();
        Ok(db)
    }

    /// Carpeta que contiene la base de datos (copias, restauraciones pendientes).
    pub fn data_dir(&self) -> Option<std::path::PathBuf> {
        self.dir.clone()
    }

    /// Instantánea consistente de la base (incluye las transacciones del WAL) en una ruta nueva.
    pub(crate) fn snapshot_to(&self, target: &Path) -> Result<()> {
        crate::backup::snapshot_into(&self.conn.lock(), target)
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        init_schema(&mut conn)?;
        Ok(Db { dir: None, _owner: None, conn: Mutex::new(conn) })
    }

    /// Un turno sin cierre persistido pierde el control de esta instancia. Se conserva
    /// su progreso y se pide revisión antes de confiar en su resultado.
    fn recover_interrupted(&self) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute(
            "INSERT INTO queue_pauses(conversation_id, reason, message_id)
             SELECT conversation_id, 'restart', id FROM messages WHERE status='running'
             ON CONFLICT(conversation_id) DO UPDATE SET reason='restart', message_id=excluded.message_id",
            [],
        )?;
        tx.execute(
            "UPDATE messages SET status='interrupted', error=COALESCE(error, 'La aplicación se cerró mientras el agente trabajaba.'), completed_at=?1 WHERE status='running'",
            params![now_ms()],
        )?;
        {
            let mut stmt = tx.prepare("SELECT id,conversation_id,message_id,payload FROM steer_attempts WHERE state='pending'")?;
            let attempts = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, cid, parent, data) in attempts {
                let payload: Value = serde_json::from_str(&data)?;
                Self::write_message(&tx, &id, &cid, "user", Some("codex"), payload["model"].as_str(), payload["effort"].as_str(),
                    payload["text"].as_str().unwrap_or_default(), "interrupted",
                    &json!({ "mode": "none", "steer": "unconfirmed", "parentMessageId": parent }),
                    &payload["attachments"])?;
                tx.execute(
                    "INSERT INTO queue_pauses(conversation_id,reason,message_id) VALUES (?1,'steer',?2)
                     ON CONFLICT(conversation_id) DO UPDATE SET reason='steer', message_id=excluded.message_id",
                     params![cid, parent],
                )?;
            }
        }
        tx.execute("DELETE FROM steer_attempts WHERE state='pending'", [])?;
        tx.execute("UPDATE execution_queue SET state='review', detail='La aplicación se cerró durante este encargo.' WHERE state='running'", [])?;
        tx.execute(
            "INSERT OR IGNORE INTO queue_pauses(conversation_id, reason)
             SELECT conversation_id, 'restored' FROM execution_queue WHERE state IN ('pending', 'blocked', 'review')",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ---------- Proyectos ----------

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,name,path,created_at,updated_at FROM projects ORDER BY created_at ASC")?;
        let rows = st
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_project(&self, id: &str) -> Result<Project> {
        let c = self.conn.lock();
        c.query_row(
            "SELECT id,name,path,created_at,updated_at FROM projects WHERE id=?1",
            params![id],
            |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )
        .map_err(|_| anyhow!("Proyecto no encontrado"))
    }

    pub fn create_project(&self, id: &str, name: &str, path: &str) -> Result<Project> {
        let now = now_ms();
        self.conn.lock().execute(
            "INSERT INTO projects(id,name,path,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",
            params![id, name, path, now],
        )?;
        self.get_project(id)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE projects SET name=?2, updated_at=?3 WHERE id=?1",
            params![id, name, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        if c.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id
              WHERE c.project_id=?1 AND m.status='running')",
            [id], |r| r.get::<_, bool>(0),
        )? {
            return Err(anyhow!("Detén las ejecuciones activas antes de eliminar el proyecto."));
        }
        c.execute("DELETE FROM projects WHERE id=?1", [id])?;
        Ok(())
    }

    // ---------- Conversaciones ----------

    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{CONVERSATION_SELECT} ORDER BY updated_at DESC"))?;
        let rows = st.query_map([], map_conversation)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_conversation(&self, id: &str) -> Result<Conversation> {
        self.conn
            .lock()
            .query_row(&format!("{CONVERSATION_SELECT} WHERE id=?1"), params![id], map_conversation)
            .map_err(|_| anyhow!("Conversación no encontrada"))
    }

    #[cfg(test)]
    pub fn create_conversation(&self, id: &str, project_id: &str, title: Option<&str>) -> Result<Conversation> {
        self.create_conversation_in(id, project_id, title, None)
    }

    /// Crea una conversación en el directorio principal o en uno de los worktrees del proyecto.
    pub fn create_conversation_in(&self, id: &str, project_id: &str, title: Option<&str>, worktree_id: Option<&str>) -> Result<Conversation> {
        let now = now_ms();
        let c = self.conn.lock();
        if let Some(worktree) = worktree_id {
            let valid: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM worktrees WHERE id=?1 AND project_id=?2 AND retired=0)",
                params![worktree, project_id], |r| r.get(0),
            )?;
            if !valid {
                return Err(anyhow!("Ese worktree ya no pertenece a este proyecto."));
            }
        }
        c.execute(
            "INSERT INTO conversations(id,project_id,title,created_at,updated_at,auto_title_pending,worktree_id) VALUES(?1,?2,?3,?4,?4,?5,?6)",
            params![id, project_id, title.unwrap_or(DEFAULT_CONVERSATION_TITLE), now, title.is_none(), worktree_id],
        )?;
        drop(c);
        self.get_conversation(id)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE conversations SET title=?2,auto_title_pending=0 WHERE id=?1", params![id, title])?;
        Ok(())
    }

    pub fn set_automatic_title(&self, id: &str, title: String) -> Result<Option<String>> {
        if title.is_empty() {
            return Ok(None);
        }
        let updated = self.conn.lock().execute(
            "UPDATE conversations SET title=?2,auto_title_pending=0 WHERE id=?1 AND auto_title_pending=1",
            params![id, title],
        )?;
        Ok((updated == 1).then_some(title))
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        if c.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND status='running')",
            [id], |r| r.get::<_, bool>(0),
        )? {
            return Err(anyhow!("Detén la ejecución activa antes de eliminar la conversación."));
        }
        c.execute("DELETE FROM conversations WHERE id=?1", [id])?;
        Ok(())
    }

    /// Descarta un chat provisional abandonado. Solo borra si sigue completamente vacío: la
    /// comprobación y el borrado van en una única sentencia. Devuelve si se eliminó.
    pub fn discard_empty_conversation(&self, id: &str) -> Result<bool> {
        let deleted = self.conn.lock().execute(
            &format!("DELETE FROM conversations WHERE id=?1 AND {EMPTY_CONVERSATION}"),
            [id],
        )?;
        Ok(deleted == 1)
    }

    /// Limpia al iniciar las conversaciones que no conservan nada (ver `EMPTY_CONVERSATION`).
    pub fn purge_empty_conversations(&self) -> Result<usize> {
        Ok(self.conn.lock().execute(&format!("DELETE FROM conversations WHERE {EMPTY_CONVERSATION}"), [])?)
    }

    /// Permisos del compositor para un agente de esta conversación. No toca los ajustes globales.
    pub fn set_conversation_permissions(&self, id: &str, agent: &str, permissions: &Value) -> Result<()> {
        let c = self.conn.lock();
        let current: Option<String> = c
            .query_row("SELECT permission_prefs FROM conversations WHERE id=?1", params![id], |r| r.get(0))
            .optional()?;
        let mut prefs: Value = current.and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        prefs[agent] = permissions.clone();
        c.execute("UPDATE conversations SET permission_prefs=?2 WHERE id=?1", params![id, prefs.to_string()])?;
        Ok(())
    }

    /// Modo de trabajo del compositor para un agente de esta conversación (`build` o `plan`).
    pub fn set_conversation_work_mode(&self, id: &str, agent: &str, mode: &str) -> Result<()> {
        if !crate::agents::AGENTS.contains(&agent) || !crate::agents::WORK_MODES.contains(&mode) {
            return Err(anyhow!("Modo de trabajo no admitido."));
        }
        self.conn.lock().execute(
            "UPDATE conversations SET work_modes=json_set(CASE WHEN json_valid(work_modes) THEN work_modes ELSE '{}' END, '$.' || ?2, ?3) WHERE id=?1",
            params![id, agent, mode],
        )?;
        Ok(())
    }

    pub fn set_draft(&self, id: &str, draft: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE conversations SET draft=?2 WHERE id=?1", params![id, draft])?;
        Ok(())
    }

    pub fn set_draft_attachments(&self, id: &str, paths: &[String]) -> Result<()> {
        self.conn.lock().execute("UPDATE conversations SET draft_attachments=?2 WHERE id=?1", params![id, serde_json::to_string(paths)?])?;
        Ok(())
    }

    /// Guarda la selección activa y la recuerda como preferencia propia de ese agente (AUD-004).
    pub fn set_conversation_prefs(&self, id: &str, agent: &str, model: &str, effort: Option<&str>) -> Result<()> {
        let c = self.conn.lock();
        let current: Option<String> = c
            .query_row("SELECT agent_prefs FROM conversations WHERE id=?1", params![id], |r| r.get(0))
            .optional()?;
        let mut prefs: Value = current.and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        // Una selección explícita puede llegar antes de que el catálogo confirme un modelo.
        if model.is_empty() {
            c.execute(
                "UPDATE conversations SET last_agent=?2, last_model=?3, last_effort=?4 WHERE id=?1",
                params![id, agent, prefs[agent]["model"].as_str(), prefs[agent]["effort"].as_str()],
            )?;
            return Ok(());
        }
        prefs[agent] = json!({ "model": model, "effort": effort });
        c.execute(
            "UPDATE conversations SET last_agent=?2, last_model=?3, last_effort=?4, agent_prefs=?5 WHERE id=?1",
            params![id, agent, model, effort, prefs.to_string()],
        )?;
        Ok(())
    }

    pub fn touch_conversation(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE conversations SET updated_at=?2 WHERE id=?1", params![id, now_ms()])?;
        Ok(())
    }

    // ---------- Mensajes ----------

    /// Consulta de lectura por texto persistido. Como máximo, un mensaje por conversación.
    pub fn search_conversations(&self, query: &str) -> Result<Vec<Value>> {
        fn search(conn: &Connection, query: &str) -> Result<Vec<Value>> {
            let mut stmt = conn.prepare(
                "SELECT c.id,c.title,p.name,m.id,
                        substr(m.content, max(1,instr(lower(m.content),lower(?1))-28), 132)
                 FROM conversations c
                 JOIN projects p ON p.id=c.project_id
                 JOIN messages m ON m.id=(
                    SELECT id FROM messages WHERE conversation_id=c.id
                      AND role IN ('user','assistant') AND instr(lower(content),lower(?1))>0
                    ORDER BY seq DESC LIMIT 1
                 )
                 ORDER BY c.updated_at DESC LIMIT 24",
            )?;
            let rows = stmt.query_map([query], |row| {
                Ok(json!({
                    "conversationId": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "project": row.get::<_, String>(2)?,
                    "messageId": row.get::<_, String>(3)?,
                    "snippet": row.get::<_, String>(4)?,
                }))
            })?.collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        }
        let query = query.trim();
        if query.chars().count() < 2 || query.chars().count() > 160 {
            return Ok(Vec::new());
        }
        let connection = self.conn.lock();
        match connection.path().filter(|path| !path.is_empty()).map(String::from) {
            Some(path) => {
                drop(connection);
                let reader = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                search(&reader, query)
            }
            None => search(&connection, query),
        }
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM messages WHERE conversation_id=?1 ORDER BY seq ASC")?;
        let rows = st
            .query_map(params![conversation_id], map_message)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_message(&self, id: &str) -> Result<Message> {
        self.conn
            .lock()
            .query_row("SELECT * FROM messages WHERE id=?1", params![id], map_message)
            .map_err(|_| anyhow!("Mensaje no encontrado"))
    }

    fn next_seq(c: &Connection, conversation_id: &str) -> rusqlite::Result<i64> {
        c.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?1",
            params![conversation_id],
            |r| r.get(0),
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_message(
        &self,
        id: &str,
        conversation_id: &str,
        role: &str,
        agent: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        content: &str,
        status: &str,
        context_note: &Value,
        attachments: &Value,
    ) -> Result<Message> {
        Self::write_message(&self.conn.lock(), id, conversation_id, role, agent, model, effort, content, status, context_note, attachments)
    }

    #[allow(clippy::too_many_arguments)]
    fn write_message(
        c: &Connection, id: &str, conversation_id: &str, role: &str, agent: Option<&str>, model: Option<&str>,
        effort: Option<&str>, content: &str, status: &str, context_note: &Value, attachments: &Value,
    ) -> Result<Message> {
        let seq = Self::next_seq(c, conversation_id)?;
        c.execute(
            "INSERT INTO messages(id,conversation_id,seq,role,agent,model,effort,content,status,context_note,attachments,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, conversation_id, seq, role, agent, model, effort, content, status, context_note.to_string(), attachments.to_string(), now_ms()],
        )?;
        Ok(c.query_row("SELECT * FROM messages WHERE id=?1", params![id], map_message)?)
    }

    pub fn update_message_progress(&self, id: &str, content: &str, items: &Value) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET content=?2, items=?3 WHERE id=?1 AND status='running'",
            params![id, content, items.to_string()],
        )?;
        Ok(())
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn finish_message(
        &self,
        id: &str,
        content: &str,
        items: &Value,
        status: &str,
        error: Option<&str>,
        usage: &Value,
        model: Option<&str>,
    ) -> Result<Message> {
        Self::write_finished_message(&self.conn.lock(), id, content, items, status, error, usage, model)
    }

    #[allow(clippy::too_many_arguments)]
    fn write_finished_message(
        c: &Connection, id: &str, content: &str, items: &Value, status: &str,
        error: Option<&str>, usage: &Value, model: Option<&str>,
    ) -> Result<Message> {
        c.execute(
            "UPDATE messages SET content=?2, items=?3, status=?4, error=?5, usage=?6, completed_at=?7, model=COALESCE(?8, model) WHERE id=?1",
            params![id, content, items.to_string(), status, error, usage.to_string(), now_ms(), model],
        )?;
        Ok(c.query_row("SELECT * FROM messages WHERE id=?1", params![id], map_message)?)
    }

    pub fn update_context_note(&self, id: &str, note: &Value) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE messages SET context_note=?2 WHERE id=?1", params![id, note.to_string()])?;
        Ok(())
    }

    // ---------- Sesiones de proveedor ----------

    pub fn get_provider_session(&self, conversation_id: &str, agent: &str) -> Result<Option<ProviderSession>> {
        Ok(self
            .conn
            .lock()
            .query_row(
                &format!("{SESSION_SELECT} WHERE conversation_id=?1 AND agent=?2"),
                params![conversation_id, agent],
                map_session,
            )
            .optional()?)
    }

    pub fn list_provider_sessions(&self, conversation_id: &str) -> Result<Vec<ProviderSession>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{SESSION_SELECT} WHERE conversation_id=?1"))?;
        let rows = st.query_map(params![conversation_id], map_session)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Registra la sesión nativa en cuanto se conoce, sin dar nada por recibido: una sesión nueva
    /// (o de otra cuenta) empieza sin mensajes confirmados; la misma sesión conserva su cursor.
    pub fn record_session_known(&self, conversation_id: &str, agent: &str, session_id: &str, account_id: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO provider_sessions(conversation_id,agent,session_id,last_seq,account_id,updated_at) VALUES(?1,?2,?3,0,?4,?5)
             ON CONFLICT(conversation_id,agent) DO UPDATE SET
                 last_seq=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN provider_sessions.last_seq ELSE 0 END,
                 uncertain_seq=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN provider_sessions.uncertain_seq END,
                 native_context=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN provider_sessions.native_context ELSE '{}' END,
                 session_id=excluded.session_id, account_id=excluded.account_id, updated_at=excluded.updated_at",
            params![conversation_id, agent, session_id, account_id, now_ms()],
        )?;
        Ok(())
    }

    /// La entrega de un turno no pudo confirmarse: el cursor no avanza y se recuerda desde dónde
    /// hay que reenviar avisando de un posible duplicado.
    pub fn mark_session_uncertain(&self, conversation_id: &str, agent: &str, session_id: &str, account_id: Option<&str>, user_seq: i64) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE provider_sessions SET uncertain_seq=MIN(COALESCE(uncertain_seq, ?5), ?5), updated_at=?6
             WHERE conversation_id=?1 AND agent=?2 AND session_id=?3 AND account_id IS ?4",
            params![conversation_id, agent, session_id, account_id, user_seq, now_ms()],
        )?;
        Ok(())
    }

    /// Fusiona `patch` en el estado nativo de la sesión (compactaciones), solo si sigue siendo la misma.
    pub fn patch_native_context(&self, conversation_id: &str, agent: &str, session_id: &str, patch: &Value) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE provider_sessions SET native_context=json_patch(native_context, ?4) WHERE conversation_id=?1 AND agent=?2 AND session_id=?3",
            params![conversation_id, agent, session_id, patch.to_string()],
        )?;
        Ok(())
    }

    pub fn set_context_prefs(&self, id: &str, prefs: &Value) -> Result<()> {
        let changed = self.conn.lock().execute("UPDATE conversations SET context_prefs=?2 WHERE id=?1", params![id, prefs.to_string()])?;
        if changed == 0 {
            return Err(anyhow!("Conversación no encontrada"));
        }
        Ok(())
    }

    pub fn upsert_provider_session(
        &self,
        conversation_id: &str,
        agent: &str,
        session_id: &str,
        last_seq: i64,
        account_id: Option<&str>,
    ) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO provider_sessions(conversation_id,agent,session_id,last_seq,account_id,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(conversation_id,agent) DO UPDATE SET session_id=excluded.session_id,
                 last_seq=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN MAX(provider_sessions.last_seq,excluded.last_seq) ELSE excluded.last_seq END,
                 uncertain_seq=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          AND COALESCE(provider_sessions.uncertain_seq, 0) <= excluded.last_seq THEN NULL
                          WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN provider_sessions.uncertain_seq END,
                 native_context=CASE WHEN provider_sessions.session_id=excluded.session_id AND provider_sessions.account_id IS excluded.account_id
                          THEN provider_sessions.native_context ELSE '{}' END,
                 account_id=excluded.account_id, updated_at=excluded.updated_at",
            params![conversation_id, agent, session_id, last_seq, account_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_provider_session(&self, conversation_id: &str, agent: &str) -> Result<()> {
        self.conn.lock().execute(
            "DELETE FROM provider_sessions WHERE conversation_id=?1 AND agent=?2",
            params![conversation_id, agent],
        )?;
        Ok(())
    }

    // ---------- Ajustes ----------

    pub fn get_settings(&self) -> Result<serde_json::Map<String, Value>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT key,value FROM settings")?;
        let mut map = serde_json::Map::new();
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            map.insert(k, serde_json::from_str(&v).unwrap_or(Value::Null));
        }
        Ok(map)
    }

    pub fn get_setting(&self, key: &str) -> Option<Value> {
        self.conn
            .lock()
            .query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn get_setting_str(&self, key: &str) -> Option<String> {
        self.get_setting(key).and_then(|v| v.as_str().map(str::to_string))
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.conn.lock();
        if key == background_images::SETTINGS_KEY {
            background_images::validate_references(&conn, value)?;
        }
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    // ---------- Cuentas ----------

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id,agent,label,config_dir,created_at FROM accounts ORDER BY created_at ASC")?;
        let rows = st
            .query_map([], |r| {
                Ok(Account {
                    id: r.get(0)?,
                    agent: r.get(1)?,
                    label: r.get(2)?,
                    config_dir: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn add_account(&self, id: &str, agent: &str, label: &str, config_dir: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO accounts(id,agent,label,config_dir,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![id, agent, label, config_dir, now_ms()],
        )?;
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM accounts WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- Consumo ----------

    pub fn usage_summary(&self, since_ms: i64) -> Result<Vec<UsageRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT agent, model, COUNT(*), SUM(input_tokens), SUM(cached_input_tokens), SUM(output_tokens), SUM(cost_usd)
             FROM usage_log WHERE created_at >= ?1 GROUP BY agent, model ORDER BY agent, SUM(output_tokens) DESC",
        )?;
        let rows = st
            .query_map(params![since_ms], |r| {
                Ok(UsageRow {
                    agent: r.get(0)?,
                    model: r.get(1)?,
                    runs: r.get(2)?,
                    input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    cached_input_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    output_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    cost_usd: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferencias_independientes_por_agente() {
        let db = Db::open_memory().unwrap();
        db.create_project("p1", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c1", "p1", Some("Nueva")).unwrap();
        db.set_conversation_prefs("c1", "claude", "haiku", Some("medium")).unwrap();
        db.set_conversation_prefs("c1", "codex", "gpt-6-luna", Some("high")).unwrap();
        let c = db.get_conversation("c1").unwrap();
        assert_eq!(c.last_agent.as_deref(), Some("codex"));
        assert_eq!(c.agent_prefs["claude"]["model"], "haiku");
        assert_eq!(c.agent_prefs["claude"]["effort"], "medium");
        assert_eq!(c.agent_prefs["codex"]["model"], "gpt-6-luna");
        assert_eq!(c.agent_prefs["codex"]["effort"], "high");
    }

    #[test]
    fn limpia_solo_conversaciones_completamente_vacias() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        for id in ["vacia", "espacios", "borrador", "adjunto", "sesion", "mensaje", "pausa"] {
            db.create_conversation(id, "p", None).unwrap();
        }
        db.set_draft("espacios", "  \n ").unwrap();
        db.set_draft("borrador", "pendiente").unwrap();
        db.set_draft_attachments("adjunto", &["C:/a.txt".into()]).unwrap();
        db.upsert_provider_session("sesion", "codex", "thread-1", 0, None).unwrap();
        db.conn.lock().execute_batch(
            "INSERT INTO messages(id,conversation_id,seq,role,created_at) VALUES('m','mensaje',1,'user',0);
             INSERT INTO queue_pauses(conversation_id,reason) VALUES('pausa','manual');",
        ).unwrap();
        db.set_conversation_permissions("vacia", "claude", &json!({ "mode": "plan" })).unwrap();
        assert!(!db.get_conversation("vacia").unwrap().started);
        assert!(db.get_conversation("mensaje").unwrap().started);
        assert!(!db.discard_empty_conversation("borrador").unwrap());
        assert!(db.discard_empty_conversation("vacia").unwrap());
        assert_eq!(db.purge_empty_conversations().unwrap(), 1);
        let mut left: Vec<_> = db.list_conversations().unwrap().into_iter().map(|c| c.id).collect();
        left.sort();
        assert_eq!(left, ["adjunto", "borrador", "mensaje", "pausa", "sesion"]);
    }

    #[test]
    fn permisos_por_conversacion_y_agente() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c", "p", None).unwrap();
        db.set_conversation_permissions("c", "claude", &json!({ "mode": "acceptEdits" })).unwrap();
        db.set_conversation_permissions("c", "codex", &json!({ "sandbox": "read-only", "approval": "untrusted" })).unwrap();
        db.set_conversation_prefs("c", "codex", "gpt-6-luna", Some("high")).unwrap();
        let c = db.get_conversation("c").unwrap();
        assert_eq!(c.permission_prefs["claude"]["mode"], "acceptEdits");
        assert_eq!(c.permission_prefs["codex"]["sandbox"], "read-only");
        assert_eq!(c.permission_prefs["codex"]["approval"], "untrusted");
    }

    #[test]
    fn migracion_conserva_la_ultima_seleccion() {
        let mut conn = Connection::open_in_memory().unwrap();
        // SCHEMA es el esquema anterior: agent_prefs solo lo añade la migración.
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','P','C:/x',0,0);
             INSERT INTO conversations(id,project_id,title,created_at,updated_at,last_agent,last_model,last_effort) VALUES('c','p','T',0,0,'claude','haiku','medium');",
        )
        .unwrap();
        init_schema(&mut conn).unwrap();
        init_schema(&mut conn).unwrap(); // idempotente
        let db = Db { dir: None, _owner: None, conn: Mutex::new(conn) };
        let c = db.get_conversation("c").unwrap();
        assert_eq!(c.agent_prefs["claude"]["model"], "haiku");
        assert_eq!(c.title, "T");
    }

    #[test]
    fn migracion_context_engine_conserva_sesiones_y_conversaciones() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Base de la 1.0.10: sesiones sin cursor incierto ni estado nativo, conversaciones sin modo.
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','P','C:/x',0,0);
             INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','T',0,0);
             INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES('m1','c',1,'user','hola',0);
             INSERT INTO provider_sessions(conversation_id,agent,session_id,last_seq,account_id,updated_at) VALUES('c','codex','t1',7,NULL,0);",
        ).unwrap();
        init_schema(&mut conn).unwrap();
        init_schema(&mut conn).unwrap();
        let db = Db { dir: None, _owner: None, conn: Mutex::new(conn) };
        let c = db.get_conversation("c").unwrap();
        assert_eq!(c.context_prefs, json!({}));
        let s = db.get_provider_session("c", "codex").unwrap().unwrap();
        assert_eq!((s.last_seq, s.uncertain_seq, s.native_context.clone()), (7, None, json!({})));
        assert_eq!(db.list_messages("c").unwrap().len(), 1);
        assert!(db.list_memories("c", true).unwrap().is_empty());
    }

    #[test]
    fn cursor_de_sesion_solo_avanza_al_confirmar() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "P", "C:/p").unwrap();
        db.create_conversation("c", "p", None).unwrap();
        // Una sesión recién conocida no ha recibido nada todavía.
        db.record_session_known("c", "claude", "s1", None).unwrap();
        assert_eq!(db.get_provider_session("c", "claude").unwrap().unwrap().last_seq, 0);
        db.upsert_provider_session("c", "claude", "s1", 4, None).unwrap();
        // Volver a conocer la misma sesión conserva el cursor confirmado.
        db.record_session_known("c", "claude", "s1", None).unwrap();
        assert_eq!(db.get_provider_session("c", "claude").unwrap().unwrap().last_seq, 4);
        // Entrega incierta: el cursor no avanza y se recuerda desde dónde reenviar.
        db.mark_session_uncertain("c", "claude", "s1", None, 5).unwrap();
        db.mark_session_uncertain("c", "claude", "s1", None, 7).unwrap();
        let s = db.get_provider_session("c", "claude").unwrap().unwrap();
        assert_eq!((s.last_seq, s.uncertain_seq), (4, Some(5)));
        // Otra cuenta no hereda nada de la sesión.
        db.mark_session_uncertain("c", "claude", "s1", Some("otra"), 2).unwrap();
        assert_eq!(db.get_provider_session("c", "claude").unwrap().unwrap().uncertain_seq, Some(5));
        // Confirmar un turno posterior resuelve la incertidumbre.
        db.upsert_provider_session("c", "claude", "s1", 8, None).unwrap();
        let s = db.get_provider_session("c", "claude").unwrap().unwrap();
        assert_eq!((s.last_seq, s.uncertain_seq), (8, None));
        // El estado nativo se fusiona y se reinicia con una sesión distinta.
        db.patch_native_context("c", "claude", "s1", &json!({ "compaction": { "state": "completed" } })).unwrap();
        assert_eq!(db.get_provider_session("c", "claude").unwrap().unwrap().native_context["compaction"]["state"], "completed");
        db.record_session_known("c", "claude", "s2", Some("acc")).unwrap();
        let s = db.get_provider_session("c", "claude").unwrap().unwrap();
        assert_eq!((s.session_id.as_str(), s.last_seq, s.native_context.clone()), ("s2", 0, json!({})));
    }

    #[test]
    fn migracion_fallida_revierte_columnas_y_tablas_nuevas() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch("CREATE TABLE run_insights (conflict INTEGER);").unwrap();
        assert!(init_schema(&mut conn).is_err());
        assert!(conn.prepare("SELECT draft_attachments FROM conversations").is_err());
        assert!(conn.prepare("SELECT * FROM execution_queue").is_err());
        assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 0);
        conn.execute_batch("DROP TABLE run_insights").unwrap();
        init_schema(&mut conn).unwrap();
    }

    #[test]
    fn titulo_automatico_solo_mientras_esta_pendiente() {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "Demo", "C:/tmp").unwrap();
        db.create_conversation("draft", "p", None).unwrap();
        db.create_conversation("manual", "p", None).unwrap();
        db.create_conversation("named", "p", Some(DEFAULT_CONVERSATION_TITLE)).unwrap();

        assert_eq!(db.set_automatic_title("draft", String::new()).unwrap(), None);
        assert_eq!(db.set_automatic_title("draft", "Verifica el historial".into()).unwrap().as_deref(), Some("Verifica el historial"));
        assert_eq!(db.set_automatic_title("draft", "Otro mensaje".into()).unwrap(), None);
        assert_eq!(db.get_conversation("draft").unwrap().title, "Verifica el historial");

        db.rename_conversation("manual", DEFAULT_CONVERSATION_TITLE).unwrap();
        for id in ["manual", "named"] {
            assert_eq!(db.set_automatic_title(id, "Primer mensaje".into()).unwrap(), None);
            assert_eq!(db.get_conversation(id).unwrap().title, DEFAULT_CONVERSATION_TITLE);
        }
    }

    #[test]
    fn crud_y_secuencia_de_mensajes() {
        let db = Db::open_memory().unwrap();
        db.create_project("p1", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c1", "p1", Some("Nueva")).unwrap();
        let a = db
            .insert_message("m1", "c1", "user", None, None, None, "hola", "done", &Value::Null, &json!([]))
            .unwrap();
        let b = db
            .insert_message("m2", "c1", "assistant", Some("codex"), Some("gpt"), None, "", "running", &Value::Null, &json!([]))
            .unwrap();
        assert_eq!(a.seq, 1);
        assert_eq!(b.seq, 2);
        let done = db
            .finish_message("m2", "respuesta", &json!([{"kind":"text"}]), "done", None, &json!({"outputTokens": 3}), None)
            .unwrap();
        assert_eq!(done.status, "done");
        assert_eq!(done.items[0]["kind"], "text");
        db.upsert_provider_session("c1", "codex", "t-1", 2, None).unwrap();
        db.upsert_provider_session("c1", "codex", "t-1", 4, None).unwrap();
        assert_eq!(db.get_provider_session("c1", "codex").unwrap().unwrap().last_seq, 4);
        db.delete_project("p1").unwrap();
        assert!(db.list_messages("c1").unwrap().is_empty());
    }
}
