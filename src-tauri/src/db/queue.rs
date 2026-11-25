use super::{Db, Message};
use crate::agents::queue::QueuedInput;
use crate::agents::SendRequest;
use crate::util::{new_id, now_ms};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS execution_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','blocked','review','done','removed')),
    revision INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    message_id TEXT,
    session_id TEXT,
    turn_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_position ON execution_queue(conversation_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_running ON execution_queue(conversation_id) WHERE state='running';
CREATE TABLE IF NOT EXISTS steer_attempts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_pauses (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    message_id TEXT
);
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub project_id: String,
    pub position: i64,
    pub state: String,
    pub created_at: i64,
    pub input: QueuedInput,
    pub detail: Option<String>,
    pub message_id: Option<String>,
    #[serde(skip)]
    pub revision: i64,
    #[serde(skip)]
    pub session_id: Option<String>,
    #[serde(skip)]
    pub turn_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueView {
    pub entries: Vec<QueueEntry>,
    pub pause_reason: Option<String>,
    pub review_message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QueueAction {
    Pause,
    Resume,
    Remove { id: String },
    Clear,
    Move { id: String, before: Option<String> },
    Retry { id: String },
}

fn read_entry(row: &rusqlite::Row) -> rusqlite::Result<QueueEntry> {
    let payload: String = row.get("payload")?;
    let input = serde_json::from_str(&payload)
        .map_err(|err| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(err)))?;
    Ok(QueueEntry {
        id: row.get("id")?, project_id: row.get("project_id")?, position: row.get("position")?,
        state: row.get("state")?, created_at: row.get("created_at")?, input,
        detail: row.get("detail")?, message_id: row.get("message_id")?, revision: row.get("revision")?,
        session_id: row.get("session_id")?, turn_id: row.get("turn_id")?,
    })
}

fn entries(c: &Connection, cid: &str) -> Result<Vec<QueueEntry>> {
    let mut stmt = c.prepare(
        "SELECT * FROM execution_queue WHERE conversation_id=?1 AND state NOT IN ('done','removed') ORDER BY position, created_at, id",
    )?;
    let rows = stmt.query_map([cid], read_entry)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn eligible(c: &Connection, cid: &str, head: &QueueEntry) -> Result<bool> {
    Ok(!c.query_row("SELECT EXISTS(SELECT 1 FROM queue_pauses WHERE conversation_id=?1)", [cid], |r| r.get::<_, bool>(0))?
        && c.query_row(
            "SELECT id, state, revision FROM execution_queue WHERE conversation_id=?1 AND state NOT IN ('done','removed') ORDER BY position, created_at, id LIMIT 1",
            [cid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        ).optional()?.is_some_and(|(id, state, revision)| id == head.id && state == "pending" && revision == head.revision))
}

impl Db {
    pub fn queue(&self, cid: &str) -> Result<QueueView> {
        let c = self.conn.lock();
        let pause: Option<(String, Option<String>)> = c.query_row(
            "SELECT reason, message_id FROM queue_pauses WHERE conversation_id=?1", [cid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        Ok(QueueView {
            entries: entries(&c, cid)?,
            pause_reason: pause.as_ref().map(|p| p.0.clone()),
            review_message_id: pause.and_then(|p| p.1),
        })
    }

    pub fn enqueue(&self, id: &str, project: &str, input: &QueuedInput, defer: bool) -> Result<bool> {
        let cid = &input.request.conversation_id;
        let payload = serde_json::to_string(input)?;
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let inserted = tx.execute(
            "INSERT INTO execution_queue(id, conversation_id, project_id, payload, position, state, created_at)
             VALUES (?1,?2,?3,?4,(SELECT COALESCE(MAX(position),0)+1 FROM execution_queue WHERE conversation_id=?2),'pending',?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, cid, project, payload, now_ms()],
        )?;
        if inserted == 1 && defer {
            tx.execute("INSERT OR IGNORE INTO queue_pauses(conversation_id, reason) VALUES (?1,'manual')", [cid])?;
        }
        tx.commit()?;
        Ok(inserted == 1)
    }

    pub fn edit_queue(&self, cid: &str, id: &str, revision: i64, input: &QueuedInput) -> Result<()> {
        let updated = self.conn.lock().execute(
            "UPDATE execution_queue SET payload=?3, state=CASE WHEN state='blocked' THEN 'pending' ELSE state END,
                detail=CASE WHEN state='blocked' THEN NULL ELSE detail END, revision=revision+1
             WHERE conversation_id=?1 AND id=?2 AND revision=?4 AND state IN ('pending','blocked','review')",
            params![cid, id, serde_json::to_string(input)?, revision],
        )?;
        if updated != 1 {
            return Err(anyhow!("El encargo ha cambiado. Abre de nuevo la edición."));
        }
        Ok(())
    }

    pub fn queue_action(&self, cid: &str, action: QueueAction) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let emptied = matches!(action, QueueAction::Remove { .. } | QueueAction::Clear);
        match action {
            QueueAction::Pause => {
                tx.execute("INSERT OR IGNORE INTO queue_pauses(conversation_id, reason) VALUES (?1,'manual')", [cid])?;
            }
            QueueAction::Resume => {
                if entries(&tx, cid)?.iter().any(|row| matches!(row.state.as_str(), "review" | "blocked")) {
                    return Err(anyhow!("Revisa, reintenta o retira los encargos marcados antes de continuar."));
                }
                if tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM queue_pauses WHERE conversation_id=?1 AND reason='storage')", [cid],
                    |row| row.get::<_, bool>(0),
                )? {
                    return Err(anyhow!("Reinicia Duovra para revisar la ejecución cuyo resultado no pudo guardarse."));
                }
                tx.execute("DELETE FROM queue_pauses WHERE conversation_id=?1", [cid])?;
            }
            QueueAction::Remove { id } => {
                let removed = tx.execute(
                    "UPDATE execution_queue SET state='removed' WHERE conversation_id=?1 AND id=?2 AND state IN ('pending','blocked','review')",
                    params![cid, id],
                )?;
                if removed != 1 {
                    return Err(anyhow!("El encargo ya salió de la cola. Si está ejecutándose, puedes detenerlo."));
                }
            }
            QueueAction::Clear => {
                tx.execute("UPDATE execution_queue SET state='removed' WHERE conversation_id=?1 AND state IN ('pending','blocked','review')", [cid])?;
            }
            QueueAction::Retry { id } => {
                let updated = tx.execute(
                    "UPDATE execution_queue SET state='pending', detail=NULL, revision=revision+1, message_id=NULL, session_id=NULL, turn_id=NULL
                     WHERE conversation_id=?1 AND id=?2 AND state='review'",
                    params![cid, id],
                )?;
                if updated != 1 {
                    return Err(anyhow!("El encargo ya no está pendiente de revisión."));
                }
            }
            QueueAction::Move { id, before } => {
                if before.as_deref() == Some(id.as_str()) { return Ok(()); }
                let mut visible = entries(&tx, cid)?;
                let from = visible.iter().position(|r| r.id == id && r.state == "pending")
                    .ok_or_else(|| anyhow!("Este encargo ya no se puede mover."))?;
                let entry = visible.remove(from);
                let to = match before {
                    Some(before) => visible.iter().position(|r| r.id == before && r.state != "running")
                        .ok_or_else(|| anyhow!("La posición de destino ha cambiado."))?,
                    None => visible.len(),
                };
                visible.insert(to, entry);
                for (i, row) in visible.iter().enumerate() {
                    tx.execute("UPDATE execution_queue SET position=?2 WHERE id=?1", params![row.id, i as i64 + 1])?;
                }
            }
        }
        // Al retirar lo último de la cola, su pausa ya no protege nada y se levanta (salvo la de
        // almacenamiento, que exige reiniciar).
        if emptied {
            tx.execute(
                "DELETE FROM queue_pauses WHERE conversation_id=?1 AND reason<>'storage'
                   AND NOT EXISTS(SELECT 1 FROM execution_queue WHERE conversation_id=?1 AND state IN ('pending','running','blocked','review'))",
                [cid],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn block_queue(&self, cid: &str, head: &QueueEntry, detail: &str) -> Result<bool> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let current = eligible(&tx, cid, head)?;
        if current {
            tx.execute("UPDATE execution_queue SET state='blocked', detail=?2 WHERE id=?1", params![head.id, detail])?;
            tx.execute("INSERT INTO queue_pauses(conversation_id, reason) VALUES (?1,'configuration')", [cid])?;
        }
        tx.commit()?;
        Ok(current)
    }

    pub fn start_messages(
        &self, req: &SendRequest, head: Option<&QueueEntry>, note: &Value, attachments: &[Value],
    ) -> Result<Option<(Message, Message)>> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let cid = &req.conversation_id;
        if let Some(head) = head {
            if !eligible(&tx, cid, head)? { return Ok(None); }
            if let Some(account) = head.input.target.account_id.as_deref() {
                let same = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND agent=?2 AND config_dir IS ?3)",
                    params![account, req.agent, head.input.target.config_dir], |row| row.get::<_, bool>(0),
                )?;
                if !same {
                    return Err(anyhow!("La cuenta de este encargo ya no está disponible."));
                }
            }
        } else if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_queue WHERE conversation_id=?1 AND state NOT IN ('done','removed'))
             OR EXISTS(SELECT 1 FROM queue_pauses WHERE conversation_id=?1 AND reason IN ('restart','storage','steer'))",
            [cid], |r| r.get::<_, bool>(0),
        )? {
            return Err(anyhow!("Resuelve los encargos de la cola antes de enviar otro directamente."));
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND status='running')", [cid], |r| r.get::<_, bool>(0))? {
            return Err(anyhow!("Ya hay una ejecución activa o pendiente de guardar en esta conversación."));
        }

        let user = Self::write_message(&tx, &new_id(), cid, "user", Some(&req.agent), Some(&req.model), req.effort.as_deref(),
            &req.text, "done", note, &json!(attachments))?;
        let assistant = Self::write_message(&tx, &new_id(), cid, "assistant", Some(&req.agent), Some(&req.model), req.effort.as_deref(),
            "", "running", &Value::Null, &json!([]))?;
        if let Some(head) = head {
            tx.execute("UPDATE execution_queue SET state='running', message_id=?2 WHERE id=?1", params![head.id, assistant.id])?;
        }
        tx.commit()?;
        Ok(Some((user, assistant)))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_run(
        &self, cid: &str, message_id: &str, entry: Option<&str>, content: &str, items: &Value,
        status: &str, error: Option<&str>, usage: &Value, model: Option<&str>,
    ) -> Result<Message> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let msg = Self::write_finished_message(&tx, message_id, content, items, status, error, usage, model)?;
        tx.execute(
            "UPDATE run_insights SET observed_end=?2,
                    metrics=CASE WHEN duplicate=0 AND json_extract(?3,'$.accountingVersion')=1 THEN ?3 ELSE metrics END
             WHERE message_id=?1",
            params![message_id, msg.completed_at, usage.to_string()],
        )?;
        if let Some(id) = entry {
            let (state, detail) = match status {
                "done" => ("done", None),
                "cancelled" => ("review", Some("Se detuvo este encargo. Comprueba sus efectos antes de reintentarlo.")),
                "interrupted" => ("review", Some("Se interrumpió este encargo. Comprueba sus efectos antes de reintentarlo.")),
                _ => ("review", error.or(Some("El encargo falló. Comprueba sus efectos antes de reintentarlo."))),
            };
            let updated = tx.execute(
                "UPDATE execution_queue SET state=?2, detail=?3 WHERE id=?1 AND state='running' AND message_id=?4",
                params![id, state, detail, message_id],
            )?;
            if updated != 1 {
                return Err(anyhow!("No se pudo guardar el estado final del encargo."));
            }
        }
        // Solo se pausa si queda algo en la cola que proteger: detener una ejecución sin encargos
        // pendientes no deja una cola «pausada» vacía que no se puede retirar (1.0.9).
        let remaining: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_queue WHERE conversation_id=?1 AND state IN ('pending','blocked','review'))",
            [cid], |row| row.get(0),
        )?;
        if status != "done" && remaining {
            tx.execute(
                "INSERT INTO queue_pauses(conversation_id, reason, message_id) VALUES (?1,?2,?3)
                 ON CONFLICT(conversation_id) DO UPDATE SET reason=excluded.reason,message_id=excluded.message_id",
                params![cid, status, message_id],
            )?;
        }
        tx.commit()?;
        Ok(msg)
    }

    pub fn record_queue_turn(&self, entry: &str, message: &str, session: &str, turn: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE execution_queue SET session_id=?3, turn_id=?4 WHERE id=?1 AND message_id=?2 AND state='running'",
            params![entry, message, session, turn],
        )?;
        Ok(())
    }

    pub fn reconcile_completed(
        &self, entry: &QueueEntry, content: &str, items: &Value,
    ) -> Result<Message> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let id = entry.message_id.as_deref().ok_or_else(|| anyhow!("El encargo no tiene un mensaje asociado."))?;
        let updated = tx.execute(
            "UPDATE execution_queue SET state='done',detail=NULL WHERE id=?1 AND state='review' AND message_id=?2 AND revision=?3",
            params![entry.id, id, entry.revision],
        )?;
        if updated != 1 {
            return Err(anyhow!("El encargo ya cambió. Vuelve a cargar la cola."));
        }
        let msg = Self::write_finished_message(&tx, id, content, items, "done", None, &Value::Null, None)?;
        tx.commit()?;
        Ok(msg)
    }

    pub fn begin_steer(&self, id: &str, cid: &str, message_id: &str, payload: &Value) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO steer_attempts(id,conversation_id,message_id,payload,state) VALUES (?1,?2,?3,?4,'pending')",
            params![id, cid, message_id, payload.to_string()],
        )?;
        Ok(())
    }

    pub fn reject_steer(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM steer_attempts WHERE id=?1 AND state='pending'", [id])?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_steer(
        &self, id: &str, cid: &str, parent_id: &str, model: &str, effort: Option<&str>,
        text: &str, attachments: &[Value], session: &str, confirmed: bool,
    ) -> Result<Message> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let msg = Self::write_message(
            &tx, id, cid, "user", Some("codex"), Some(model), effort, text,
            if confirmed { "done" } else { "interrupted" },
            &json!({ "mode": "none", "steer": if confirmed { "accepted" } else { "unconfirmed" }, "parentMessageId": parent_id }),
            &json!(attachments),
        )?;
        if confirmed {
            tx.execute(
                "UPDATE provider_sessions SET last_seq=MAX(last_seq,?3) WHERE conversation_id=?1 AND session_id=?2 AND agent='codex'",
                params![cid, session, msg.seq],
            )?;
        } else {
            tx.execute(
                "INSERT INTO queue_pauses(conversation_id, reason, message_id) VALUES (?1,'steer',?2)
                 ON CONFLICT(conversation_id) DO UPDATE SET reason='steer', message_id=excluded.message_id",
                params![cid, parent_id],
            )?;
        }
        tx.execute("DELETE FROM steer_attempts WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(msg)
    }

    pub fn storage_pause(&self, cid: &str, message_id: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO queue_pauses(conversation_id, reason, message_id) VALUES (?1,'storage',?2)
             ON CONFLICT(conversation_id) DO UPDATE SET reason='storage',message_id=excluded.message_id",
            params![cid, message_id],
        )?;
        Ok(())
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::queue::ProviderTarget;
    use std::{fs, path::PathBuf, sync::{Arc, Barrier}};

    fn input(cid: &str, agent: &str, model: &str) -> QueuedInput {
        QueuedInput {
            request: SendRequest { conversation_id: cid.into(), agent: agent.into(), model: model.into(),
                effort: Some("medium".into()), text: "Prueba".into(), attachments: vec!["prueba.txt".into()], speed: None, permissions: None },
            target: ProviderTarget { account_id: None, label: format!("Perfil de {agent}"), config_dir: None },
            attachments: vec![json!({ "path": "prueba.txt" })], identity: Some(json!({ "email": "test@qa.invalid" })),
            resolved_model: None, effective_effort: Some("medium".into()), capture_error: None,
        }
    }

    fn seed(db: &Db) {
        db.create_project("p", "prueba", ".").unwrap();
        for id in ["a", "b"] {
            db.create_conversation(id, "p", None).unwrap();
        }
    }

    #[test]
    fn orden_edicion_y_reserva_atomica() {
        let db = Arc::new(Db::open_memory().unwrap());
        seed(&db);
        let a = input("a", "codex", "gpt-6-luna");
        let b = input("a", "claude", "haiku");
        let other = input("b", "codex", "gpt-6.2-sol");
        assert!(db.enqueue("1", "p", &a, false).unwrap());
        assert!(!db.enqueue("1", "p", &a, false).unwrap());
        db.enqueue("2", "p", &b, false).unwrap();
        db.enqueue("3", "p", &other, false).unwrap();
        db.queue_action("a", QueueAction::Move { id: "2".into(), before: Some("1".into()) }).unwrap();
        let old = db.queue("a").unwrap().entries.remove(0);
        let mut edited = b;
        edited.request.text = "Mensaje editado".into();
        db.edit_queue("a", "2", old.revision, &edited).unwrap();
        assert!(db.start_messages(&old.input.request, Some(&old), &Value::Null, &old.input.attachments).unwrap().is_none());
        let head = Arc::new(db.queue("a").unwrap().entries.remove(0));
        let barrier = Arc::new(Barrier::new(2));
        let claim = || {
            let (db, head, barrier) = (db.clone(), head.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                db.start_messages(&head.input.request, Some(&head), &Value::Null, &head.input.attachments).unwrap()
            })
        };
        let (left, right) = (claim(), claim());
        let claims = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(claims.iter().flatten().count(), 1);
        let (user, assistant) = claims.into_iter().flatten().next().unwrap();
        assert_eq!(user.content, "Mensaje editado");
        assert_eq!(user.agent.as_deref(), Some("claude"));
        assert_eq!(user.effort.as_deref(), Some("medium"));
        assert_eq!(user.model.as_deref(), Some("haiku"));
        assert_eq!(db.list_messages("a").unwrap().len(), 2);
        assert!(db.delete_conversation("a").is_err());
        assert!(db.delete_project("p").is_err());
        assert!(db.queue_action("a", QueueAction::Remove { id: "2".into() }).is_err());
        assert_eq!(db.queue("b").unwrap().entries[0].id, "3");

        // Fuerza el fallo después de actualizar el mensaje y antes de cerrar su encargo.
        db.conn.lock().execute_batch(
            "CREATE TRIGGER simulated_disk_error BEFORE UPDATE OF state ON execution_queue
             WHEN NEW.state='done' BEGIN SELECT RAISE(FAIL,'simulated disk error'); END;",
        ).unwrap();
        assert!(db.finish_run("a", &assistant.id, Some("2"), "respuesta", &json!([]), "done", None, &Value::Null, None).is_err());
        assert_eq!(db.get_message(&assistant.id).unwrap().status, "running");
        assert_eq!(db.queue("a").unwrap().entries[0].state, "running");
        db.conn.lock().execute_batch("DROP TRIGGER simulated_disk_error;").unwrap();

        db.finish_run("a", &assistant.id, Some("2"), "", &json!([]), "cancelled", None, &Value::Null, None).unwrap();
        assert_eq!(db.queue("a").unwrap().pause_reason.as_deref(), Some("cancelled"));
        assert!(db.queue_action("a", QueueAction::Resume).is_err());
        db.queue_action("a", QueueAction::Remove { id: "2".into() }).unwrap();
        db.queue_action("a", QueueAction::Resume).unwrap();
        assert_eq!(db.queue("a").unwrap().entries[0].id, "1");
        assert_eq!(db.queue("b").unwrap().entries[0].id, "3");
    }

    #[test]
    fn detener_sin_cola_no_deja_una_pausa_vacia() {
        let db = Db::open_memory().unwrap();
        seed(&db);
        // Ejecución directa (sin encargo) detenida con la cola vacía: no hay nada que pausar.
        let req = input("a", "codex", "gpt-6-luna").request;
        let (_, assistant) = db.start_messages(&req, None, &Value::Null, &[]).unwrap().unwrap();
        db.finish_run("a", &assistant.id, None, "", &json!([]), "cancelled", None, &Value::Null, None).unwrap();
        assert_eq!(db.queue("a").unwrap().pause_reason, None);

        // Encargo detenido: la cola se pausa y, al retirarlo, la pausa desaparece con él.
        db.enqueue("1", "p", &input("a", "codex", "gpt-6-luna"), false).unwrap();
        let head = db.queue("a").unwrap().entries.remove(0);
        let (_, assistant) = db.start_messages(&head.input.request, Some(&head), &Value::Null, &head.input.attachments).unwrap().unwrap();
        db.finish_run("a", &assistant.id, Some("1"), "", &json!([]), "cancelled", None, &Value::Null, None).unwrap();
        assert_eq!(db.queue("a").unwrap().pause_reason.as_deref(), Some("cancelled"));
        db.queue_action("a", QueueAction::Remove { id: "1".into() }).unwrap();
        let queue = db.queue("a").unwrap();
        assert_eq!(queue.pause_reason, None);
        assert!(queue.entries.is_empty());
    }

    #[test]
    fn sqlite_recupera_sin_volver_a_reclamar_y_conserva_draft() {
        let dir = std::env::temp_dir().join(new_id());
        fs::create_dir(&dir).unwrap();
        let path = dir.join("studio.sqlite3");
        let cleanup = TempDirectory(dir);
        let codex = input("a", "codex", "gpt-6-luna");
        let claude = input("a", "claude", "haiku");
        let running_message = {
            let db = Db::open(&path).unwrap();
            seed(&db);
            assert!(Db::open(&path).is_err());
            db.set_draft("a", "Borrador siguiente").unwrap();
            db.set_draft_attachments("a", &["borrador.txt".into()]).unwrap();
            db.enqueue("active", "p", &codex, false).unwrap();
            db.enqueue("pending", "p", &claude, false).unwrap();
            let head = db.queue("a").unwrap().entries.remove(0);
            let (_, assistant) = db.start_messages(&codex.request, Some(&head), &Value::Null, &codex.attachments).unwrap().unwrap();
            db.record_queue_turn("active", &assistant.id, "thread-id", "turn-id").unwrap();
            db.update_message_progress(&assistant.id, "Respuesta parcial", &json!([])).unwrap();
            assistant.id
        };
        let db = Db::open(&path).unwrap();
        let queue = db.queue("a").unwrap();
        assert_eq!(queue.pause_reason.as_deref(), Some("restart"));
        assert_eq!(queue.entries.iter().map(|e| e.state.as_str()).collect::<Vec<_>>(), ["review", "pending"]);
        assert_eq!(queue.entries[0].turn_id.as_deref(), Some("turn-id"));
        assert_eq!(queue.entries[1].input.request.agent, "claude");
        assert_eq!(db.get_message(&running_message).unwrap().status, "interrupted");
        assert_eq!(db.get_message(&running_message).unwrap().content, "Respuesta parcial");
        assert_eq!(db.get_conversation("a").unwrap().draft, "Borrador siguiente");
        assert_eq!(db.get_conversation("a").unwrap().draft_attachments, ["borrador.txt"]);
        assert!(db.start_messages(&codex.request, Some(&queue.entries[0]), &Value::Null, &codex.attachments).unwrap().is_none());
        assert!(db.queue_action("a", QueueAction::Resume).is_err());
        let recovered = db.reconcile_completed(&queue.entries[0], "Respuesta recuperada", &json!([])).unwrap();
        assert_eq!(recovered.status, "done");
        assert_eq!(db.queue("a").unwrap().pause_reason.as_deref(), Some("restart"));
        assert!(db.start_messages(&claude.request, Some(&queue.entries[1]), &Value::Null, &claude.attachments).unwrap().is_none());
        drop(db);
        drop(cleanup);
    }

    struct TempDirectory(PathBuf);
    impl Drop for TempDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
}
