//! Persistencia local en SQLite.
//!
//! No se guardan secretos: las credenciales viven en la configuración de cada CLI
//! (`~/.codex`, `~/.claude` o el directorio de la cuenta seleccionada). Aquí solo hay
//! proyectos, conversaciones, mensajes, referencias de sesión de proveedor y ajustes.

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

use crate::util::now_ms;

pub struct Db {
    conn: Mutex<Connection>,
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
    pub last_seq: i64,
    pub account_id: Option<String>,
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
PRAGMA foreign_keys = ON;
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
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        let db = Db { conn: Mutex::new(conn) };
        db.recover_interrupted()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    /// Las ejecuciones que seguían activas al cerrar la aplicación no pueden continuar:
    /// el proceso del agente terminó con ella. Se marcan como interrumpidas, conservando
    /// el contenido parcial que se hubiera guardado.
    fn recover_interrupted(&self) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET status='interrupted', error=COALESCE(error, 'La aplicación se cerró mientras el agente trabajaba.'), completed_at=?1 WHERE status='running'",
            params![now_ms()],
        )?;
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
        self.conn.lock().execute("DELETE FROM projects WHERE id=?1", params![id])?;
        Ok(())
    }

    // ---------- Conversaciones ----------

    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM conversations ORDER BY updated_at DESC")?;
        let rows = st.query_map([], map_conversation)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_conversation(&self, id: &str) -> Result<Conversation> {
        self.conn
            .lock()
            .query_row("SELECT * FROM conversations WHERE id=?1", params![id], map_conversation)
            .map_err(|_| anyhow!("Conversación no encontrada"))
    }

    pub fn create_conversation(&self, id: &str, project_id: &str, title: &str) -> Result<Conversation> {
        let now = now_ms();
        self.conn.lock().execute(
            "INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",
            params![id, project_id, title, now],
        )?;
        self.get_conversation(id)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE conversations SET title=?2 WHERE id=?1", params![id, title])?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM conversations WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn set_draft(&self, id: &str, draft: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE conversations SET draft=?2 WHERE id=?1", params![id, draft])?;
        Ok(())
    }

    /// Guarda la selección activa y la recuerda como preferencia propia de ese agente (AUD-004).
    pub fn set_conversation_prefs(&self, id: &str, agent: &str, model: &str, effort: Option<&str>) -> Result<()> {
        let c = self.conn.lock();
        let current: Option<String> = c
            .query_row("SELECT agent_prefs FROM conversations WHERE id=?1", params![id], |r| r.get(0))
            .optional()?;
        let mut prefs: Value = current.and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
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
        {
            let c = self.conn.lock();
            let seq = Self::next_seq(&c, conversation_id)?;
            c.execute(
                "INSERT INTO messages(id,conversation_id,seq,role,agent,model,effort,content,status,context_note,attachments,created_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    id,
                    conversation_id,
                    seq,
                    role,
                    agent,
                    model,
                    effort,
                    content,
                    status,
                    context_note.to_string(),
                    attachments.to_string(),
                    now_ms()
                ],
            )?;
        }
        self.get_message(id)
    }

    pub fn update_message_progress(&self, id: &str, content: &str, items: &Value) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET content=?2, items=?3 WHERE id=?1",
            params![id, content, items.to_string()],
        )?;
        Ok(())
    }

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
        self.conn.lock().execute(
            "UPDATE messages SET content=?2, items=?3, status=?4, error=?5, usage=?6, completed_at=?7, model=COALESCE(?8, model) WHERE id=?1",
            params![id, content, items.to_string(), status, error, usage.to_string(), now_ms(), model],
        )?;
        self.get_message(id)
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
                "SELECT conversation_id,agent,session_id,last_seq,account_id FROM provider_sessions WHERE conversation_id=?1 AND agent=?2",
                params![conversation_id, agent],
                |r| {
                    Ok(ProviderSession {
                        conversation_id: r.get(0)?,
                        agent: r.get(1)?,
                        session_id: r.get(2)?,
                        last_seq: r.get(3)?,
                        account_id: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn list_provider_sessions(&self, conversation_id: &str) -> Result<Vec<ProviderSession>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT conversation_id,agent,session_id,last_seq,account_id FROM provider_sessions WHERE conversation_id=?1",
        )?;
        let rows = st
            .query_map(params![conversation_id], |r| {
                Ok(ProviderSession {
                    conversation_id: r.get(0)?,
                    agent: r.get(1)?,
                    session_id: r.get(2)?,
                    last_seq: r.get(3)?,
                    account_id: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
             ON CONFLICT(conversation_id,agent) DO UPDATE SET session_id=excluded.session_id, last_seq=excluded.last_seq, account_id=excluded.account_id, updated_at=excluded.updated_at",
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
        self.conn.lock().execute(
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

    pub fn log_usage(
        &self,
        conversation_id: &str,
        agent: &str,
        model: &str,
        input: i64,
        cached: i64,
        output: i64,
        cost: Option<f64>,
    ) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO usage_log(conversation_id,agent,model,input_tokens,cached_input_tokens,output_tokens,cost_usd,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![conversation_id, agent, model, input, cached, output, cost, now_ms()],
        )?;
        Ok(())
    }

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
        db.create_conversation("c1", "p1", "Nueva").unwrap();
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
    fn migracion_conserva_la_ultima_seleccion() {
        let conn = Connection::open_in_memory().unwrap();
        // SCHEMA es el esquema anterior: agent_prefs solo lo añade la migración.
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','P','C:/x',0,0);
             INSERT INTO conversations(id,project_id,title,created_at,updated_at,last_agent,last_model,last_effort) VALUES('c','p','T',0,0,'claude','haiku','medium');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // idempotente
        let db = Db { conn: Mutex::new(conn) };
        let c = db.get_conversation("c").unwrap();
        assert_eq!(c.agent_prefs["claude"]["model"], "haiku");
        assert_eq!(c.title, "T");
    }

    #[test]
    fn crud_y_secuencia_de_mensajes() {
        let db = Db::open_memory().unwrap();
        db.create_project("p1", "Demo", "C:/tmp").unwrap();
        db.create_conversation("c1", "p1", "Nueva").unwrap();
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
