//! Compatibilidad con el centro de instrucciones retirado de 1.0.11.
//! Conserva sus tablas, revisiones y registro de entregas. No carga ni edita las instrucciones;
//! únicamente registra la retirada de las que pudieron llegar a una sesión nativa.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::{HashMap, VecDeque};
use super::Db;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS instructions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT 'both',
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  anchor_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_instructions_scope ON instructions(scope, project_id, conversation_id);
CREATE TABLE IF NOT EXISTS instruction_revisions (
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  target TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  anchor_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (instruction_id, revision)
);
CREATE TABLE IF NOT EXISTS instruction_deliveries (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_id TEXT,
  instruction_id TEXT NOT NULL REFERENCES instructions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  message_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent, session_id, instruction_id)
);
-- Solo evidencia de entrega, sin texto ni referencia a instrucciones o conversaciones de origen.
CREATE TABLE IF NOT EXISTS legacy_instruction_context (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pending INTEGER NOT NULL CHECK(pending IN (0,1)),
  PRIMARY KEY (conversation_id,agent,session_id,account_key,seq)
);
"#;

pub const CONTEXT_PREFIX: &str = "ins:";
pub const RETIREMENT_KEY: &str = "ins:retirement";

fn pending(c: &Connection, conv: &str, agent: &str, session: &str, account: Option<&str>, cut: Option<i64>) -> Result<bool> {
    Ok(c.query_row(
        "SELECT pending FROM legacy_instruction_context
         WHERE conversation_id=?1 AND agent=?2 AND session_id=?3 AND account_key=?4 AND seq<=?5
         ORDER BY seq DESC LIMIT 1",
        params![conv, agent, session, account.unwrap_or(""), cut.unwrap_or(i64::MAX)], |r| r.get(0),
    ).optional()?.unwrap_or(false))
}

/// Se ejecuta una sola vez en la migración aditiva. Las notas antiguas conservan evidencia
/// de la primera entrega aunque instruction_deliveries solo conserve la revisión más reciente.
pub(super) fn migrate_retirements(tx: &Transaction) -> Result<()> {
    tx.execute_batch("
        INSERT OR IGNORE INTO legacy_instruction_context
        SELECT u.conversation_id,a.agent,json_extract(r.details,'$.sessionId'),
               COALESCE(json_extract(r.details,'$.accountId'),''),a.seq,1
        FROM messages u JOIN messages a ON a.conversation_id=u.conversation_id AND a.seq=u.seq+1
        JOIN run_insights r ON r.message_id=a.id
        WHERE u.role='user' AND a.role='assistant' AND a.agent IS NOT NULL
          AND json_extract(r.details,'$.sessionId') IS NOT NULL
          AND json_extract(u.context_note,'$.duovraInstructions')>0
          AND json_extract(u.context_note,'$.state') IN ('confirmed','uncertain')
          AND r.duplicate=0;

        INSERT OR IGNORE INTO legacy_instruction_context
        SELECT d.conversation_id,d.agent,d.session_id,COALESCE(d.account_id,''),
               COALESCE(m.seq,(SELECT MAX(seq) FROM messages WHERE conversation_id=d.conversation_id),0),1
        FROM instruction_deliveries d LEFT JOIN messages m
          ON m.id=d.message_id AND m.conversation_id=d.conversation_id
        WHERE d.state IN ('confirmed','uncertain');

        -- Si todas las revisiones de una sesión estaban retiradas, no repetir el aviso.
        INSERT OR REPLACE INTO legacy_instruction_context
        SELECT d.conversation_id,d.agent,d.session_id,COALESCE(d.account_id,''),
               MAX(COALESCE(m.seq,(SELECT MAX(seq) FROM messages WHERE conversation_id=d.conversation_id),0)),0
        FROM instruction_deliveries d LEFT JOIN messages m
          ON m.id=d.message_id AND m.conversation_id=d.conversation_id
        GROUP BY d.conversation_id,d.agent,d.session_id,COALESCE(d.account_id,'')
        HAVING SUM(CASE WHEN d.state<>'retracted' THEN 1 ELSE 0 END)=0;
    ")?;
    // Procesa el bosque de bifurcaciones de raíz a hojas, sin depender de fechas ni del
    // orden de las filas. Cada padre queda completamente resuelto antes de copiar su evidencia
    // al hijo. Así nunca se fija un estado provisional en una sesión nativa resuelta.
    let lineage: Vec<(String, Option<String>, Option<i64>)> = {
        let mut st = tx.prepare(
            "SELECT c.id,p.id,CASE WHEN p.id IS NOT NULL THEN json_extract(c.origin,'$.seq') END
             FROM conversations c LEFT JOIN conversations p
               ON json_extract(c.origin,'$.kind')='fork'
               AND p.id=json_extract(c.origin,'$.conversationId')",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    let mut children: HashMap<String, Vec<(String, Option<i64>)>> = HashMap::new();
    let mut ready = VecDeque::new();
    for (id, parent, cut) in lineage {
        if let Some(parent) = parent {
            children.entry(parent).or_default().push((id, cut));
        } else {
            // También son raíces las bifurcaciones cuyo padre se eliminó antes de migrar.
            ready.push_back(id);
        }
    }
    while let Some(id) = ready.pop_front() {
        // Las notas duplicadas son evidencia de respaldo si el origen ya no existe.
        // No pueden sobrescribir ni una retirada heredada ni los estados directos.
        tx.execute(
            "INSERT OR IGNORE INTO legacy_instruction_context
             SELECT u.conversation_id,a.agent,json_extract(r.details,'$.sessionId'),
                    COALESCE(json_extract(r.details,'$.accountId'),''),a.seq,1
             FROM messages u JOIN messages a ON a.conversation_id=u.conversation_id AND a.seq=u.seq+1
             JOIN run_insights r ON r.message_id=a.id
             WHERE u.conversation_id=?1 AND u.role='user' AND a.role='assistant'
               AND a.agent IS NOT NULL AND json_extract(r.details,'$.sessionId') IS NOT NULL
               AND json_extract(u.context_note,'$.duovraInstructions')>0
               AND json_extract(u.context_note,'$.state') IN ('confirmed','uncertain')
               AND r.duplicate<>0", [&id],
        )?;
        // A estas alturas la sesión de origen ya contiene toda la evidencia disponible
        // hasta el corte. IGNORE solo protege un estado directo, no un cálculo provisional.
        tx.execute(
            "INSERT OR IGNORE INTO legacy_instruction_context
             SELECT c.id,n.key,json_extract(n.value,'$.resolvedSession'),
                    COALESCE(json_extract(n.value,'$.accountId'),''),json_extract(n.value,'$.lastSeq'),e.pending
             FROM conversations c JOIN json_each(c.origin,'$.native') n
             JOIN legacy_instruction_context e ON e.conversation_id=c.id AND e.agent=n.key
               AND e.session_id=json_extract(n.value,'$.sessionId')
               AND e.account_key=COALESCE(json_extract(n.value,'$.accountId'),'')
             WHERE c.id=?1 AND json_extract(n.value,'$.state')='native'
               AND json_extract(n.value,'$.resolvedSession') IS NOT NULL
               AND e.seq=(SELECT MAX(x.seq) FROM legacy_instruction_context x
                 WHERE x.conversation_id=e.conversation_id AND x.agent=e.agent AND x.session_id=e.session_id
                   AND x.account_key=e.account_key AND x.seq<=json_extract(n.value,'$.lastSeq'))", [&id],
        )?;
        if let Some(branches) = children.remove(&id) {
            for (child, cut) in branches {
                tx.execute(
                    "INSERT OR IGNORE INTO legacy_instruction_context
                     SELECT ?2,agent,session_id,account_key,seq,pending FROM legacy_instruction_context
                     WHERE conversation_id=?1 AND seq<=?3", params![id,child,cut],
                )?;
                ready.push_back(child);
            }
        }
    }
    Ok(())
}

pub(super) fn copy_for_fork(tx: &Transaction, source: &str, dest: &str, cut: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO legacy_instruction_context
         SELECT ?2,agent,session_id,account_key,seq,pending FROM legacy_instruction_context
         WHERE conversation_id=?1 AND seq<=?3",
        params![source,dest,cut],
    )?;
    Ok(())
}

pub(super) fn resolve_fork(tx: &Transaction, conv: &str, agent: &str, source: &str, dest: &str, account: Option<&str>, cut: i64) -> Result<()> {
    if pending(tx,conv,agent,source,account,Some(cut))? {
        tx.execute(
            "INSERT OR IGNORE INTO legacy_instruction_context VALUES(?1,?2,?3,?4,?5,1)",
            params![conv,agent,dest,account.unwrap_or(""),cut],
        )?;
    }
    Ok(())
}

impl Db {
    pub fn legacy_withdrawal_pending(&self, conv: &str, agent: &str, session: &str, account: Option<&str>, cut: Option<i64>) -> Result<bool> {
        pending(&self.conn.lock(),conv,agent,session,account,cut)
    }

    /// Solo un aviso confirmado cierra la retirada; los intentos inciertos se mantienen pendientes.
    pub fn confirm_legacy_withdrawal(&self, conv: &str, agent: &str, session: &str, account: Option<&str>, message: &str) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT OR REPLACE INTO legacy_instruction_context
             SELECT ?1,?2,?3,?4,seq,0 FROM messages WHERE id=?5 AND conversation_id=?1",
            params![conv,agent,session,account.unwrap_or(""),message],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sessions::{ForkSpec, Space};
    use serde_json::{json, Value};

    fn message(db: &Db, conv: &str, id: &str, role: &str) {
        db.insert_message(id, conv, role, Some("codex"), Some("m"), None, "QA", "done", &Value::Null, &json!([])).unwrap();
    }

    fn native_turn(db: &Db, conv: &str, user: &str, assistant: &str, session: &str, received: bool) {
        message(db,conv,user,"user");
        message(db,conv,assistant,"assistant");
        if received {
            db.update_context_note(user,&json!({"duovraInstructions":2,"state":"confirmed"})).unwrap();
        }
        db.conn.lock().execute("UPDATE run_insights SET details=?2 WHERE message_id=?1",
            params![assistant,json!({"sessionId":session,"providerTurnId":assistant,"accountId":"a"}).to_string()]).unwrap();
    }

    fn fork(db: &Db, source: &str, cut: i64) -> crate::db::Conversation {
        let messages = db.list_messages(source).unwrap();
        let m = messages.iter().find(|m| m.seq == cut).unwrap();
        db.fork_conversation(&ForkSpec { source,cut_seq:cut,purpose:"fork",from_message:&m.id,
            space:Space::Same,same_root:true,draft:"",draft_attachments:&[] }).unwrap()
    }

    fn setup() -> Db {
        let db = Db::open_memory().unwrap();
        db.create_project("p","P","C:/p").unwrap();
        db.create_conversation("c","p",None).unwrap();
        db
    }

    fn migrate_old(db: &Db) {
        let mut c = db.conn.lock();
        c.execute_batch("DROP TABLE legacy_instruction_context;").unwrap();
        super::super::init_schema(&mut c).unwrap();
    }

    fn legacy_delivery(db: &Db, conv: &str, session: &str, message: &str, state: &str) {
        let c = db.conn.lock();
        c.execute("INSERT OR IGNORE INTO instructions(id,scope,content,created_at,updated_at)
                   VALUES('old','global','legacy text',1,1)", []).unwrap();
        c.execute("INSERT INTO instruction_deliveries
                   VALUES(?1,'codex',?2,'a','old',1,?3,?4,1)", params![conv,session,state,message]).unwrap();
    }

    fn resolved_fork(db: &Db, source: &str, cut: i64, session: &str) -> crate::db::Conversation {
        let c = fork(db,source,cut);
        db.resolve_native_origin(&c.id,"codex","native",Some(session),None).unwrap();
        db.upsert_provider_session(&c.id,"codex",session,cut,Some("a")).unwrap();
        db.get_conversation(&c.id).unwrap()
    }

    fn needs_notice(db: &Db, conv: &str, session: &str, cut: Option<i64>) -> bool {
        db.legacy_withdrawal_pending(conv,"codex",session,Some("a"),cut).unwrap()
    }

    #[test]
    fn retired_storage_survives_schema_and_withdrawal() {
        let db = setup();
        db.create_conversation("c2", "p", None).unwrap();
        native_turn(&db,"c","u","m","s",true);
        {
            let c = db.conn.lock();
            c.execute_batch("
                INSERT INTO instructions(id,scope,content,created_at,updated_at)
                    VALUES('old','global','legacy text',1,1);
                INSERT INTO instruction_revisions(instruction_id,revision,target,content,enabled,anchor_seq,created_at)
                    VALUES('old',1,'both','legacy text',1,0,1);
                INSERT INTO prompts(id,name,body,created_at,updated_at)
                    VALUES('old-prompt','Legacy','prompt text',1,1);
                INSERT INTO instruction_deliveries VALUES('c','codex','s','a','old',1,'confirmed','m',1);
            ").unwrap();
        }
        migrate_old(&db);
        let read = || db.legacy_withdrawal_pending("c","codex","s",Some("a"),None).unwrap();
        assert!(read());
        for (conv,agent,session,account) in [("c","codex","s","b"),("c2","codex","s","a"),("c","claude","s","a"),("c","codex","other","a")] {
            assert!(!db.legacy_withdrawal_pending(conv,agent,session,Some(account),None).unwrap());
        }
        native_turn(&db,"c","u2","m2","s",false);
        db.confirm_legacy_withdrawal("c","codex","s",Some("a"),"m2").unwrap();
        assert!(!read());
        assert!(db.legacy_withdrawal_pending("c","codex","s",Some("a"),Some(2)).unwrap());
        let mut c = db.conn.lock();
        super::super::init_schema(&mut c).unwrap();
        assert!(!pending(&c,"c","codex","s",Some("a"),None).unwrap());
        for (sql, expected) in [
            ("SELECT content FROM instructions WHERE id='old'", "legacy text"),
            ("SELECT content FROM instruction_revisions WHERE instruction_id='old'", "legacy text"),
            ("SELECT body FROM prompts WHERE id='old-prompt'", "prompt text"),
        ] {
            assert_eq!(c.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap(), expected);
        }
    }

    #[test]
    fn chained_forks_keep_historical_receipt_after_deleting_origins() {
        let db = setup();
        native_turn(&db,"c","u1","m1","s",false);
        native_turn(&db,"c","u2","m2","s",true);
        migrate_old(&db);
        let before = fork(&db,"c",2);
        assert!(!db.legacy_withdrawal_pending(&before.id,"codex","s",Some("a"),Some(2)).unwrap());
        let mut parent = fork(&db,"c",4).id;
        db.delete_conversation("c").unwrap();
        for _ in 0..4 {
            let child = fork(&db,&parent,4);
            assert_eq!(child.origin["native"]["codex"]["sessionId"],"s");
            db.delete_conversation(&parent).unwrap();
            parent=child.id;
        }
        assert!(db.legacy_withdrawal_pending(&parent,"codex","s",Some("a"),Some(4)).unwrap());
        assert!(!db.legacy_withdrawal_pending(&parent,"codex","fresh",Some("a"),None).unwrap());
        db.resolve_native_origin(&parent,"codex","native",Some("child-session"),None).unwrap();
        assert!(db.legacy_withdrawal_pending(&parent,"codex","child-session",Some("a"),None).unwrap());
        // Un turno que no confirmó la retirada deja pendiente la misma evidencia.
        native_turn(&db,&parent,"u3","m3","child-session",false);
        assert!(db.legacy_withdrawal_pending(&parent,"codex","child-session",Some("a"),None).unwrap());
        native_turn(&db,&parent,"u4","m4","child-session",false);
        db.confirm_legacy_withdrawal(&parent,"codex","child-session",Some("a"),"m4").unwrap();
        assert!(!db.legacy_withdrawal_pending(&parent,"codex","child-session",Some("a"),None).unwrap());
        let after = fork(&db,&parent,8);
        let earlier = fork(&db,&parent,6);
        let original_anchor = fork(&db,&parent,4);
        db.delete_conversation(&parent).unwrap();
        assert!(!db.legacy_withdrawal_pending(&after.id,"codex","child-session",Some("a"),Some(8)).unwrap());
        assert!(db.legacy_withdrawal_pending(&earlier.id,"codex","child-session",Some("a"),Some(6)).unwrap());
        assert!(db.legacy_withdrawal_pending(&original_anchor.id,"codex","s",Some("a"),Some(4)).unwrap());
        db.resolve_native_origin(&earlier.id,"codex","rebuilt",None,Some("fallback")).unwrap();
        assert!(!db.legacy_withdrawal_pending(&earlier.id,"codex","fresh",Some("a"),None).unwrap());
    }

    #[test]
    fn migrates_preexisting_forks_from_copied_notes_without_original() {
        let db=setup();
        native_turn(&db,"c","u1","m1","s",true);
        let b=fork(&db,"c",2);
        let c=fork(&db,&b.id,2);
        db.delete_conversation("c").unwrap();
        db.delete_conversation(&b.id).unwrap();
        migrate_old(&db);
        assert!(db.legacy_withdrawal_pending(&c.id,"codex","s",Some("a"),Some(2)).unwrap());
        assert!(!db.legacy_withdrawal_pending(&c.id,"codex","s",None,Some(2)).unwrap());
    }

    #[test]
    fn preexisting_resolved_fork_inherits_confirmed_withdrawal_after_pending_parent() {
        // Caso de revisión exacto: A/s/2=1, A/s/4=0; B pendiente al corte 4;
        // C resuelta en t al mismo corte antes de migrar. Sus notas copiadas solo
        // contienen la entrega inicial; la retirada procede de instruction_deliveries.
        let db = setup();
        native_turn(&db,"c","u1","m1","s",true);
        native_turn(&db,"c","u2","m2","s",false);
        legacy_delivery(&db,"c","s","m2","retracted");
        let b = fork(&db,"c",4);
        assert_eq!(b.origin["native"]["codex"]["state"],"pending");
        let c = resolved_fork(&db,&b.id,4,"t");
        assert_eq!(c.origin["native"]["codex"]["state"],"native");
        assert_eq!(c.origin["native"]["codex"]["sessionId"],"s");
        migrate_old(&db);
        assert!(needs_notice(&db,"c","s",Some(2)));
        assert!(!needs_notice(&db,"c","s",Some(4)));
        assert!(!needs_notice(&db,&b.id,"s",Some(4)));
        assert!(!needs_notice(&db,&c.id,"s",Some(4)));
        assert!(!needs_notice(&db,&c.id,"t",None));
        // Exige evidencia explícita de retirada, no solo ausencia de la entrega.
        let state: bool = db.conn.lock().query_row(
            "SELECT pending FROM legacy_instruction_context
             WHERE conversation_id=?1 AND agent='codex' AND session_id='t' AND account_key='a' AND seq=4",
            [&c.id], |r| r.get(0)).unwrap();
        assert!(!state);
    }

    #[test]
    fn migration_orders_deep_preexisting_forks_and_preserves_direct_states() {
        let db = setup();
        native_turn(&db,"c","u1","m1","s",false); // Antes de cualquier entrega.
        native_turn(&db,"c","u2","m2","s",true);
        native_turn(&db,"c","u3","m3","s",false);
        legacy_delivery(&db,"c","s","m3","retracted");
        native_turn(&db,"c","u4","m4","s",false);

        let mut parent = fork(&db,"c",8);
        let mut ancestors = vec![parent.id.clone()];
        for _ in 0..8 {
            parent = fork(&db,&parent.id,8);
            ancestors.push(parent.id.clone());
        }
        let never = resolved_fork(&db,&parent.id,2,"never");
        let earlier = resolved_fork(&db,&parent.id,4,"earlier");
        let at = resolved_fork(&db,&parent.id,6,"at");
        let later = resolved_fork(&db,&parent.id,8,"later");
        // Las sesiones resueltas de los ancestros también deben propagarse.
        native_turn(&db,&earlier.id,"eu","em","earlier",false);
        let next = resolved_fork(&db,&earlier.id,6,"next");
        native_turn(&db,&next.id,"nu","nm","next",false);
        legacy_delivery(&db,&next.id,"next","nm","retracted");
        let next_before = resolved_fork(&db,&next.id,6,"next-before");
        let next_after = resolved_fork(&db,&next.id,8,"next-after");
        // Estado directo pendiente en una sesión que heredó una retirada confirmada.
        native_turn(&db,&later.id,"lu","lm","later",true);
        legacy_delivery(&db,&later.id,"later","lm","confirmed");
        let direct = resolved_fork(&db,&later.id,10,"direct");
        // Colisión exacta con el corte: el estado directo gana en ambas direcciones.
        let direct_pending = resolved_fork(&db,&parent.id,6,"direct-pending");
        let anchor = db.list_messages(&direct_pending.id).unwrap().last().unwrap().id.clone();
        legacy_delivery(&db,&direct_pending.id,"direct-pending",&anchor,"uncertain");
        let direct_retired = resolved_fork(&db,&parent.id,4,"direct-retired");
        let anchor = db.list_messages(&direct_retired.id).unwrap().last().unwrap().id.clone();
        legacy_delivery(&db,&direct_retired.id,"direct-retired",&anchor,"retracted");

        migrate_old(&db);
        let verify = || {
            for (conv,session,expected) in [
                (&never.id,"never",false),(&earlier.id,"earlier",true),
                (&at.id,"at",false),(&later.id,"later",true),
                (&next.id,"next",false),(&next_before.id,"next-before",true),
                (&next_after.id,"next-after",false),(&direct.id,"direct",true),
                (&direct_pending.id,"direct-pending",true),(&direct_retired.id,"direct-retired",false),
            ] {
                assert_eq!(needs_notice(&db,conv,session,None),expected,"{session}");
            }
            assert!(!needs_notice(&db,&later.id,"later",Some(8)));
            assert!(needs_notice(&db,&next.id,"next",Some(6)));
            assert!(!needs_notice(&db,&later.id,"fresh",None));
        };
        verify();
        // Al borrar los orígenes ya migrados no se pierde evidencia ni se reabre una retirada.
        db.delete_conversation("c").unwrap();
        for id in ancestors { db.delete_conversation(&id).unwrap(); }
        verify();
        {
            let mut c = db.conn.lock();
            let snapshot = |c: &Connection| {
                let mut st = c.prepare("SELECT conversation_id,agent,session_id,account_key,seq,pending
                    FROM legacy_instruction_context ORDER BY conversation_id,agent,session_id,account_key,seq").unwrap();
                st.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
                    r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,bool>(5)?))).unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>().unwrap()
            };
            let before = snapshot(&c);
            super::super::init_schema(&mut c).unwrap();
            super::super::init_schema(&mut c).unwrap();
            assert_eq!(snapshot(&c),before);
            assert_eq!(c.query_row("PRAGMA quick_check", [], |r| r.get::<_,String>(0)).unwrap(),"ok");
        }
        verify();
    }
}
