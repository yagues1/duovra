use super::{codex, resolve_attachments, with_attachment_note, Control, SendRequest, Studio};
use crate::util::new_id;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;

impl Studio {
    /// Devuelve `confirmed` (acuse con el ID del turno) o `uncertain` (sin acuse: el historial lo registra
    /// como no confirmado). Un rechazo explícito del proveedor es un error y conserva el borrador.
    pub async fn steer(self: &Arc<Self>, run_id: &str, text: String, paths: Vec<String>) -> Result<&'static str> {
        let (run, server, thread, turn, id, attachments) = {
            let _gate = self.lifecycle.lock();
            let run = self.run(run_id).ok_or_else(|| anyhow!("El turno ya terminó."))?;
            if run.is_finished() || run.cancel_requested.load(Ordering::SeqCst) || !run.steerable.load(Ordering::SeqCst) {
                bail!("Este turno ya no admite intervenciones.");
            }
            if self.approvals.lock().values().any(|approval| approval.run_id() == run_id) {
                bail!("Resuelve primero la autorización pendiente.");
            }
            if self.steering.lock().contains(&run.conversation_id) {
                bail!("Codex ya está confirmando una intervención.");
            }
            let (server, thread, turn) = match &*run.control.lock() {
                Control::Codex { server, thread_id, turn_id: Some(turn) } => (server.clone(), thread_id.clone(), turn.clone()),
                _ => bail!("El proveedor no admite intervenir en este turno."),
            };
            let req = SendRequest {
                conversation_id: run.conversation_id.clone(),
                agent: run.agent.clone(),
                model: run.model.clone(),
                effort: run.effort.clone(),
                text,
                attachments: paths,
                speed: run.speed.clone(),
                permissions: run.permissions.clone(),
                purpose: None,
                work_mode: run.plan_mode.then(|| "plan".to_owned()),
                approved_plan: None,
                review: None,
                provider_command: false,
                ahead_of_queue: false,
            };
            req.validate()?;
            let conv = self.db.get_conversation(&run.conversation_id)?;
            let attachments = resolve_attachments(&req, &self.db.conversation_root(&conv.id)?)?;
            let id = new_id();
            self.db.begin_steer(&id, &conv.id, &run.message_id, &json!({
                "model": run.model, "effort": run.effort, "text": req.text, "attachments": attachments,
            }))?;
            self.steering.lock().insert(conv.id);
            (run, server, thread, turn, id, (req.text, attachments))
        };
        let (text, attachments) = attachments;
        let input = codex::turn_input(&with_attachment_note(&text, &attachments), &attachments);
        let outcome = server.request_timeout(
            "turn/steer", json!({ "threadId": thread, "expectedTurnId": turn, "input": input }),
            Duration::from_secs(15),
        ).await;
        let confirmed = matches!(&outcome, Ok(result) if result["turnId"] == turn);
        let explicitly_rejected = matches!(&outcome, Err(error) if error.downcast_ref::<codex::RpcError>().is_some());
        let _gate = self.lifecycle.lock();
        let cid = &run.conversation_id;
        let saved = if explicitly_rejected {
            self.db.reject_steer(&id)
        } else {
            self.db.finish_steer(&id, cid, &run.message_id, &run.model, run.effort.as_deref(), &text, &attachments, &thread, confirmed)
                .map(|message| self.emit(json!({ "type": "historyMessage", "conversationId": cid, "message": message })))
        };
        if saved.is_err() && !explicitly_rejected {
            // El diario conserva el envío sin confirmar. Bloquea cualquier despacho si SQLite
            // tampoco puede persistir la pausa.
            if self.db.storage_pause(cid, &run.message_id).is_err() {
                self.queue_changed(cid);
                bail!("No se pudo guardar la intervención. Reinicia Duovra para revisarla.");
            }
        }
        self.steering.lock().remove(cid);
        self.queue_changed(cid);
        self.kick_queue(cid);
        saved?;
        if confirmed {
            return Ok("confirmed");
        }
        if explicitly_rejected {
            return outcome.map(|_: Value| "rejected");
        }
        Ok("uncertain")
    }
}
