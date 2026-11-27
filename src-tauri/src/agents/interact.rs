//! Planes y preguntas nativos de los agentes (1.0.11, fase 4 · Planning & Decisions).
//!
//! Mecanismos verificados en las versiones instaladas:
//! - **Claude Code 2.1.325** (`claude -p` con `--permission-prompt-tool stdio`): `ExitPlanMode` y
//!   `AskUserQuestion` llegan como `control_request` `can_use_tool`. Se aprueba un plan con
//!   `behavior: allow`; se piden cambios o se rechaza con `behavior: deny` y un mensaje (el agente
//!   sigue en modo plan). Una pregunta se responde con `allow` y `updatedInput.answers`
//!   (`texto de la pregunta → etiqueta`; varias etiquetas separadas por comas).
//! - **Codex App Server 0.169**: el plan propuesto es un elemento `plan` (`item/plan/delta`) de un
//!   turno en `collaborationMode: plan`; el turno termina al proponerlo y la aprobación inicia un turno
//!   nuevo en modo predeterminado. Las preguntas llegan como `item/tool/requestUserInput` y se
//!   responden con `{ answers: { <id>: { answers: [..] } } }`.
//!
//! Nada de lo que contiene un plan o una pregunta ejecuta acciones de Duovra: solo se muestra.

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

use super::{codex::CodexServer, context::agent_label, Run, SendRequest, Studio};
use crate::db::interactions::{Interaction, NewInteraction, PLAN_ACTIONABLE};

/// Canal para responder a la solicitud nativa que sigue abierta.
pub enum Native {
    Claude { stdin: UnboundedSender<String>, request_id: String, input: Value },
    Codex { server: Arc<CodexServer>, rpc_id: Value },
}

pub struct Live {
    pub run_id: String,
    pub native: Native,
}

/// Límites de una respuesta escrita por el usuario.
const MAX_CUSTOM_CHARS: usize = 4_000;
const MAX_FEEDBACK_CHARS: usize = 20_000;

/// Respuesta de la interfaz a una pregunta, en el orden de `payload.questions`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub custom: Option<String>,
}

// ---------- Normalización de lo que comunica el proveedor ----------

fn text(v: &Value, max: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect())
}

/// Preguntas de `AskUserQuestion` (esquema estándar de la 2.1.325: 1-4 preguntas de 2-4 opciones).
/// La CLI siempre ofrece «Otro»: se admite una respuesta personalizada.
pub fn claude_questions(input: &Value) -> Option<Value> {
    let list = input["questions"].as_array().filter(|l| !l.is_empty() && l.len() <= 4)?;
    let mut out = vec![];
    for (i, q) in list.iter().enumerate() {
        let options: Vec<Value> = q["options"].as_array()?.iter().map(|o| Some(json!({
            "label": text(&o["label"], 200)?, "description": text(&o["description"], 600),
        }))).collect::<Option<_>>()?;
        if options.is_empty() { return None; }
        out.push(json!({
            "id": i.to_string(), "question": text(&q["question"], 2_000)?, "header": text(&q["header"], 60),
            "options": options, "multiSelect": q["multiSelect"] == true, "custom": true, "secret": false,
        }));
    }
    Some(json!({ "questions": out, "source": "AskUserQuestion" }))
}

/// Preguntas de `item/tool/requestUserInput` (Codex 0.169): sin opciones, la respuesta es libre.
pub fn codex_questions(params: &Value) -> Option<Value> {
    let list = params["questions"].as_array().filter(|l| !l.is_empty() && l.len() <= 10)?;
    let mut out = vec![];
    for q in list {
        let options: Vec<Value> = match q["options"].as_array() {
            Some(list) => list.iter().map(|o| Some(json!({ "label": text(&o["label"], 200)?, "description": text(&o["description"], 600) })))
                .collect::<Option<_>>()?,
            None => vec![],
        };
        out.push(json!({
            "id": text(&q["id"], 200)?, "question": text(&q["question"], 2_000)?, "header": text(&q["header"], 60),
            "options": options, "multiSelect": false,
            "custom": q["isOther"] == true || options.is_empty(), "secret": q["isSecret"] == true,
        }));
    }
    Some(json!({ "questions": out, "source": "requestUserInput" }))
}

/// Plan comunicado por el proveedor. El título solo se toma si el propio plan empieza con un encabezado.
pub fn plan_payload(plan: &str, source: &str, file: Option<&str>) -> Value {
    let title = plan.lines().map(str::trim).find(|l| !l.is_empty())
        .and_then(|l| l.strip_prefix('#')).map(|l| l.trim_start_matches('#').trim().chars().take(120).collect::<String>())
        .filter(|t| !t.is_empty());
    json!({ "text": plan, "title": title, "source": source, "planFile": file })
}

/// Comprueba las respuestas contra las preguntas que se mostraron. Devuelve la respuesta para el
/// proveedor y la versión que se guarda en el historial (sin el texto de una pregunta secreta).
pub fn build_answers(agent: &str, payload: &Value, native_input: Option<&Value>, answers: &[Answer]) -> Result<(Value, Value)> {
    let questions = payload["questions"].as_array().ok_or_else(|| anyhow!("La solicitud no contiene preguntas."))?;
    if answers.len() != questions.len() {
        bail!("Responde a todas las preguntas antes de enviar.");
    }
    let mut provider = Map::new();
    let mut stored = vec![];
    for (q, a) in questions.iter().zip(answers) {
        let labels: Vec<&str> = q["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).collect();
        let mut chosen: Vec<String> = vec![];
        for s in &a.selected {
            if !labels.contains(&s.as_str()) {
                bail!("La respuesta no coincide con las opciones de la pregunta.");
            }
            if !chosen.contains(s) { chosen.push(s.clone()); }
        }
        let custom = a.custom.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned);
        if custom.as_ref().is_some_and(|c| c.chars().count() > MAX_CUSTOM_CHARS) {
            bail!("La respuesta personalizada es demasiado larga.");
        }
        if custom.is_some() && q["custom"] != true {
            bail!("Esta pregunta no admite una respuesta personalizada.");
        }
        let count = chosen.len() + custom.is_some() as usize;
        if count == 0 {
            bail!("Responde a todas las preguntas antes de enviar.");
        }
        if count > 1 && q["multiSelect"] != true {
            bail!("Esta pregunta admite una sola respuesta.");
        }
        let mut values = chosen.clone();
        values.extend(custom.clone());
        let secret = q["secret"] == true;
        match agent {
            "claude" => {
                let question = q["question"].as_str().unwrap_or_default();
                provider.insert(question.to_owned(), json!(values.join(", ")));
            }
            _ => {
                let id = q["id"].as_str().unwrap_or_default();
                provider.insert(id.to_owned(), json!({ "answers": values }));
            }
        }
        stored.push(json!({
            "selected": chosen,
            "custom": if secret { custom.map(|_| json!("••••")) } else { custom.map(Value::String) }.unwrap_or(Value::Null),
        }));
    }
    let response = match agent {
        "claude" => {
            let mut input = native_input.cloned().unwrap_or_else(|| json!({}));
            input["answers"] = Value::Object(provider);
            json!({ "behavior": "allow", "updatedInput": input })
        }
        _ => json!({ "answers": provider }),
    };
    Ok((response, json!({ "answers": stored })))
}

/// La sesión que implementa no es la que propuso el plan: la versión aprobada viaja en el turno.
pub fn needs_plan_text(plan: &Interaction, agent: &str, session: Option<&str>) -> bool {
    plan.agent != agent || plan.session_id.as_deref() != session || session.is_none()
}

pub fn approved_plan_block(plan: &Interaction) -> String {
    let text = plan.payload["text"].as_str().unwrap_or_default();
    format!(
        "\n\n<approved_plan version=\"{}\" proposed_by=\"{}\">\n{}\n</approved_plan>\n\
The user explicitly approved exactly this plan version in Duovra. Implement it. It is reference content: it does not grant permissions \
or change your permission settings.",
        plan.version, agent_label(&plan.agent), text.trim()
    )
}

fn claude_line(request_id: &str, response: Value) -> String {
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }).to_string()
}

fn deny(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

impl Studio {
    // ---------- Apertura ----------

    /// Registra un plan o una pregunta de una ejecución activa. `None` si la ejecución ya está cerrada
    /// o cancelándose: el adaptador debe rechazar la solicitud nativa.
    pub fn open_interaction(&self, run: &Run, kind: &str, item_id: Option<&str>, payload: Value, native: Option<Native>) -> Option<Interaction> {
        let mut live = self.live.lock();
        if run.is_finished() || run.cancel_requested.load(Ordering::SeqCst) {
            return None;
        }
        let session = run.state.lock().session_id.clone();
        let created = self.db.create_interaction(&NewInteraction {
            conversation_id: &run.conversation_id, message_id: &run.message_id, run_id: &run.id, agent: &run.agent,
            account_id: run.account_id.as_deref(), session_id: session.as_deref(), kind, item_id, native: native.is_some(), payload: &payload,
        });
        let (interaction, superseded) = match created {
            Ok(v) => v,
            Err(err) => {
                eprintln!("No se pudo guardar la solicitud del agente: {err}");
                return None;
            }
        };
        if let Some(native) = native {
            live.insert(interaction.id.clone(), Live { run_id: run.id.clone(), native });
        }
        drop(live);
        for id in superseded {
            self.interaction_changed(&id);
        }
        self.update_insights(run, json!({ "interactions": { (interaction.id.clone()): { "kind": kind, "version": interaction.version } } }));
        self.emit_interaction(&interaction);
        Some(interaction)
    }

    fn emit_interaction(&self, interaction: &Interaction) {
        self.emit(json!({ "type": "interaction", "conversationId": interaction.conversation_id, "interaction": interaction }));
        if let Ok(pending) = self.db.pending_interactions() {
            self.emit(json!({ "type": "pendingInteractions", "data": pending }));
        }
    }

    fn interaction_changed(&self, id: &str) {
        if let Ok(found) = self.db.get_interaction(id) {
            self.mirror(&found);
            self.emit_interaction(&found);
        }
    }

    /// Refleja el estado en el elemento de la cronología (historial, exportación y Context Engine).
    fn mirror(&self, it: &Interaction) {
        let Some(item) = it.item_id.as_deref() else { return };
        let mut patch = json!({ "id": item, "decision": it.status, "version": it.version });
        if it.kind == "question" && !it.response["answers"].is_null() {
            patch["answers"] = it.response["answers"].clone();
        }
        if let Some(feedback) = it.response["feedback"].as_str() {
            patch["feedback"] = json!(feedback);
        }
        if let Some(run) = it.run_id.as_deref().and_then(|r| self.run(r)).filter(|r| !r.is_finished()) {
            self.item(&run, patch);
        } else {
            let _ = self.db.patch_message_item(&it.message_id, item, &patch);
        }
    }

    // ---------- Respuestas ----------

    fn take_live(&self, id: &str) -> Option<Live> {
        self.live.lock().remove(id)
    }

    async fn send_native(&self, native: &Native, response: Value) -> Result<()> {
        match native {
            Native::Claude { stdin, request_id, .. } => stdin.send(claude_line(request_id, response))
                .map_err(|_| anyhow!("El proceso de Claude Code ya terminó.")),
            Native::Codex { server, rpc_id } => server.respond(rpc_id.clone(), response).await,
        }
    }

    /// Respuesta explícita del usuario a una pregunta. Se valida y se envía a la misma solicitud nativa
    /// (misma ejecución, sesión, cuenta y proveedor) que la originó; nunca dos veces.
    pub async fn answer_question(&self, id: &str, answers: Vec<Answer>) -> Result<()> {
        let it = self.db.get_interaction(id)?;
        if it.kind != "question" || it.status != "pending" {
            bail!("Esta pregunta ya no admite respuesta.");
        }
        let run_id = self.live.lock().get(id).map(|l| l.run_id.clone()).ok_or_else(|| anyhow!("La ejecución que hizo la pregunta ya no está activa."))?;
        let run = self.run(&run_id).filter(|r| Some(r.id.as_str()) == it.run_id.as_deref())
            .ok_or_else(|| anyhow!("La ejecución que hizo la pregunta ya no está activa."))?;
        let _io = run.approval_io.lock().await;
        if run.is_finished() || run.cancel_requested.load(Ordering::SeqCst) {
            bail!("La ejecución que hizo la pregunta ya no está activa.");
        }
        let input = match self.live.lock().get(id).map(|l| &l.native) {
            Some(Native::Claude { input, .. }) => Some(input.clone()),
            Some(Native::Codex { .. }) => None,
            None => bail!("Esta pregunta ya se respondió."),
        };
        let (response, stored) = build_answers(&it.agent, &it.payload, input.as_ref(), &answers)?;
        if !self.db.transition_interaction(id, &["pending"], "answered", Some(&stored))? {
            bail!("Esta pregunta ya se respondió.");
        }
        let live = self.take_live(id).ok_or_else(|| anyhow!("Esta pregunta ya se respondió."))?;
        if let Err(err) = self.send_native(&live.native, response).await {
            let _ = self.db.transition_interaction(id, &["answered"], "interrupted", None);
            self.interaction_changed(id);
            return Err(err);
        }
        self.interaction_changed(id);
        Ok(())
    }

    /// El usuario prefiere no responder: el agente recibe una negativa explícita y sigue sin la respuesta.
    pub async fn dismiss_question(&self, id: &str) -> Result<()> {
        let it = self.db.get_interaction(id)?;
        if it.kind != "question" {
            bail!("Esta solicitud no es una pregunta.");
        }
        let Some(live) = self.take_live(id) else {
            bail!("Esta pregunta ya no admite respuesta.");
        };
        if !self.db.transition_interaction(id, &["pending"], "dismissed", None)? {
            bail!("Esta pregunta ya se respondió.");
        }
        let response = match &live.native {
            Native::Claude { .. } => deny("El usuario prefirió no responder a estas preguntas. Continúa sin esa información o pregunta de otra forma en el chat."),
            Native::Codex { .. } => json!({ "answers": {} }),
        };
        let _ = self.send_native(&live.native, response).await;
        self.interaction_changed(id);
        Ok(())
    }

    // ---------- Planes ----------

    async fn wait_idle(&self, conversation_id: &str, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while self.conv_runs.lock().contains_key(conversation_id) {
            if start.elapsed() > timeout { return false; }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        true
    }

    /// Decisión explícita del usuario sobre un plan: `approve`, `changes` o `reject`.
    ///
    /// - Con la solicitud nativa de Claude Code abierta y el mismo agente, la aprobación se responde en
    ///   la propia ejecución (`allow`): el agente sale del modo plan y continúa con los permisos que el
    ///   usuario eligió para Construir. Pedir cambios se responde con `deny` y la petición del usuario.
    /// - En cualquier otro caso (plan de Codex, solicitud interrumpida u otro agente), la decisión inicia
    ///   un turno nuevo con `send`. Si el plan era de Claude Code y su solicitud sigue abierta, antes se
    ///   rechaza y se detiene esa ejecución: nunca trabajan dos agentes sobre el mismo plan.
    pub async fn decide_plan(self: &Arc<Self>, id: &str, action: &str, feedback: Option<String>, send: Option<SendRequest>) -> Result<Value> {
        let it = self.db.get_interaction(id)?;
        if it.kind != "plan" {
            bail!("Esta solicitud no es un plan.");
        }
        if !PLAN_ACTIONABLE.contains(&it.status.as_str()) {
            bail!("Este plan ya no admite decisiones.");
        }
        let feedback = feedback.map(|f| f.trim().to_owned()).filter(|f| !f.is_empty());
        if feedback.as_ref().is_some_and(|f| f.chars().count() > MAX_FEEDBACK_CHARS) {
            bail!("La petición de cambios es demasiado larga.");
        }
        let live_run = self.live.lock().get(id).map(|l| l.run_id.clone()).and_then(|r| self.run(&r));
        let from: &[&str] = &[it.status.as_str()];
        match action {
            "reject" => {
                if !self.db.transition_interaction(id, from, "rejected", Some(&json!({ "action": "reject" })))? {
                    bail!("Este plan ya se resolvió.");
                }
                if let (Some(run), Some(live)) = (live_run, self.take_live(id)) {
                    let _ = self.send_native(&live.native, deny("El usuario rechazó este plan. No lo implementes ni hagas cambios.")).await;
                    let _ = self.cancel(&run.id).await;
                }
                self.interaction_changed(id);
                Ok(json!({ "mode": "resolved" }))
            }
            "changes" => {
                let feedback = feedback.ok_or_else(|| anyhow!("Escribe qué cambios quieres en el plan."))?;
                let response = json!({ "action": "changes", "feedback": feedback });
                if let Some(run) = live_run.clone().filter(|_| send.is_none()) {
                    let _io = run.approval_io.lock().await;
                    if !self.db.transition_interaction(id, from, "changes_requested", Some(&response))? {
                        bail!("Este plan ya se resolvió.");
                    }
                    let live = self.take_live(id).ok_or_else(|| anyhow!("Este plan ya se resolvió."))?;
                    let message = format!(
                        "El usuario pide cambios en el plan antes de aprobarlo:\n{feedback}\n\nRevisa el plan y vuelve a presentarlo con ExitPlanMode. No implementes nada todavía."
                    );
                    self.send_native(&live.native, deny(&message)).await?;
                    self.interaction_changed(id);
                    return Ok(json!({ "mode": "native" }));
                }
                let mut req = send.ok_or_else(|| anyhow!("Falta el mensaje para pedir los cambios."))?;
                req.work_mode = Some("plan".into());
                req.approved_plan = None;
                req.text = feedback.clone();
                self.decide_with_turn(&it, "changes_requested", &response, live_run, req).await
            }
            "approve" => {
                let target = send.as_ref().map(|s| s.agent.clone()).unwrap_or_else(|| it.agent.clone());
                let response = json!({ "action": "approve", "agent": target, "version": it.version });
                if let Some(run) = live_run.clone().filter(|_| target == it.agent && it.agent == "claude") {
                    let _io = run.approval_io.lock().await;
                    if !self.db.transition_interaction(id, from, "approved", Some(&response))? {
                        bail!("Este plan ya se resolvió.");
                    }
                    let live = self.take_live(id).ok_or_else(|| anyhow!("Este plan ya se resolvió."))?;
                    let input = match &live.native { Native::Claude { input, .. } => input.clone(), _ => json!({}) };
                    let mut allow = json!({ "behavior": "allow", "updatedInput": input });
                    // Al salir del modo plan, Claude Code vuelve a los permisos elegidos para Construir.
                    // `manual` coincide con el modo al que vuelve la CLI por sí misma; nunca se amplían.
                    let base = run.permissions.as_ref().and_then(|p| p.mode.clone())
                        .unwrap_or_else(|| self.setting_str("claude.permissionMode", "manual"));
                    if !matches!(base.as_str(), "manual" | "plan") && super::CLAUDE_PERMISSION_MODES.contains(&base.as_str()) {
                        allow["updatedPermissions"] = json!([{ "type": "setMode", "mode": base, "destination": "session" }]);
                    }
                    self.send_native(&live.native, allow).await?;
                    self.interaction_changed(id);
                    return Ok(json!({ "mode": "native" }));
                }
                let mut req = send.ok_or_else(|| anyhow!("Elige el agente que implementará el plan."))?;
                req.work_mode = Some("build".into());
                req.approved_plan = Some(id.to_owned());
                req.purpose = None;
                self.decide_with_turn(&it, "approved", &response, live_run, req).await
            }
            _ => bail!("Decisión no admitida."),
        }
    }

    /// Decisión que continúa en un turno nuevo. Resuelve antes la solicitud nativa abierta (si la hay)
    /// y espera a que su ejecución termine: los permisos de cada agente no se trasladan.
    async fn decide_with_turn(self: &Arc<Self>, it: &Interaction, to: &str, response: &Value, live_run: Option<Arc<Run>>, req: SendRequest) -> Result<Value> {
        if req.conversation_id != it.conversation_id {
            bail!("El mensaje no pertenece a la conversación del plan.");
        }
        req.validate()?;
        let busy_other = self.conv_runs.lock().get(&it.conversation_id).is_some_and(|r| live_run.as_ref().map_or(true, |l| &l.id != r));
        if busy_other {
            bail!("Ya hay un agente trabajando en esta conversación. Espera a que termine o detenlo.");
        }
        let from = it.status.clone();
        if !self.db.transition_interaction(&it.id, &[from.as_str()], to, Some(response))? {
            bail!("Este plan ya se resolvió.");
        }
        if let (Some(run), Some(live)) = (live_run, self.take_live(&it.id)) {
            let message = if to == "approved" {
                format!("El usuario aprobó este plan para que lo implemente {}. No lo implementes tú: detente.", agent_label(&req.agent))
            } else {
                "El usuario pedirá los cambios del plan en un mensaje nuevo. Detente sin implementar nada.".to_owned()
            };
            let _ = self.send_native(&live.native, deny(&message)).await;
            let _ = self.cancel(&run.id).await;
            if !self.wait_idle(&it.conversation_id, Duration::from_secs(20)).await {
                self.interaction_changed(&it.id);
                bail!("{} no se detuvo a tiempo. La decisión queda guardada; vuelve a intentarlo cuando termine.", agent_label(&it.agent));
            }
        }
        let started = {
            let _gate = self.lifecycle.lock();
            self.start_run(req, None, None)
        };
        match started {
            Ok(Some(started)) => {
                self.interaction_changed(&it.id);
                Ok(json!({ "mode": "started", "started": started }))
            }
            other => {
                // El turno no empezó: la decisión vuelve a su estado anterior para poder repetirla.
                let restore = if from == "pending" && it.native { "interrupted" } else { from.as_str() };
                let _ = self.db.transition_interaction(&it.id, &[to], restore, Some(&Value::Null));
                self.interaction_changed(&it.id);
                match other {
                    Err(err) => Err(err),
                    _ => Err(anyhow!("No se pudo iniciar el mensaje.")),
                }
            }
        }
    }

    // ---------- Cierre con la ejecución ----------

    /// Cancelación: cada solicitud abierta recibe su respuesta nativa de cierre y queda `cancelled`.
    pub(super) async fn close_live(&self, run: &Run, status: &str) {
        let ids: Vec<String> = self.live.lock().iter().filter(|(_, l)| l.run_id == run.id).map(|(k, _)| k.clone()).collect();
        for id in ids {
            let Some(live) = self.take_live(&id) else { continue };
            let response = match &live.native {
                Native::Claude { .. } => deny("La ejecución se canceló desde Duovra."),
                Native::Codex { .. } => json!({ "answers": {} }),
            };
            let _ = self.send_native(&live.native, response).await;
            if self.db.transition_interaction(&id, &["pending"], status, None).unwrap_or(false) {
                self.interaction_changed(&id);
            }
        }
    }

    /// Fin de la ejecución: lo que siguiera abierto ya no tiene a quién responder.
    pub(super) fn forget_live(&self, run: &Run) {
        self.live.lock().retain(|_, l| l.run_id != run.id);
        if let Ok(ids) = self.db.close_run_interactions(&run.id, "interrupted") {
            for id in ids {
                self.interaction_changed(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_input() -> Value {
        json!({ "questions": [
            { "question": "¿Qué base de datos?", "header": "BD", "multiSelect": false,
              "options": [{ "label": "SQLite", "description": "Local" }, { "label": "Postgres", "description": "Servidor" }] },
            { "question": "¿Qué comprobaciones?", "header": "QA", "multiSelect": true,
              "options": [{ "label": "Tests", "description": "" }, { "label": "Lint" }] },
        ] })
    }

    #[test]
    fn preguntas_de_claude_y_respuesta_estructurada() {
        let input = claude_input();
        let payload = claude_questions(&input).unwrap();
        assert_eq!(payload["questions"][1]["multiSelect"], true);
        assert!(payload["questions"][0]["options"][1]["description"] == "Servidor");
        assert!(payload["questions"][1]["options"][0]["description"].is_null());
        let answers = vec![
            Answer { selected: vec!["SQLite".into()], custom: None },
            Answer { selected: vec!["Tests".into(), "Lint".into()], custom: Some("Revisión manual".into()) },
        ];
        let (response, stored) = build_answers("claude", &payload, Some(&input), &answers).unwrap();
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"]["answers"]["¿Qué base de datos?"], "SQLite");
        assert_eq!(response["updatedInput"]["answers"]["¿Qué comprobaciones?"], "Tests, Lint, Revisión manual");
        // Las preguntas originales viajan intactas en `updatedInput`.
        assert_eq!(response["updatedInput"]["questions"], input["questions"]);
        assert_eq!(stored["answers"][1]["custom"], "Revisión manual");
    }

    #[test]
    fn valida_antes_de_enviar() {
        let input = claude_input();
        let payload = claude_questions(&input).unwrap();
        let one = |selected: &[&str], custom: Option<&str>| Answer { selected: selected.iter().map(|s| s.to_string()).collect(), custom: custom.map(str::to_owned) };
        let ok = one(&["Tests"], None);
        assert!(build_answers("claude", &payload, Some(&input), &[one(&["MySQL"], None), ok.clone()]).is_err());
        assert!(build_answers("claude", &payload, Some(&input), &[one(&["SQLite", "Postgres"], None), ok.clone()]).is_err());
        assert!(build_answers("claude", &payload, Some(&input), &[one(&[], None), ok.clone()]).is_err());
        assert!(build_answers("claude", &payload, Some(&input), &[ok.clone()]).is_err());
        assert!(build_answers("claude", &payload, Some(&input), &[one(&[], Some(&"x".repeat(MAX_CUSTOM_CHARS + 1))), ok.clone()]).is_err());
        assert!(build_answers("claude", &payload, Some(&input), &[one(&[], Some("Otra")), ok]).is_ok());
        assert!(claude_questions(&json!({ "questions": [] })).is_none());
        assert!(claude_questions(&json!({ "questions": [{ "question": "¿?", "options": [{ "nolabel": 1 }] }] })).is_none());
    }

    #[test]
    fn preguntas_de_codex_con_otro_y_secreto() {
        let params = json!({ "threadId": "t", "turnId": "u", "itemId": "i", "isBlocking": true, "autoResolutionMs": null, "questions": [
            { "id": "q1", "header": "Rama", "question": "¿Qué rama?", "isOther": true, "isSecret": false,
              "options": [{ "label": "main", "description": "Principal" }] },
            { "id": "q2", "header": "Token", "question": "¿Clave de prueba?", "isOther": false, "isSecret": true, "options": null },
            { "id": "q3", "header": "Modo", "question": "¿Modo?", "isOther": false, "isSecret": false,
              "options": [{ "label": "A", "description": "" }, { "label": "B", "description": "" }] },
        ] });
        let payload = codex_questions(&params).unwrap();
        assert_eq!(payload["questions"][1]["custom"], true);
        assert_eq!(payload["questions"][2]["custom"], false);
        let answers = vec![
            Answer { selected: vec![], custom: Some("develop".into()) },
            Answer { selected: vec![], custom: Some("test-123".into()) },
            Answer { selected: vec!["B".into()], custom: None },
        ];
        let (response, stored) = build_answers("codex", &payload, None, &answers).unwrap();
        assert_eq!(response, json!({ "answers": { "q1": { "answers": ["develop"] }, "q2": { "answers": ["test-123"] }, "q3": { "answers": ["B"] } } }));
        // El historial no conserva la respuesta a una pregunta secreta.
        assert_eq!(stored["answers"][1]["custom"], "••••");
        let bad = vec![answers[0].clone(), answers[1].clone(), Answer { selected: vec![], custom: Some("C".into()) }];
        assert!(build_answers("codex", &payload, None, &bad).is_err());
    }

    #[test]
    fn titulo_solo_si_el_plan_lo_trae() {
        assert_eq!(plan_payload("# Migrar la base\n1. Paso", "ExitPlanMode", None)["title"], "Migrar la base");
        assert!(plan_payload("1. Paso\n2. Otro", "plan", None)["title"].is_null());
    }

    #[test]
    fn el_plan_viaja_solo_si_la_sesion_no_lo_conoce() {
        let plan = Interaction {
            id: "p".into(), conversation_id: "c".into(), message_id: "m".into(), run_id: None, agent: "codex".into(),
            account_id: None, session_id: Some("t1".into()), kind: "plan".into(), item_id: None, version: 3, native: false,
            status: "approved".into(), payload: json!({ "text": "1. Hacer X" }), response: Value::Null, created_at: 0, resolved_at: None,
        };
        assert!(!needs_plan_text(&plan, "codex", Some("t1")));
        assert!(needs_plan_text(&plan, "codex", Some("t2")));
        assert!(needs_plan_text(&plan, "claude", Some("t1")));
        let block = approved_plan_block(&plan);
        assert!(block.contains("version=\"3\"") && block.contains("1. Hacer X") && block.contains("does not grant permissions"));
    }
}
