//! Session Manager (1.0.11, fase 3): bifurcaciones, importaciones y organización de conversaciones.
//!
//! - **Bifurcar** copia en una conversación nueva (identificador propio) los mensajes hasta el punto
//!   elegido, sus adjuntos y referencias, las preferencias de agente, modelo, razonamiento y permisos,
//!   y la memoria compartida **tal como era en ese punto**: de `memory_revisions` se toma la última
//!   revisión de cada recuerdo con `anchor_seq` menor o igual que el corte (ediciones, archivados y
//!   retiradas posteriores no se heredan). La conversación original no se modifica.
//! - No se copian la cola de ejecución, las intervenciones, las sesiones nativas ni las entregas de
//!   memoria: la conversación nueva empieza sin nada «recibido». Para cada agente se guarda en
//!   `origin.native` cómo continuar: una bifurcación nativa pendiente (`pending`, con la sesión de
//!   origen, el punto exacto y el cursor confirmado hasta ese punto) o la reconstrucción del contexto
//!   (`rebuild`). La sesión de origen nunca se reanuda desde la copia: solo se bifurca.
//! - **Importar** crea una conversación a partir de una sesión externa (Codex o Claude Code) sin
//!   modificarla. `imported_sessions` impide importar dos veces la misma sesión.
//! - **Fijar** y **archivar** son marcas de la conversación; archivar no borra nada.

use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::{Conversation, Db};
use crate::util::{new_id, now_ms};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS imported_sessions (
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);
"#;

pub const PURPOSES: [&str; 3] = ["fork", "edit", "regenerate"];

/// Dónde trabaja la conversación bifurcada.
#[derive(Debug, Clone, PartialEq)]
pub enum Space {
    /// El mismo directorio que la conversación original (predeterminado).
    Same,
    /// Directorio principal del proyecto (`None`) o un worktree activo del proyecto.
    Other(Option<String>),
}

pub struct ForkSpec<'a> {
    pub source: &'a str,
    /// Último `seq` que se conserva (inclusive). `0` crea una conversación sin mensajes.
    pub cut_seq: i64,
    pub purpose: &'a str,
    pub from_message: &'a str,
    pub space: Space,
    /// La raíz de trabajo de la bifurcación coincide con la de la original.
    pub same_root: bool,
    pub draft: &'a str,
    pub draft_attachments: &'a [String],
}

/// Mensaje de una sesión externa ya normalizado para importarlo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMessage {
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub attachments: Vec<Value>,
}

#[derive(Clone)]
pub struct ImportSpec<'a> {
    pub project_id: &'a str,
    pub worktree_id: Option<&'a str>,
    pub agent: &'a str,
    pub account_id: Option<&'a str>,
    pub session_id: &'a str,
    pub title: &'a str,
    pub messages: &'a [ImportedMessage],
    /// Metadatos de la sesión original (`cwd`, fechas, modelo, versión de la CLI…), sin secretos.
    pub meta: Value,
    /// Continuar mediante una bifurcación nativa de la sesión importada (si no, reconstrucción).
    pub native: bool,
}

/// Último turno de un agente hasta el corte con el que se puede bifurcar su sesión nativa.
fn native_plan(tx: &Transaction, source: &str, agent: &str, cut: i64, same_root: bool) -> Result<Option<Value>> {
    let participated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND role='assistant' AND agent=?2 AND seq<=?3)",
        params![source, agent, cut], |r| r.get(0),
    )?;
    if !participated {
        return Ok(None);
    }
    let rebuild = |reason: &str| Ok(Some(json!({ "state": "rebuild", "reason": reason })));
    let row: Option<(String, i64, Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>)> = tx.query_row(
        "SELECT m.id, m.seq, COALESCE(m.completed_at, m.created_at), json_extract(r.details,'$.sessionId'), json_extract(r.details,'$.providerTurnId'),
                json_extract(r.details,'$.nativeAnchor'), json_extract(r.details,'$.accountId')
         FROM messages m JOIN run_insights r ON r.message_id=m.id
         WHERE m.conversation_id=?1 AND m.role='assistant' AND m.agent=?2 AND m.seq<=?3 AND m.status='done'
         ORDER BY m.seq DESC LIMIT 1",
        params![source, agent, cut],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).optional()?;
    let Some((message, seq, completed, Some(session), turn, anchor, account)) = row else { return rebuild("noSession") };
    // Claude Code: `--resume-session-at` con el último elemento del turno. Codex: `thread/fork` con `lastTurnId`.
    let point = if agent == "claude" { anchor } else { turn };
    let Some(point) = point else { return rebuild("noAnchor") };
    if agent == "claude" && !same_root {
        // Claude Code guarda las sesiones por directorio: desde otra carpeta no se reanudan con seguridad.
        return rebuild("workdir");
    }
    let compacted: Option<i64> = tx.query_row(
        "SELECT json_extract(native_context,'$.compaction.at') FROM provider_sessions
         WHERE conversation_id=?1 AND agent=?2 AND session_id=?3 AND json_extract(native_context,'$.compaction.state')='completed'",
        params![source, agent, session], |r| r.get(0),
    ).optional()?.flatten();
    if compacted.is_some_and(|at| at > completed.unwrap_or(i64::MAX)) {
        // Tras una compactación posterior, el punto exacto ya no se corresponde con el historial nativo.
        return rebuild("compacted");
    }
    Ok(Some(json!({
        "state": "pending", "sessionId": session, "anchor": point, "lastSeq": seq,
        "messageId": message, "accountId": account,
    })))
}

/// Comprueba que el destino es un espacio válido del proyecto (directorio principal o worktree activo).
fn check_space(tx: &Transaction, project: &str, worktree: Option<&str>) -> Result<()> {
    if let Some(id) = worktree {
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM worktrees WHERE id=?1 AND project_id=?2 AND retired=0)",
            params![id, project], |r| r.get(0),
        )?;
        if !valid {
            bail!("Ese worktree ya no pertenece a este proyecto.");
        }
    }
    Ok(())
}

impl Db {
    // ---------- Organización ----------

    pub fn set_conversation_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        let changed = self.conn.lock().execute(
            "UPDATE conversations SET pinned_at=CASE WHEN ?2 THEN COALESCE(pinned_at, ?3) END WHERE id=?1",
            params![id, pinned, now_ms()],
        )?;
        if changed == 0 { bail!("Conversación no encontrada"); }
        Ok(())
    }

    /// Archivar solo cambia la visibilidad: mensajes, memoria, sesiones y referencias se conservan.
    pub fn set_conversation_archived(&self, id: &str, archived: bool) -> Result<()> {
        let c = self.conn.lock();
        if archived && c.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND status='running')", [id], |r| r.get::<_, bool>(0),
        )? {
            bail!("Detén la ejecución activa antes de archivar la conversación.");
        }
        let changed = c.execute(
            "UPDATE conversations SET archived_at=CASE WHEN ?2 THEN COALESCE(archived_at, ?3) END WHERE id=?1",
            params![id, archived, now_ms()],
        )?;
        if changed == 0 { bail!("Conversación no encontrada"); }
        Ok(())
    }

    /// Registra cómo se resolvió la continuación nativa de un agente en una bifurcación o importación.
    pub fn resolve_native_origin(&self, conversation_id: &str, agent: &str, state: &str, session_id: Option<&str>, detail: Option<&str>) -> Result<()> {
        let path = format!("$.native.{agent}");
        self.conn.lock().execute(
            &format!("UPDATE conversations SET origin=json_set(origin,'{path}.state',?2,'{path}.resolvedSession',?3,'{path}.detail',?4,'{path}.resolvedAt',?5)
                      WHERE id=?1 AND json_extract(origin,'{path}.state')='pending'"),
            params![conversation_id, state, session_id, detail, now_ms()],
        )?;
        Ok(())
    }

    // ---------- Bifurcación ----------

    /// Crea la conversación bifurcada en una única transacción. Devuelve la conversación nueva.
    pub fn fork_conversation(&self, spec: &ForkSpec) -> Result<Conversation> {
        if !PURPOSES.contains(&spec.purpose) {
            bail!("Tipo de bifurcación no admitido.");
        }
        let id = new_id();
        let now = now_ms();
        {
            let mut c = self.conn.lock();
            let tx = c.transaction()?;
            let source = tx.query_row(&format!("{} WHERE id=?1", super::CONVERSATION_SELECT), [spec.source], super::map_conversation)
                .optional()?.ok_or_else(|| anyhow!("La conversación original ya no existe."))?;
            if spec.cut_seq < 0 {
                bail!("Punto de bifurcación no válido.");
            }
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND seq<=?2 AND status='running')",
                params![spec.source, spec.cut_seq], |r| r.get::<_, bool>(0),
            )? {
                bail!("No se puede bifurcar desde un turno que sigue en curso.");
            }
            let worktree = match &spec.space {
                Space::Same => source.worktree_id.clone(),
                Space::Other(w) => w.clone(),
            };
            check_space(&tx, &source.project_id, worktree.as_deref())?;

            let mut native = Map::new();
            for agent in crate::agents::AGENTS {
                if let Some(plan) = native_plan(&tx, spec.source, agent, spec.cut_seq, spec.same_root)? {
                    native.insert(agent.to_owned(), plan);
                }
            }
            let origin = json!({
                "kind": "fork", "purpose": spec.purpose, "conversationId": source.id, "title": source.title,
                "messageId": spec.from_message, "seq": spec.cut_seq, "createdAt": now, "native": native,
            });
            tx.execute(
                "INSERT INTO conversations(id,project_id,title,created_at,updated_at,last_agent,last_model,last_effort,draft,
                   agent_prefs,draft_attachments,auto_title_pending,worktree_id,permission_prefs,context_prefs,origin,work_modes)
                 SELECT ?2,project_id,title,?3,?3,last_agent,last_model,last_effort,?4,agent_prefs,?5,0,?6,permission_prefs,context_prefs,?7,work_modes
                 FROM conversations WHERE id=?1",
                params![spec.source, id, now, spec.draft, serde_json::to_string(spec.draft_attachments)?, worktree, origin.to_string()],
            )?;

            // Mensajes hasta el corte, con identificadores nuevos y el mismo orden.
            let mut ids: HashMap<String, String> = HashMap::new();
            {
                let mut st = tx.prepare("SELECT id FROM messages WHERE conversation_id=?1 AND seq<=?2 ORDER BY seq")?;
                let old: Vec<String> = st.query_map(params![spec.source, spec.cut_seq], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                for old_id in old {
                    let new = new_id();
                    tx.execute(
                        "INSERT INTO messages(id,conversation_id,seq,role,agent,model,effort,content,items,status,error,usage,context_note,attachments,created_at,completed_at)
                         SELECT ?2,?3,seq,role,agent,model,effort,content,items,status,error,usage,context_note,attachments,created_at,completed_at
                         FROM messages WHERE id=?1",
                        params![old_id, new, id],
                    )?;
                    // La actividad se conserva para consultarla, pero no cuenta otra vez en Estadísticas.
                    tx.execute(
                        "UPDATE run_insights SET duplicate=1,
                           details=COALESCE((SELECT details FROM run_insights WHERE message_id=?1), details),
                           metrics=COALESCE((SELECT metrics FROM run_insights WHERE message_id=?1), metrics),
                           legacy=COALESCE((SELECT legacy FROM run_insights WHERE message_id=?1), legacy),
                           observed_end=(SELECT observed_end FROM run_insights WHERE message_id=?1)
                         WHERE message_id=?2",
                        params![old_id, new],
                    )?;
                    ids.insert(old_id, new);
                }
            }

            // Planes y preguntas de los mensajes copiados (fase 4): historial sin solicitudes activas.
            super::interactions::copy_for_fork(&tx, spec.source, &id, &ids)?;

            // Memoria tal como era en el punto de corte.
            let memories: Vec<(String, String, String, Option<String>, Option<String>, String, i64)> = {
                let mut st = tx.prepare(
                    "SELECT id,author,origin,source_agent,source_model,source_messages,created_at FROM memories
                     WHERE conversation_id=?1 AND deleted_at IS NULL",
                )?;
                let rows = st.query_map([spec.source], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                rows
            };
            for (memory, author, origin, agent, model, sources, created) in memories {
                let last: Option<(i64, String, String, i64, bool, i64, i64)> = tx.query_row(
                    "SELECT revision,category,content,priority,archived,anchor_seq,created_at FROM memory_revisions
                     WHERE memory_id=?1 AND anchor_seq<=?2 ORDER BY revision DESC LIMIT 1",
                    params![memory, spec.cut_seq],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                ).optional()?;
                let Some((revision, category, content, priority, archived, anchor, updated)) = last else { continue };
                let mapped: Vec<String> = serde_json::from_str::<Vec<String>>(&sources).unwrap_or_default()
                    .into_iter().filter_map(|m| ids.get(&m).cloned()).collect();
                let new = new_id();
                tx.execute(
                    "INSERT INTO memories(id,conversation_id,category,content,priority,author,origin,source_agent,source_model,source_messages,
                       anchor_seq,revision,archived,created_at,updated_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![new, id, category, content, priority, author, origin, agent, model, json!(mapped).to_string(),
                        anchor, revision, archived, created, updated],
                )?;
                tx.execute(
                    "INSERT INTO memory_revisions(memory_id,revision,category,content,priority,archived,anchor_seq,created_at)
                     SELECT ?2,revision,category,content,priority,archived,anchor_seq,created_at FROM memory_revisions
                     WHERE memory_id=?1 AND revision<=?3",
                    params![memory, new, revision],
                )?;
            }
            tx.commit()?;
        }
        self.get_conversation(&id)
    }

    // ---------- Importación ----------

    /// Conversación de Duovra que ya contiene esta sesión (importada o usada como sesión nativa).
    pub fn session_owner(&self, agent: &str, session_id: &str) -> Result<Option<String>> {
        let c = self.conn.lock();
        let imported: Option<String> = c.query_row(
            "SELECT conversation_id FROM imported_sessions WHERE agent=?1 AND session_id=?2", params![agent, session_id], |r| r.get(0),
        ).optional()?;
        if imported.is_some() {
            return Ok(imported);
        }
        Ok(c.query_row(
            "SELECT conversation_id FROM provider_sessions WHERE agent=?1 AND session_id=?2 LIMIT 1", params![agent, session_id], |r| r.get(0),
        ).optional()?)
    }

    pub fn import_conversation(&self, spec: &ImportSpec) -> Result<Conversation> {
        if !crate::agents::AGENTS.contains(&spec.agent) {
            bail!("Agente desconocido: {}", spec.agent);
        }
        if spec.messages.is_empty() {
            bail!("La sesión no contiene mensajes que se puedan importar.");
        }
        if self.session_owner(spec.agent, spec.session_id)?.is_some() {
            bail!("Esta sesión ya está en Duovra.");
        }
        let id = new_id();
        let now = now_ms();
        {
            let mut c = self.conn.lock();
            let tx = c.transaction()?;
            check_space(&tx, spec.project_id, spec.worktree_id)?;
            let last_seq = spec.messages.len() as i64;
            let native = if spec.native {
                json!({ "state": "pending", "sessionId": spec.session_id, "anchor": null, "lastSeq": last_seq, "accountId": spec.account_id })
            } else {
                json!({ "state": "rebuild", "reason": "chosen" })
            };
            let origin = json!({
                "kind": "import", "agent": spec.agent, "sessionId": spec.session_id, "accountId": spec.account_id,
                "importedAt": now, "meta": spec.meta, "native": { spec.agent: native },
            });
            let model = spec.messages.iter().rev().find_map(|m| m.model.clone());
            let created = spec.messages.first().map(|m| m.created_at).filter(|t| *t > 0).unwrap_or(now);
            let updated = spec.messages.iter().filter_map(|m| m.completed_at.or(Some(m.created_at))).max().filter(|t| *t > 0).unwrap_or(now);
            tx.execute(
                "INSERT INTO conversations(id,project_id,title,created_at,updated_at,last_agent,last_model,auto_title_pending,worktree_id,origin)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8,?9)",
                params![id, spec.project_id, spec.title, created, updated, spec.agent, model, spec.worktree_id, origin.to_string()],
            )?;
            for (i, m) in spec.messages.iter().enumerate() {
                let role = if m.role == "user" { "user" } else { "assistant" };
                let model = if role == "assistant" { m.model.clone() } else { None };
                tx.execute(
                    "INSERT INTO messages(id,conversation_id,seq,role,agent,model,content,status,attachments,context_note,created_at,completed_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![new_id(), id, i as i64 + 1, role, spec.agent, model, m.content, m.status,
                        json!(m.attachments).to_string(), json!({ "imported": true }).to_string(), m.created_at, m.completed_at],
                )?;
            }
            // Los turnos importados no son ejecuciones de Duovra: no cuentan en Estadísticas.
            tx.execute("UPDATE run_insights SET duplicate=1, legacy=1 WHERE conversation_id=?1", [&id])?;
            tx.execute(
                "INSERT INTO imported_sessions(agent,session_id,account_id,conversation_id,imported_at) VALUES(?1,?2,?3,?4,?5)",
                params![spec.agent, spec.session_id, spec.account_id, id, now],
            )?;
            tx.commit()?;
        }
        self.get_conversation(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::memory::MemoryInput;
    use serde_json::Value;

    fn msg(db: &Db, id: &str, conv: &str, role: &str, agent: Option<&str>, text: &str) {
        db.insert_message(id, conv, role, agent, agent.map(|_| "m"), None, text, "done", &Value::Null, &json!([])).unwrap();
    }

    fn memory(db: &Db, conv: &str, content: &str) -> crate::db::memory::Memory {
        db.save_memory(&MemoryInput { conversation_id: conv.into(), content: content.into(), category: "decision".into(), ..Default::default() }).unwrap()
    }

    fn edit(db: &Db, conv: &str, id: &str, content: &str) {
        db.save_memory(&MemoryInput { id: Some(id.into()), conversation_id: conv.into(), content: content.into(), category: "decision".into(), ..Default::default() }).unwrap();
    }

    fn spec<'a>(cut: i64, from: &'a str) -> ForkSpec<'a> {
        ForkSpec { source: "c", cut_seq: cut, purpose: "fork", from_message: from, space: Space::Same, same_root: true, draft: "", draft_attachments: &[] }
    }

    fn setup() -> Db {
        let db = Db::open_memory().unwrap();
        db.create_project("p", "P", "C:/p").unwrap();
        db.create_conversation("c", "p", Some("Original")).unwrap();
        db.set_conversation_prefs("c", "codex", "gpt-6-luna", Some("high")).unwrap();
        db.set_conversation_permissions("c", "claude", &json!({ "mode": "acceptEdits" })).unwrap();
        db
    }

    #[test]
    fn bifurca_desde_distintos_puntos_con_memoria_historica() {
        let db = setup();
        msg(&db, "u1", "c", "user", None, "hola");                        // seq 1
        let a = memory(&db, "c", "Usar SQLite");                          // ancla 1, rev 1
        msg(&db, "a1", "c", "assistant", Some("codex"), "respuesta");     // seq 2
        edit(&db, "c", &a.id, "Usar SQLite local");                       // ancla 2, rev 2
        let b = memory(&db, "c", "Objetivo B");                           // ancla 2
        msg(&db, "u2", "c", "user", Some("claude"), "otra");              // seq 3
        db.set_memory_archived(&b.id, true).unwrap();                     // ancla 3, rev 2 (archivado)
        let d = memory(&db, "c", "Eliminado después");                    // ancla 3
        msg(&db, "a2", "c", "assistant", Some("claude"), "fin");          // seq 4
        db.delete_memory(&d.id).unwrap();                                 // retirada: no se hereda

        // Corte en seq 1: solo la primera revisión de A.
        let f1 = db.fork_conversation(&spec(1, "u1")).unwrap();
        assert_ne!(f1.id, "c");
        assert_eq!(db.list_messages(&f1.id).unwrap().len(), 1);
        let m1 = db.list_memories(&f1.id, true).unwrap();
        assert_eq!(m1.len(), 1);
        assert_eq!((m1[0].content.as_str(), m1[0].revision), ("Usar SQLite", 1));
        assert_eq!(db.memory_revisions(&m1[0].id).unwrap().len(), 1);

        // Corte en seq 2: A editado y B activo.
        let f2 = db.fork_conversation(&spec(2, "a1")).unwrap();
        let mut m2 = db.list_memories(&f2.id, true).unwrap();
        m2.sort_by(|x, y| x.content.cmp(&y.content));
        assert_eq!(m2.iter().map(|m| (m.content.as_str(), m.archived)).collect::<Vec<_>>(), [("Objetivo B", false), ("Usar SQLite local", false)]);

        // Corte en seq 3: B ya archivado; el recuerdo eliminado después no aparece.
        let f3 = db.fork_conversation(&spec(3, "u2")).unwrap();
        let m3 = db.list_memories(&f3.id, true).unwrap();
        assert!(m3.iter().any(|m| m.content == "Objetivo B" && m.archived));
        assert!(!m3.iter().any(|m| m.content.contains("Eliminado")));
        assert_eq!(db.list_messages(&f3.id).unwrap().len(), 3);

        // La original queda intacta y la bifurcación es independiente.
        assert_eq!(db.list_messages("c").unwrap().len(), 4);
        assert_eq!(db.list_memories("c", true).unwrap().len(), 2);
        db.save_memory(&MemoryInput { conversation_id: f3.id.clone(), content: "solo en la copia".into(), category: "note".into(), ..Default::default() }).unwrap();
        assert!(!db.list_memories("c", true).unwrap().iter().any(|m| m.content == "solo en la copia"));
        db.delete_conversation(&f3.id).unwrap();
        assert_eq!(db.list_messages("c").unwrap().len(), 4);
    }

    #[test]
    fn bifurca_planes_y_preguntas_como_historial_sin_solicitudes_activas() {
        use crate::db::interactions::NewInteraction;
        let db = setup();
        db.set_conversation_work_mode("c", "claude", "plan").unwrap();
        msg(&db, "u1", "c", "user", Some("claude"), "planifica");
        msg(&db, "a1", "c", "assistant", Some("claude"), "");
        msg(&db, "u2", "c", "user", Some("claude"), "sigue");
        msg(&db, "a2", "c", "assistant", Some("claude"), "");
        let new = |message: &'static str, kind: &'static str, item: &'static str, payload: &'static Value| NewInteraction {
            conversation_id: "c", message_id: message, run_id: "r", agent: "claude", account_id: None, session_id: Some("s1"),
            kind, item_id: Some(item), native: kind == "question", payload,
        };
        static PLAN: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({ "text": "1. Paso" }));
        static QUESTION: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({ "questions": [] }));
        let (approved, _) = db.create_interaction(&new("a1", "plan", "t1", &PLAN)).unwrap();
        db.transition_interaction(&approved.id, &["pending"], "approved", Some(&json!({ "action": "approve" }))).unwrap();
        let (asked, _) = db.create_interaction(&new("a1", "question", "t2", &QUESTION)).unwrap();
        let (later, _) = db.create_interaction(&new("a2", "plan", "t3", &PLAN)).unwrap();

        // Corte en a1: hereda el plan aprobado y la pregunta (ya no respondible), no el plan posterior.
        let f = db.fork_conversation(&spec(2, "a1")).unwrap();
        assert_eq!(f.work_modes["claude"], "plan");
        let copied = db.list_interactions(&f.id).unwrap();
        assert_eq!(copied.len(), 2);
        assert!(copied.iter().all(|i| ![approved.id.as_str(), asked.id.as_str(), later.id.as_str()].contains(&i.id.as_str())));
        assert!(copied.iter().all(|i| !i.native && i.run_id.is_none()));
        let plan = copied.iter().find(|i| i.kind == "plan").unwrap();
        assert_eq!((plan.status.as_str(), plan.version, plan.response["action"].as_str()), ("approved", 1, Some("approve")));
        assert_eq!(copied.iter().find(|i| i.kind == "question").unwrap().status, "historical");
        let new_messages = db.list_messages(&f.id).unwrap();
        assert!(copied.iter().all(|i| new_messages.iter().any(|m| m.id == i.message_id)));
        // La original conserva su solicitud activa.
        assert_eq!(db.get_interaction(&asked.id).unwrap().status, "pending");
        assert_eq!(db.pending_interactions().unwrap().iter().filter(|p| p["conversationId"] == f.id.as_str()).count(), 0);
    }

    #[test]
    fn conserva_preferencias_adjuntos_y_origen_sin_cola_ni_sesiones() {
        let db = setup();
        db.insert_message("u1", "c", "user", Some("codex"), Some("gpt-6-luna"), Some("high"), "mira", "done", &Value::Null,
            &json!([{ "path": "C:/p/a.png", "name": "a.png", "image": true }])).unwrap();
        msg(&db, "a1", "c", "assistant", Some("codex"), "ok");
        db.upsert_provider_session("c", "codex", "t1", 2, None).unwrap();
        db.conn.lock().execute_batch(
            "INSERT INTO queue_pauses(conversation_id,reason) VALUES('c','manual');",
        ).unwrap();
        let mut s = spec(1, "u1");
        s.purpose = "edit";
        s.draft = "mira mejor";
        let files = ["C:/p/a.png".to_string()];
        s.draft_attachments = &files;
        let f = db.fork_conversation(&s).unwrap();
        assert_eq!(f.title, "Original");
        assert_eq!(f.agent_prefs["codex"]["model"], "gpt-6-luna");
        assert_eq!(f.permission_prefs["claude"]["mode"], "acceptEdits");
        assert_eq!((f.draft.as_str(), f.draft_attachments.clone()), ("mira mejor", files.to_vec()));
        assert_eq!(f.origin["conversationId"], "c");
        assert_eq!(f.origin["purpose"], "edit");
        let messages = db.list_messages(&f.id).unwrap();
        assert_eq!(messages[0].attachments[0]["name"], "a.png");
        assert!(db.list_provider_sessions(&f.id).unwrap().is_empty());
        let paused: bool = db.conn.lock().query_row("SELECT EXISTS(SELECT 1 FROM queue_pauses WHERE conversation_id=?1)", [&f.id], |r| r.get(0)).unwrap();
        assert!(!paused);
        // Las copias no cuentan dos veces en Estadísticas.
        let dup: i64 = db.conn.lock().query_row("SELECT COUNT(*) FROM run_insights WHERE conversation_id=?1 AND duplicate=0", [&f.id], |r| r.get(0)).unwrap();
        assert_eq!(dup, 0);
    }

    #[test]
    fn planes_nativos_segun_turno_directorio_y_compactacion() {
        let db = setup();
        msg(&db, "u1", "c", "user", None, "hola");
        msg(&db, "a1", "c", "assistant", Some("codex"), "r1");
        msg(&db, "u2", "c", "user", None, "sigue");
        msg(&db, "a2", "c", "assistant", Some("claude"), "r2");
        msg(&db, "u3", "c", "user", None, "más");
        msg(&db, "a3", "c", "assistant", Some("codex"), "r3");
        let set = |id: &str, details: Value| {
            db.conn.lock().execute("UPDATE run_insights SET details=?2 WHERE message_id=?1", params![id, details.to_string()]).unwrap();
        };
        set("a1", json!({ "sessionId": "t1", "providerTurnId": "turn-1", "accountId": null }));
        set("a3", json!({ "sessionId": "t1", "providerTurnId": "turn-3", "accountId": null }));
        set("a2", json!({ "sessionId": "s1", "nativeAnchor": "uuid-2" }));
        db.upsert_provider_session("c", "codex", "t1", 6, None).unwrap();

        let f = db.fork_conversation(&spec(4, "a2")).unwrap();
        assert_eq!(f.origin["native"]["codex"], json!({ "state": "pending", "sessionId": "t1", "anchor": "turn-1", "lastSeq": 2, "messageId": f.origin["native"]["codex"]["messageId"], "accountId": null }));
        assert_eq!(f.origin["native"]["claude"]["anchor"], "uuid-2");
        assert_eq!(f.origin["native"]["claude"]["lastSeq"], 4);

        // En otro directorio Claude Code se reconstruye; Codex admite `cwd` al bifurcar.
        let mut other = spec(4, "a2");
        other.same_root = false;
        let g = db.fork_conversation(&other).unwrap();
        assert_eq!(g.origin["native"]["claude"]["state"], "rebuild");
        assert_eq!(g.origin["native"]["codex"]["state"], "pending");

        // Antes de que participe un agente no hay plan para él.
        let h = db.fork_conversation(&spec(1, "u1")).unwrap();
        assert!(h.origin["native"].as_object().unwrap().is_empty());

        // Una compactación posterior al turno impide el punto exacto.
        db.patch_native_context("c", "codex", "t1", &json!({ "compaction": { "state": "completed", "at": i64::MAX - 1 } })).unwrap();
        let k = db.fork_conversation(&spec(6, "a3")).unwrap();
        assert_eq!(k.origin["native"]["codex"], json!({ "state": "rebuild", "reason": "compacted" }));

        // Resolución interna de la continuación: solo una vez.
        db.resolve_native_origin(&f.id, "codex", "native", Some("t9"), None).unwrap();
        db.resolve_native_origin(&f.id, "codex", "rebuilt", None, Some("x")).unwrap();
        assert_eq!(db.get_conversation(&f.id).unwrap().origin["native"]["codex"]["state"], "native");
    }

    #[test]
    fn no_bifurca_turnos_en_curso_ni_hacia_worktrees_ajenos() {
        let db = setup();
        msg(&db, "u1", "c", "user", None, "hola");
        db.insert_message("a1", "c", "assistant", Some("codex"), Some("m"), None, "", "running", &Value::Null, &json!([])).unwrap();
        assert!(db.fork_conversation(&spec(2, "a1")).is_err());
        assert!(db.fork_conversation(&spec(1, "u1")).is_ok());
        let mut s = spec(1, "u1");
        s.space = Space::Other(Some("no-existe".into()));
        assert!(db.fork_conversation(&s).is_err());
        assert!(db.fork_conversation(&ForkSpec { purpose: "otro", ..spec(1, "u1") }).is_err());
    }

    #[test]
    fn fijar_archivar_y_recuperar_sin_perder_datos() {
        let db = setup();
        msg(&db, "u1", "c", "user", None, "hola");
        memory(&db, "c", "dato");
        db.set_conversation_pinned("c", true).unwrap();
        let pinned = db.get_conversation("c").unwrap().pinned_at;
        assert!(pinned.is_some());
        db.set_conversation_pinned("c", true).unwrap();
        assert_eq!(db.get_conversation("c").unwrap().pinned_at, pinned);
        db.set_conversation_archived("c", true).unwrap();
        let c = db.get_conversation("c").unwrap();
        assert!(c.archived_at.is_some());
        assert_eq!(db.list_messages("c").unwrap().len(), 1);
        assert_eq!(db.list_memories("c", true).unwrap().len(), 1);
        // Archivada no es «vacía»: la limpieza de inicio no la toca.
        assert_eq!(db.purge_empty_conversations().unwrap(), 0);
        db.set_conversation_archived("c", false).unwrap();
        db.set_conversation_pinned("c", false).unwrap();
        let c = db.get_conversation("c").unwrap();
        assert_eq!((c.archived_at, c.pinned_at), (None, None));
        assert!(db.set_conversation_pinned("x", true).is_err());
    }

    #[test]
    fn importa_una_vez_con_atribucion_y_aislamiento_de_cuenta() {
        let db = setup();
        let messages = vec![
            ImportedMessage { role: "user".into(), content: "hola".into(), model: None, status: "done".into(), created_at: 10, completed_at: None, attachments: vec![] },
            ImportedMessage { role: "assistant".into(), content: "hola!".into(), model: Some("gpt-6-luna".into()), status: "done".into(), created_at: 11, completed_at: Some(12), attachments: vec![] },
        ];
        let spec = ImportSpec {
            project_id: "p", worktree_id: None, agent: "codex", account_id: Some("acc"), session_id: "thread-x", title: "Externa",
            messages: &messages, meta: json!({ "cwd": "C:/p" }), native: true,
        };
        let conv = db.import_conversation(&spec).unwrap();
        assert_eq!((conv.title.as_str(), conv.last_agent.as_deref(), conv.created_at), ("Externa", Some("codex"), 10));
        assert_eq!(conv.origin["native"]["codex"]["lastSeq"], 2);
        assert_eq!(conv.origin["native"]["codex"]["accountId"], "acc");
        let list = db.list_messages(&conv.id).unwrap();
        assert_eq!(list[1].agent.as_deref(), Some("codex"));
        assert_eq!(list[1].model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(list[0].model, None, "no se inventa el modelo de un mensaje del usuario");
        // Duplicados: la misma sesión no se importa dos veces; una sesión ya usada por Duovra tampoco.
        assert!(db.import_conversation(&spec).is_err());
        db.upsert_provider_session("c", "claude", "s-en-uso", 0, None).unwrap();
        assert!(db.import_conversation(&ImportSpec { agent: "claude", session_id: "s-en-uso", ..spec.clone() }).is_err());
        assert_eq!(db.session_owner("codex", "thread-x").unwrap().as_deref(), Some(conv.id.as_str()));
        // Al eliminar la conversación importada se puede volver a importar.
        db.delete_conversation(&conv.id).unwrap();
        assert!(db.session_owner("codex", "thread-x").unwrap().is_none());
        let again = db.import_conversation(&ImportSpec { native: false, ..spec.clone() }).unwrap();
        assert_eq!(again.origin["native"]["codex"]["state"], "rebuild");
    }

    #[test]
    fn migracion_session_manager_es_aditiva() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO projects VALUES('p','P','C:/x',0,0);
             INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','T',0,0);
             INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES('m1','c',1,'user','hola',0);",
        ).unwrap();
        crate::db::init_schema(&mut conn).unwrap();
        crate::db::init_schema(&mut conn).unwrap();
        let db = Db { dir: None, _owner: None, conn: parking_lot::Mutex::new(conn) };
        let c = db.get_conversation("c").unwrap();
        assert_eq!((c.pinned_at, c.archived_at, c.origin.clone()), (None, None, json!({})));
        assert_eq!(db.list_messages("c").unwrap().len(), 1);
    }
}
