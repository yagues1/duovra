//! Planes y preguntas de los agentes (1.0.11, fase 4 · Planning & Decisions).
//!
//! Cada solicitud que un agente dirige al usuario mediante un mecanismo nativo (un plan propuesto
//! con `ExitPlanMode` o un elemento `plan` de Codex, una pregunta de `AskUserQuestion` o
//! `item/tool/requestUserInput`) se guarda como una *interacción* con identificador propio de
//! Duovra. El identificador nunca se reutiliza: una bifurcación copia el historial con
//! identificadores nuevos y sin solicitudes activas.
//!
//! Estados:
//! - Plan: `pending` (espera decisión), `approved`, `changes_requested`, `rejected`,
//!   `superseded` (llegó una versión posterior), `interrupted` (la solicitud nativa ya no existe),
//!   `cancelled` (se canceló la ejecución) e `historical` (copia en una bifurcación).
//! - Pregunta: `pending`, `answered`, `dismissed`, `interrupted`, `cancelled` e `historical`.
//!
//! `native = 1` indica que una ejecución del proveedor espera la respuesta. Al reiniciar Duovra esas
//! solicitudes ya no existen y pasan a `interrupted`. Un plan de Codex no tiene solicitud nativa: su
//! turno termina al proponerlo y la aprobación inicia un turno nuevo.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use super::Db;
use crate::util::{new_id, now_ms};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  run_id TEXT,
  agent TEXT NOT NULL,
  account_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  item_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  native INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  response TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS interactions_conversation ON interactions(conversation_id, created_at);
"#;

pub const KINDS: [&str; 2] = ["plan", "question"];
/// Estados en los que un plan admite una decisión del usuario.
pub const PLAN_ACTIONABLE: [&str; 2] = ["pending", "interrupted"];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub run_id: Option<String>,
    pub agent: String,
    pub account_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: String,
    pub item_id: Option<String>,
    pub version: i64,
    pub native: bool,
    pub status: String,
    pub payload: Value,
    pub response: Value,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

fn map(row: &Row) -> rusqlite::Result<Interaction> {
    let json = |col: &str| -> rusqlite::Result<Value> {
        Ok(row.get::<_, Option<String>>(col)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
    };
    Ok(Interaction {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        message_id: row.get("message_id")?,
        run_id: row.get("run_id")?,
        agent: row.get("agent")?,
        account_id: row.get("account_id")?,
        session_id: row.get("session_id")?,
        kind: row.get("kind")?,
        item_id: row.get("item_id")?,
        version: row.get("version")?,
        native: row.get::<_, i64>("native")? != 0,
        status: row.get("status")?,
        payload: json("payload")?,
        response: json("response")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
    })
}

/// Datos de una interacción nueva.
pub struct NewInteraction<'a> {
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub run_id: &'a str,
    pub agent: &'a str,
    pub account_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub kind: &'a str,
    pub item_id: Option<&'a str>,
    pub native: bool,
    pub payload: &'a Value,
}

impl Db {
    /// Registra una interacción pendiente. Un plan recibe la versión siguiente de la conversación y
    /// deja como `superseded` los planes anteriores que seguían esperando decisión. Devuelve la
    /// interacción y los planes sustituidos.
    pub fn create_interaction(&self, new: &NewInteraction) -> Result<(Interaction, Vec<String>)> {
        if !KINDS.contains(&new.kind) {
            return Err(anyhow!("Tipo de interacción no admitido."));
        }
        let id = new_id();
        let now = now_ms();
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let mut superseded = vec![];
        let version = if new.kind == "plan" {
            let mut st = tx.prepare(
                "SELECT id FROM interactions WHERE conversation_id=?1 AND kind='plan' AND status IN ('pending','interrupted')",
            )?;
            superseded = st.query_map([new.conversation_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(st);
            tx.execute(
                "UPDATE interactions SET status='superseded', native=0, resolved_at=?2
                 WHERE conversation_id=?1 AND kind='plan' AND status IN ('pending','interrupted')",
                params![new.conversation_id, now],
            )?;
            tx.query_row(
                "SELECT COALESCE(MAX(version),0)+1 FROM interactions WHERE conversation_id=?1 AND kind='plan'",
                [new.conversation_id], |r| r.get::<_, i64>(0),
            )?
        } else {
            1
        };
        tx.execute(
            "INSERT INTO interactions(id,conversation_id,message_id,run_id,agent,account_id,session_id,kind,item_id,version,native,status,payload,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending',?12,?13)",
            params![id, new.conversation_id, new.message_id, new.run_id, new.agent, new.account_id, new.session_id, new.kind,
                new.item_id, version, new.native as i64, new.payload.to_string(), now],
        )?;
        let created = tx.query_row("SELECT * FROM interactions WHERE id=?1", [&id], map)?;
        tx.commit()?;
        Ok((created, superseded))
    }

    pub fn get_interaction(&self, id: &str) -> Result<Interaction> {
        self.conn.lock().query_row("SELECT * FROM interactions WHERE id=?1", [id], map).optional()?
            .ok_or_else(|| anyhow!("La solicitud ya no existe."))
    }

    pub fn list_interactions(&self, conversation_id: &str) -> Result<Vec<Interaction>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM interactions WHERE conversation_id=?1 ORDER BY created_at, rowid")?;
        let rows = st.query_map([conversation_id], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Cambio de estado atómico: solo se aplica si el estado actual es uno de `from`. Evita
    /// responder dos veces la misma solicitud aunque lleguen dos decisiones a la vez.
    pub fn transition_interaction(&self, id: &str, from: &[&str], to: &str, response: Option<&Value>) -> Result<bool> {
        let from = serde_json::to_string(from)?;
        let changed = self.conn.lock().execute(
            "UPDATE interactions SET status=?3, native=0, resolved_at=?4, response=COALESCE(?5, response)
             WHERE id=?1 AND status IN (SELECT value FROM json_each(?2))",
            params![id, from, to, now_ms(), response.map(Value::to_string)],
        )?;
        Ok(changed == 1)
    }

    /// Cierra las solicitudes nativas que seguían abiertas en una ejecución terminada o cancelada.
    pub fn close_run_interactions(&self, run_id: &str, status: &str) -> Result<Vec<String>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id FROM interactions WHERE run_id=?1 AND native=1 AND status='pending'")?;
        let ids = st.query_map([run_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        c.execute(
            "UPDATE interactions SET status=?2, native=0, resolved_at=?3 WHERE run_id=?1 AND native=1 AND status='pending'",
            params![run_id, status, now_ms()],
        )?;
        Ok(ids)
    }

    /// Al abrir: ninguna ejecución sobrevive a un reinicio, así que sus solicitudes nativas ya no existen.
    pub(super) fn recover_interactions(&self) -> Result<usize> {
        Ok(self.conn.lock().execute(
            "UPDATE interactions SET status='interrupted', native=0, resolved_at=?1 WHERE native=1 AND status='pending'",
            [now_ms()],
        )?)
    }

    /// Conversaciones con algo que espera al usuario (planes y preguntas pendientes).
    pub fn pending_interactions(&self) -> Result<Vec<Value>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT conversation_id, COUNT(*) FROM interactions WHERE status='pending' GROUP BY conversation_id",
        )?;
        let rows = st.query_map([], |r| Ok(json!({ "conversationId": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? })))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Último plan aprobado de una conversación (para el contexto de un turno de implementación).
    pub fn approved_plan(&self, conversation_id: &str, id: &str) -> Result<Interaction> {
        let found = self.get_interaction(id)?;
        if found.conversation_id != conversation_id || found.kind != "plan" || found.status != "approved" {
            return Err(anyhow!("El plan aprobado no pertenece a esta conversación."));
        }
        Ok(found)
    }

    /// Refleja el estado de una interacción en su elemento de la cronología del mensaje (lo que leen
    /// el historial, la exportación y el Context Engine). Solo actualiza mensajes ya cerrados: los de
    /// una ejecución activa se actualizan desde la propia ejecución.
    pub fn patch_message_item(&self, message_id: &str, item_id: &str, patch: &Value) -> Result<bool> {
        let c = self.conn.lock();
        let items: Option<String> = c.query_row(
            "SELECT items FROM messages WHERE id=?1 AND status<>'running'", [message_id], |r| r.get(0),
        ).optional()?;
        let Some(mut items) = items.and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return Ok(false) };
        let Some(item) = items.as_array_mut().and_then(|list| list.iter_mut().find(|i| i["id"] == item_id)) else { return Ok(false) };
        if let (Some(dst), Some(src)) = (item.as_object_mut(), patch.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        c.execute("UPDATE messages SET items=?2 WHERE id=?1", params![message_id, items.to_string()])?;
        Ok(true)
    }
}

/// Copia el historial de planes y preguntas de los mensajes bifurcados (fase 3 + 4). Cada copia
/// recibe un identificador nuevo y queda desligada de cualquier ejecución: lo que seguía pendiente
/// pasa a `historical` (no se puede responder ni aprobar desde la copia).
pub(super) fn copy_for_fork(tx: &Transaction, source: &str, target: &str, messages: &HashMap<String, String>) -> Result<usize> {
    let rows: Vec<Interaction> = {
        let mut st = tx.prepare("SELECT * FROM interactions WHERE conversation_id=?1 ORDER BY created_at, rowid")?;
        let rows = st.query_map([source], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut copied = 0;
    for row in rows {
        let Some(message) = messages.get(&row.message_id) else { continue };
        let status = match row.status.as_str() {
            "pending" | "interrupted" => "historical",
            other => other,
        };
        tx.execute(
            "INSERT INTO interactions(id,conversation_id,message_id,run_id,agent,account_id,session_id,kind,item_id,version,native,status,payload,response,created_at,resolved_at)
             VALUES(?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9,0,?10,?11,?12,?13,?14)",
            params![new_id(), target, message, row.agent, row.account_id, row.session_id, row.kind, row.item_id, row.version, status,
                row.payload.to_string(), (!row.response.is_null()).then(|| row.response.to_string()), row.created_at, row.resolved_at],
        )?;
        copied += 1;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Db, String, String) {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "P", "C:/p").unwrap();
        db.create_conversation("c", "p", None).unwrap();
        db.insert_message("u1", "c", "user", Some("codex"), Some("m"), None, "hola", "done", &json!({}), &json!([])).unwrap();
        db.insert_message("a1", "c", "assistant", Some("codex"), Some("m"), None, "", "done", &json!({}), &json!([])).unwrap();
        (db, "c".into(), "a1".into())
    }

    fn plan<'a>(conv: &'a str, msg: &'a str, payload: &'a Value, native: bool) -> NewInteraction<'a> {
        NewInteraction { conversation_id: conv, message_id: msg, run_id: "r1", agent: "codex", account_id: None, session_id: Some("t1"),
            kind: "plan", item_id: Some("i1"), native, payload }
    }

    #[test]
    fn versiones_de_plan_y_sustitucion() {
        let (db, conv, msg) = setup();
        let p = json!({ "text": "Paso 1" });
        let (first, none) = db.create_interaction(&plan(&conv, &msg, &p, false)).unwrap();
        assert_eq!((first.version, first.status.as_str(), none.len()), (1, "pending", 0));
        let (second, replaced) = db.create_interaction(&plan(&conv, &msg, &p, false)).unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(replaced, vec![first.id.clone()]);
        assert_eq!(db.get_interaction(&first.id).unwrap().status, "superseded");
        // Una pregunta no cambia las versiones de plan.
        let q = NewInteraction { kind: "question", ..plan(&conv, &msg, &p, true) };
        assert_eq!(db.create_interaction(&q).unwrap().0.version, 1);
        assert_eq!(db.pending_interactions().unwrap()[0]["count"], 2);
    }

    #[test]
    fn una_respuesta_solo_se_aplica_una_vez() {
        let (db, conv, msg) = setup();
        let p = json!({});
        let (q, _) = db.create_interaction(&NewInteraction { kind: "question", ..plan(&conv, &msg, &p, true) }).unwrap();
        assert!(db.transition_interaction(&q.id, &["pending"], "answered", Some(&json!({ "a": 1 }))).unwrap());
        assert!(!db.transition_interaction(&q.id, &["pending"], "answered", Some(&json!({ "a": 2 }))).unwrap());
        let saved = db.get_interaction(&q.id).unwrap();
        assert_eq!(saved.response["a"], 1);
        assert!(!saved.native);
    }

    #[test]
    fn cierre_de_ejecucion_y_reinicio() {
        let (db, conv, msg) = setup();
        let p = json!({});
        let (live, _) = db.create_interaction(&NewInteraction { kind: "question", ..plan(&conv, &msg, &p, true) }).unwrap();
        let (codex_plan, _) = db.create_interaction(&plan(&conv, &msg, &p, false)).unwrap();
        assert_eq!(db.recover_interactions().unwrap(), 1);
        assert_eq!(db.get_interaction(&live.id).unwrap().status, "interrupted");
        // Un plan sin solicitud nativa sigue esperando la decisión del usuario.
        assert_eq!(db.get_interaction(&codex_plan.id).unwrap().status, "pending");
        let (other, _) = db.create_interaction(&NewInteraction { kind: "question", ..plan(&conv, &msg, &p, true) }).unwrap();
        assert_eq!(db.close_run_interactions("r1", "cancelled").unwrap(), vec![other.id.clone()]);
        assert_eq!(db.get_interaction(&other.id).unwrap().status, "cancelled");
    }

    #[test]
    fn refleja_el_estado_en_la_cronologia() {
        let (db, _conv, msg) = setup();
        db.conn.lock().execute("UPDATE messages SET items=?2 WHERE id=?1", params![msg, json!([{ "id": "i1", "kind": "plan_proposal" }]).to_string()]).unwrap();
        assert!(db.patch_message_item(&msg, "i1", &json!({ "decision": "approved" })).unwrap());
        assert_eq!(db.get_message(&msg).unwrap().items[0]["decision"], "approved");
        assert!(!db.patch_message_item(&msg, "otro", &json!({})).unwrap());
    }
}
