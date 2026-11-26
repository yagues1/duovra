//! Proyección local, indexada por mensaje asistente. La cola y Steer conservan
//! sus propias tablas y solo el despacho crea un mensaje asistente.

use super::Db;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    if conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? >= 1 {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE run_insights (
           message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
           conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
           started_at INTEGER NOT NULL,
           details TEXT NOT NULL DEFAULT '{}',
           metrics TEXT NOT NULL DEFAULT '{}',
           provider_key TEXT UNIQUE,
           duplicate INTEGER NOT NULL DEFAULT 0,
           observed_end INTEGER,
           legacy INTEGER NOT NULL DEFAULT 0,
           input INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.inputTokens')) STORED,
           fresh INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.freshInputTokens')) STORED,
           cache_read INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.cachedInputTokens')) STORED,
           cache_write INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.cacheWriteInputTokens')) STORED,
           output INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.outputTokens')) STORED,
           cost_estimated REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metrics,'$.costKind')='estimate' THEN json_extract(metrics,'$.costUsd') END) STORED,
           cost_reported REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metrics,'$.costKind')='reported' THEN json_extract(metrics,'$.costUsd') END) STORED,
           partial INTEGER GENERATED ALWAYS AS (coalesce(json_extract(metrics,'$.partial'),0)) STORED
         );
         CREATE INDEX run_insights_time ON run_insights(started_at);
         CREATE INDEX run_insights_conversation ON run_insights(conversation_id,started_at);
         CREATE TABLE insight_claude_requests (
           session_id TEXT NOT NULL, request_id TEXT NOT NULL,
           message_id TEXT NOT NULL REFERENCES run_insights(message_id) ON DELETE CASCADE,
           PRIMARY KEY(session_id,request_id)
         );
         CREATE INDEX insight_claude_requests_message ON insight_claude_requests(message_id);
         INSERT INTO run_insights(message_id,conversation_id,started_at,legacy,observed_end)
           SELECT id,conversation_id,created_at,1,
                  CASE WHEN status IN ('done','failed','cancelled') THEN completed_at END
           FROM messages WHERE role='assistant' AND agent IN ('claude','codex');
         CREATE TRIGGER run_insights_insert AFTER INSERT ON messages
           WHEN NEW.role='assistant' AND NEW.agent IN ('claude','codex')
         BEGIN
           INSERT INTO run_insights(message_id,conversation_id,started_at)
           VALUES(NEW.id,NEW.conversation_id,NEW.created_at);
         END;
         PRAGMA user_version = 1;",
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageScope {
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub days: Option<i64>,
}

/// Serie temporal de Estadísticas: intervalos de `bucket_ms` desde `since` (ms), alineados a la
/// hora local con `offset_ms` (desplazamiento de la zona horaria respecto a UTC).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineScope {
    pub since: i64,
    pub bucket_ms: i64,
    pub offset_ms: i64,
}

impl Db {
    pub fn append_plan(&self, id: &str, snapshot: &Value) -> Result<bool> {
        Ok(self.conn.lock().execute(
            "UPDATE run_insights
             SET details=json_set(details,'$.plans',json_insert(coalesce(details->'$.plans','[]'),'$[#]',json_set(?2,'$.receivedAt',?3)))
             WHERE message_id=?1 AND json_remove(details->'$.plans[#-1]','$.receivedAt') IS NOT json(?2)
               AND EXISTS(SELECT 1 FROM messages WHERE id=?1 AND status='running')",
            params![id, snapshot.to_string(), crate::util::now_ms()],
        )? != 0)
    }

    pub fn patch_insights(&self, id: &str, patch: &Value) -> Result<bool> {
        Ok(self.conn.lock().execute(
            "UPDATE run_insights SET details=json_patch(details,?2)
             WHERE message_id=?1 AND details<>json_patch(details,?2)
               AND EXISTS(SELECT 1 FROM messages WHERE id=?1 AND status='running')",
            params![id, patch.to_string()],
        )? != 0)
    }

    // Una identidad nativa ya asociada a otro mensaje nunca vuelve a aportar métricas.
    pub fn bind_insights(&self, id: &str, key: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let owner: Option<String> = conn.query_row(
            "SELECT message_id FROM run_insights WHERE provider_key=?1", [key], |r| r.get(0),
        ).optional()?;
        if let Some(owner) = owner {
            if owner != id {
                conn.execute("UPDATE run_insights SET duplicate=1,metrics='{}' WHERE message_id=?1", [id])?;
                return Ok(false);
            }
            return Ok(true);
        }
        Ok(conn.execute("UPDATE run_insights SET provider_key=?2 WHERE message_id=?1 AND provider_key IS NULL", params![id, key])? != 0)
    }

    pub fn claim_claude_request(&self, message: &str, session: &str, id: &str) -> Result<bool> {
        Ok(self.conn.lock().execute(
            "INSERT OR IGNORE INTO insight_claude_requests(session_id,request_id,message_id) VALUES(?1,?2,?3)",
            params![session,id,message],
        )? != 0)
    }

    pub fn checkpoint_metrics(&self, id: &str, usage: &Value) -> Result<bool> {
        Ok(self.conn.lock().execute(
            "UPDATE run_insights SET metrics=?2
             WHERE message_id=?1 AND metrics<>?2
               AND EXISTS(SELECT 1 FROM messages WHERE id=?1 AND status='running')",
            params![id, usage.to_string()],
        )? != 0)
    }

    pub fn previous_metrics(&self, id: &str, agent: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock();
        let previous: Option<(String, String, String)> = conn.query_row(
            "SELECT r.metrics,m.usage,m.status FROM messages current
             JOIN messages m ON m.conversation_id=current.conversation_id AND m.seq<current.seq
             JOIN run_insights r ON r.message_id=m.id
             WHERE current.id=?1 AND m.agent=?2 AND m.role='assistant'
             ORDER BY m.seq DESC LIMIT 1",
            params![id, agent], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional()?;
        Ok(previous.and_then(|(metrics, legacy, status)| {
            let mut v: Value = serde_json::from_str(&metrics).ok()?;
            if v.as_object()?.is_empty() {
                v = serde_json::from_str(&legacy).ok()?;
            }
            if v.is_object() {
                v["previousStatus"] = json!(status);
            }
            Some(v)
        }))
    }

    pub fn run_insights(&self, id: &str) -> Result<Option<Value>> {
        let row: Option<(String, String, bool)> = self.conn.lock().query_row(
            "SELECT details,metrics,legacy FROM run_insights WHERE message_id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional()?;
        row.map(|(details, metrics, legacy)| -> Result<Value> {
            Ok(json!({
                "details": serde_json::from_str::<Value>(&details)?,
                "metrics": serde_json::from_str::<Value>(&metrics)?,
                "legacy": legacy,
            }))
        }).transpose()
    }

    pub fn insights_usage(&self, scope: &UsageScope, now: i64) -> Result<Vec<Value>> {
        let since = scope.days.filter(|n| matches!(n, 1 | 7 | 30)).map_or(0, |d| now - d * 86_400_000);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT json_object(
              'agent',m.agent,'model',m.model,'projectId',p.id,'project',p.name,
              'conversationId',c.id,'conversation',c.title,
              'runs',COUNT(*),'completed',COUNT(*) FILTER(WHERE m.status='done'),
              'failed',COUNT(*) FILTER(WHERE m.status='failed'),
              'cancelled',COUNT(*) FILTER(WHERE m.status='cancelled'),
              'interrupted',COUNT(*) FILTER(WHERE m.status='interrupted'),
              'running',COUNT(*) FILTER(WHERE m.status='running'),
              'legacy',SUM(r.legacy),
              'partial',COUNT(*) FILTER(WHERE r.partial=1 OR (r.input IS NOT NULL AND m.status<>'done')),
              'durationMs',SUM(r.observed_end-r.started_at),'durationCount',COUNT(r.observed_end),
              'inputTokens',SUM(r.input),'inputCount',COUNT(r.input),
              'freshInputTokens',SUM(r.fresh),'freshCount',COUNT(r.fresh),
              'cachedInputTokens',SUM(r.cache_read),'cacheReadCount',COUNT(r.cache_read),
              'cacheWriteInputTokens',SUM(r.cache_write),'cacheWriteCount',COUNT(r.cache_write),
              'outputTokens',SUM(r.output),'outputCount',COUNT(r.output),
              'reportedUsd',SUM(r.cost_reported),'reportedCount',COUNT(r.cost_reported),
              'estimatedUsd',SUM(r.cost_estimated),'estimatedCount',COUNT(r.cost_estimated)
            ) FROM run_insights r
              JOIN messages m ON m.id=r.message_id
              JOIN conversations c ON c.id=r.conversation_id
              JOIN projects p ON p.id=c.project_id
            WHERE r.duplicate=0 AND r.started_at>=?1 AND (?2 IS NULL OR c.id=?2) AND (?3 IS NULL OR p.id=?3)
            GROUP BY p.id,c.id,m.agent,m.model
            ORDER BY COUNT(*) DESC,p.name,c.title,m.agent,m.model",
        )?;
        let rows = stmt.query_map(params![since, scope.conversation_id, scope.project_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
}

impl Db {
    /// Turnos, tiempo, tokens y coste por intervalo y agente, de todos los proyectos. Solo suma lo
    /// registrado: cada medida lleva su número de turnos con dato para no presentar huecos como cero.
    pub fn insights_timeline(&self, scope: &TimelineScope) -> Result<Vec<Value>> {
        let bucket = scope.bucket_ms.clamp(3_600_000, 31 * 86_400_000);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT json_object(
              'bucket',((r.started_at+?3)/?2)*?2-?3,'agent',m.agent,
              'runs',COUNT(*),'completed',COUNT(*) FILTER(WHERE m.status='done'),
              'failed',COUNT(*) FILTER(WHERE m.status='failed'),
              'durationMs',SUM(r.observed_end-r.started_at),'durationCount',COUNT(r.observed_end),
              'inputTokens',SUM(r.input),'inputCount',COUNT(r.input),
              'freshInputTokens',SUM(r.fresh),'freshCount',COUNT(r.fresh),
              'cachedInputTokens',SUM(r.cache_read),'cacheReadCount',COUNT(r.cache_read),
              'cacheWriteInputTokens',SUM(r.cache_write),'cacheWriteCount',COUNT(r.cache_write),
              'outputTokens',SUM(r.output),'outputCount',COUNT(r.output),
              'reportedUsd',SUM(r.cost_reported),'reportedCount',COUNT(r.cost_reported),
              'estimatedUsd',SUM(r.cost_estimated),'estimatedCount',COUNT(r.cost_estimated)
            ) FROM run_insights r JOIN messages m ON m.id=r.message_id
            WHERE r.duplicate=0 AND r.started_at>=?1
            GROUP BY (r.started_at+?3)/?2, m.agent
            ORDER BY (r.started_at+?3)/?2, m.agent",
        )?;
        let rows = stmt.query_map(params![scope.since.max(0), bucket, scope.offset_ms], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::SendRequest;

    #[test]
    fn migracion_preserva_historial_y_proyeccion_no_duplica_identidades() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn.execute_batch(crate::db::queue::SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','Proyecto','C:/qa',1,1);
             INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','Conversación',1,1);
             INSERT INTO messages(id,conversation_id,seq,role,agent,model,status,content,usage,created_at,completed_at)
             VALUES('old','c',1,'assistant','claude','m','done','Historial','{\"inputTokens\":156000}',1,10);
             INSERT INTO usage_log(conversation_id,agent,model,input_tokens,output_tokens,created_at)
             VALUES('c','claude','m',156000,90,10);",
        ).unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::db::migrate(&conn).unwrap();
        let db = Db { dir: None, _owner: None, conn: parking_lot::Mutex::new(conn) };
        assert_eq!(db.get_message("old").unwrap().content, "Historial");
        assert_eq!(db.usage_summary(0).unwrap()[0].input_tokens, 156000);
        assert_eq!(db.run_insights("old").unwrap().unwrap()["legacy"], true);

        let request = SendRequest {
            conversation_id: "c".into(), agent: "codex".into(), model: "m2".into(), effort: None,
            text: "Seguir".into(), attachments: vec![], speed: None, permissions: None, purpose: None, work_mode: None, approved_plan: None,
        };
        let start = || db.start_messages(&request, None, &Value::Null, &[]).unwrap().unwrap().1.id;
        let id = start();
        let plan = json!({"source":"codex","tasks":[{"title":"A","status":"pending"}]});
        assert!(db.append_plan(&id, &plan).unwrap());
        assert!(!db.append_plan(&id, &plan).unwrap());
        let stored = db.run_insights(&id).unwrap().unwrap();
        let revisions = stored["details"]["plans"].as_array().unwrap();
        assert_eq!(revisions.len(), 1);
        assert!(revisions[0]["receivedAt"].as_i64().unwrap() > 0);
        assert!(db.bind_insights(&id, "native-turn").unwrap());
        assert!(db.bind_insights(&id, "native-turn").unwrap());
        let usage = json!({"accountingVersion":1,"inputTokens":500,"outputTokens":70,"cachedInputTokens":320});
        assert!(db.checkpoint_metrics(&id, &usage).unwrap());
        assert!(!db.checkpoint_metrics(&id, &usage).unwrap());
        db.finish_run("c", &id, None, "Listo", &json!([]), "done", None, &usage, None).unwrap();
        let replayed = start();
        assert!(!db.bind_insights(&replayed, "native-turn").unwrap());
        db.finish_run("c", &replayed, None, "Repetido", &json!([]), "done", None, &usage, None).unwrap();
        let rows = db.insights_usage(&UsageScope { conversation_id: Some("c".into()), project_id: None, days: None }, 100).unwrap();
        let codex = rows.iter().find(|r| r["agent"] == "codex").unwrap();
        assert_eq!(codex["runs"], 1);
        assert_eq!(codex["inputTokens"], 500);
        assert!(codex["estimatedUsd"].is_null());
        let legacy = rows.iter().find(|r| r["agent"] == "claude").unwrap();
        assert_eq!(legacy["legacy"], 1);
        assert!(legacy["inputTokens"].is_null());
        let timeline = db.insights_timeline(&TimelineScope { since: 0, bucket_ms: 86_400_000, offset_ms: 0 }).unwrap();
        let codex: Vec<_> = timeline.iter().filter(|r| r["agent"] == "codex").collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0]["runs"], 1);
        assert_eq!(codex[0]["outputTokens"], 70);
        assert_eq!(codex[0]["bucket"].as_i64().unwrap() % 86_400_000, 0);
    }
}
