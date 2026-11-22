//! Dueño del despacho. Las comprobaciones lentas no mantienen el bloqueo de ciclo de vida.
use super::{claude, codex, resolve_attachments, RunState, SendRequest, Studio};
use crate::db::queue::{QueueAction, QueueEntry, QueueView};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTarget {
    pub account_id: Option<String>,
    pub label: String,
    pub config_dir: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    pub request: SendRequest,
    pub target: ProviderTarget,
    pub attachments: Vec<Value>,
    pub identity: Option<Value>,
    pub resolved_model: Option<String>,
    pub effective_effort: Option<String>,
    pub capture_error: Option<String>,
}

impl QueuedInput {
    fn same_target(&self, other: &Self) -> bool {
        self.target == other.target && self.request.agent == other.request.agent
            && self.request.model == other.request.model && self.request.effort == other.request.effort
            && self.request.speed == other.request.speed
    }

    fn apply_capture(&mut self, captured: Self) {
        self.identity = captured.identity;
        self.resolved_model = captured.resolved_model;
        self.effective_effort = captured.effective_effort;
        self.capture_error = captured.capture_error;
    }
}

struct Catalog {
    server: Option<Arc<codex::CodexServer>>,
    identity: Value,
    models: Value,
}

impl Studio {
    fn provider_target(&self, agent: &str, account_id: Option<&str>) -> Result<ProviderTarget> {
        let account = match account_id {
            Some(id) => Some(self.db.list_accounts()?.into_iter().find(|a| a.id == id && a.agent == agent)
                .ok_or_else(|| anyhow!("La cuenta seleccionada de {} ya no existe.", super::context::agent_label(agent)))?),
            None => None,
        };
        Ok(ProviderTarget {
            account_id: account_id.map(str::to_owned),
            label: account.as_ref().map(|a| a.label.clone()).unwrap_or_else(|| "Cuenta predeterminada".into()),
            config_dir: account.and_then(|a| a.config_dir),
        })
    }

    async fn queue_catalog(self: &Arc<Self>, agent: &str, target: &ProviderTarget) -> Result<Catalog> {
        if target.config_dir.as_deref().is_some_and(|dir| !Path::new(dir).is_dir()) {
            bail!("La carpeta de la cuenta «{}» ya no está disponible.", target.label);
        }
        if agent == "codex" {
            let server = self.codex_server_for(target.config_dir.clone()).await?;
            let account = server.request("account/read", json!({ "refreshToken": false })).await?;
            let account = &account["account"];
            let email = account["email"].as_str().filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("Codex no informó una identidad verificable para «{}». Revisa el inicio de sesión.", target.label))?;
            let identity = json!({ "kind": account["type"], "email": email, "workspaceName": account["workspaceName"] });
            let models = codex::models_on(&server).await?;
            Ok(Catalog { server: Some(server), identity, models })
        } else {
            let dir = target.config_dir.as_deref();
            let auth = claude::auth_status_for(self, dir).await?;
            let email = auth["email"].as_str().filter(|s| !s.is_empty());
            if auth["loggedIn"] != true || email.is_none() {
                bail!("Claude Code no informó una identidad verificable para «{}». Revisa el inicio de sesión.", target.label);
            }
            let identity = json!({ "email": email, "orgId": auth["orgId"], "authMethod": auth["authMethod"], "apiProvider": auth["apiProvider"] });
            let models = claude::cli_info_for(self, dir, true).await?;
            Ok(Catalog { server: None, identity, models })
        }
    }

    async fn capture_input(self: &Arc<Self>, req: SendRequest, target: ProviderTarget, attachments: Vec<Value>) -> QueuedInput {
        let captured = async {
            let catalog = self.queue_catalog(&req.agent, &target).await?;
            let (resolved, effort) = actual_config(&req, &catalog.models)?;
            Ok::<_, anyhow::Error>((catalog.identity, resolved, effort))
        }.await;
        let (identity, resolved_model, effective_effort, capture_error) = match captured {
            Ok((identity, resolved, effort)) => (Some(identity), resolved, effort, None),
            Err(err) => (None, None, None, Some(err.to_string())),
        };
        QueuedInput { request: req, target, attachments, identity, resolved_model, effective_effort, capture_error }
    }

    pub async fn enqueue(self: &Arc<Self>, id: &str, req: SendRequest, account_id: Option<&str>, defer: bool) -> Result<QueueView> {
        req.validate()?;
        let cid = req.conversation_id.clone();
        let conv = self.db.get_conversation(&cid)?;
        let project = self.db.get_project(&conv.project_id)?;
        let attachments = resolve_attachments(&req, &project.path)?;
        let target = self.provider_target(&req.agent, account_id)?;
        // Anota la precaptura local antes de consultar un proveedor. Así un cierre durante
        // la consulta conserva el texto y nunca convierte una identidad desconocida en válida.
        let initial = QueuedInput {
            request: req.clone(), target: target.clone(), attachments: attachments.clone(),
            identity: None, resolved_model: None, effective_effort: None,
            capture_error: Some("La identidad del proveedor quedó sin verificar. Revisa la configuración del encargo.".into()),
        };
        let inserted = {
            let _gate = self.lifecycle.lock();
            let inserted = self.db.enqueue(id, &project.id, &initial, defer)?;
            if inserted {
                self.capturing.lock().insert(id.to_owned());
                self.queue_changed(&cid);
            }
            inserted
        };
        if inserted {
            let studio = self.clone();
            let cid = cid.clone();
            let id = id.to_owned();
            tauri::async_runtime::spawn(async move {
                let input = studio.capture_input(req, target, attachments).await;
                let _gate = studio.lifecycle.lock();
                studio.capturing.lock().remove(&id);
                // Una edición de texto o adjuntos conserva la captura en curso. Una
                // edición de destino o la retirada invalida esa captura.
                if let Ok(view) = studio.db.queue(&cid) {
                    if let Some(mut row) = view.entries.into_iter().find(|row| {
                        row.id == id && row.state == "pending" && row.input.identity.is_none() && row.input.same_target(&input)
                    }) {
                        row.input.apply_capture(input);
                        let _ = studio.db.edit_queue(&cid, &id, row.revision, &row.input);
                    }
                }
                studio.queue_changed(&cid);
                studio.kick_queue(&cid);
            });
        }
        self.db.queue(&cid)
    }

    /// Enviar desde el compositor: si la conversación está libre (sin ejecución, preparación,
    /// intervención ni cola pendiente o pausada) inicia el turno; si no, lo encola. La decisión y el
    /// inicio ocurren bajo el bloqueo de ciclo de vida, así que dos envíos rápidos nunca inician dos
    /// ejecuciones en la misma conversación: el segundo encuentra la primera y se encola.
    pub async fn submit(self: &Arc<Self>, id: &str, req: SendRequest, account_id: Option<&str>) -> Result<Value> {
        req.validate()?;
        let cid = req.conversation_id.clone();
        {
            let _gate = self.lifecycle.lock();
            if self.conversation_free(&cid)? {
                if let Some(started) = self.start_run(req.clone(), None, None)? {
                    return Ok(json!({ "mode": "started", "started": started }));
                }
            }
        }
        let queue = self.enqueue(id, req, account_id, false).await?;
        Ok(json!({ "mode": "queued", "queue": queue }))
    }

    /// Se llama con lifecycle adquirido.
    fn conversation_free(&self, cid: &str) -> Result<bool> {
        if self.conv_runs.lock().contains_key(cid) || self.preparing.lock().contains(cid) || self.steering.lock().contains(cid) {
            return Ok(false);
        }
        let queue = self.db.queue(cid)?;
        if !queue.entries.is_empty() { return Ok(false); }
        if queue.pause_reason.is_some() {
            // Sin encargos pendientes, enviar es la decisión explícita de continuar: la pausa se
            // levanta con las mismas comprobaciones que «Reanudar cola» (nunca tras un fallo al guardar).
            if self.db.queue_action(cid, QueueAction::Resume).is_err() { return Ok(false); }
            self.queue_changed(cid);
        }
        Ok(true)
    }

    pub async fn edit_queued(
        self: &Arc<Self>, id: &str, req: SendRequest, replace_target: bool, account_id: Option<&str>,
    ) -> Result<QueueView> {
        req.validate()?;
        let cid = req.conversation_id.clone();
        let old = self.db.queue(&cid)?.entries.into_iter().find(|e| e.id == id && e.state != "running")
            .ok_or_else(|| anyhow!("El encargo ya no se puede editar."))?;
        let project = self.db.get_project(&old.project_id)?;
        let mut input = old.input.clone();
        if !replace_target && (req.agent != input.request.agent || req.model != input.request.model || req.effort != input.request.effort
            || req.speed != input.request.speed) {
            bail!("Confirma el cambio de configuración antes de guardar.");
        }
        let attachments = resolve_attachments(&req, &project.path)?;
        if replace_target {
            let target = self.provider_target(&req.agent, account_id)?;
            input = self.capture_input(req, target, attachments).await;
        } else {
            input.request = req;
            input.attachments = attachments;
        }
        let _gate = self.lifecycle.lock();
        let latest = self.db.queue(&cid)?.entries.into_iter().find(|e| e.id == id && e.state != "running")
            .ok_or_else(|| anyhow!("El encargo ya no se puede editar."))?;
        if latest.input.request != old.input.request || latest.input.target != old.input.target || latest.state != old.state {
            bail!("El encargo ha cambiado. Abre de nuevo la edición.");
        }
        if !replace_target {
            input.apply_capture(latest.input);
        }
        self.db.edit_queue(&cid, id, latest.revision, &input)?;
        self.queue_changed(&cid);
        self.kick_queue(&cid);
        self.db.queue(&cid)
    }

    pub fn update_queue(self: &Arc<Self>, cid: &str, action: QueueAction) -> Result<QueueView> {
        let _gate = self.lifecycle.lock();
        self.db.queue_action(cid, action)?;
        self.queue_changed(cid);
        self.kick_queue(cid);
        self.db.queue(cid)
    }

    pub async fn reconcile_queued(self: &Arc<Self>, cid: &str, id: &str) -> Result<String> {
        let entry = self.db.queue(cid)?.entries.into_iter().find(|row| row.id == id && row.state == "review")
            .ok_or_else(|| anyhow!("Este encargo ya no está en revisión."))?;
        let (Some(session), Some(turn), Some(message)) = (&entry.session_id, &entry.turn_id, &entry.message_id) else {
            return Ok("Duovra no guardó un identificador de turno verificable. Revisa el historial y los archivos.".into());
        };
        if entry.input.request.agent != "codex" {
            return Ok("El proveedor no permite comprobar el resultado de este turno desde Duovra.".into());
        }
        let frozen = &entry.input.target;
        let target = self.provider_target("codex", frozen.account_id.as_deref())?;
        if target.config_dir != frozen.config_dir {
            bail!("Cambió la configuración de la cuenta. Revisa el historial en el perfil original.");
        }
        let catalog = self.queue_catalog("codex", &target).await?;
        if Some(&catalog.identity) != entry.input.identity.as_ref() {
            bail!("La sesión de proveedor pertenece a la identidad capturada al encolar.");
        }
        let server = catalog.server.ok_or_else(|| anyhow!("Codex no está disponible"))?;
        let found = server.request("thread/read", json!({ "threadId": session, "includeTurns": true })).await?;
        let exact = found["thread"]["turns"].as_array().and_then(|turns| turns.iter().find(|value| value["id"] == *turn));
        let Some(exact) = exact else {
            return Ok("Codex no devolvió el turno exacto. Revisa el historial y los archivos.".into());
        };
        if exact["status"] != "completed" {
            let detail = match exact["status"].as_str() {
                Some("failed") => "Codex registra el turno como fallido.",
                Some("interrupted") => "Codex registra el turno como interrumpido.",
                _ => "Codex no confirmó un resultado final. El turno puede seguir en curso o estar incompleto.",
            };
            return Ok(detail.into());
        }
        let previous = self.db.get_message(message)?;
        let mut restored = RunState::default();
        for item in previous.items.as_array().into_iter().flatten() {
            restored.upsert(item.clone());
        }
        for item in exact["items"].as_array().into_iter().flatten() {
            if let Some(normalized) = codex::normalize_item(item, true) {
                restored.upsert(normalized);
            }
        }
        restored.close_open_items("done");
        let content = restored.content();
        let _gate = self.lifecycle.lock();
        let recovered = self.db.reconcile_completed(
            &entry, if content.is_empty() { &previous.content } else { &content }, &Value::Array(restored.items),
        )?;
        self.emit(json!({ "type": "historyMessage", "conversationId": cid, "message": recovered }));
        self.queue_changed(cid);
        Ok("Codex confirmó que el turno terminó. La cola sigue pausada hasta que decidas reanudarla.".into())
    }

    pub(super) fn queue_changed(&self, cid: &str) {
        self.emit(json!({ "type": "queueChanged", "conversationId": cid }));
    }

    // Se llama con lifecycle adquirido. Un único candidato por conversación prepara el
    // despacho. SQLite vuelve a comprobar posición, revisión, pausa y exclusión al iniciar.
    pub(super) fn kick_queue(self: &Arc<Self>, cid: &str) {
        if self.conv_runs.lock().contains_key(cid) || self.preparing.lock().contains(cid) || self.steering.lock().contains(cid)
            || *self.installing_update.lock() || self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Ok(queue) = self.db.queue(cid) else { return };
        if queue.pause_reason.is_some() { return; }
        let Some(head) = queue.entries.into_iter().next().filter(|e| e.state == "pending") else { return };
        if self.capturing.lock().contains(&head.id) { return; }
        self.preparing.lock().insert(cid.to_owned());
        let studio = self.clone();
        let cid = cid.to_owned();
        tauri::async_runtime::spawn(async move {
            let result = studio.prepare_entry(&head).await;
            let _gate = studio.lifecycle.lock();
            studio.preparing.lock().remove(&cid);
            if studio.shutting_down.load(std::sync::atomic::Ordering::SeqCst) { return; }
            let started = result.and_then(|server| {
                studio.start_run(head.input.request.clone(), Some(&head), server)
            });
            match started {
                Ok(Some(_)) => {}
                Ok(None) => studio.kick_queue(&cid),
                Err(err) => {
                    match studio.db.block_queue(&cid, &head, &format!("{err:#}")) {
                        Ok(false) => studio.kick_queue(&cid),
                        Ok(true) => studio.queue_changed(&cid),
                        Err(save) => studio.emit(json!({ "type": "queueError", "conversationId": cid, "message": save.to_string() })),
                    }
                }
            }
        });
    }

    async fn prepare_entry(self: &Arc<Self>, entry: &QueueEntry) -> Result<Option<Arc<codex::CodexServer>>> {
        let input = &entry.input;
        let req = &input.request;
        let identity = input.identity.as_ref().ok_or_else(|| anyhow!("{}", input.capture_error.as_deref().unwrap_or("Verifica la cuenta de este encargo.")))?;
        let target = self.provider_target(&req.agent, input.target.account_id.as_deref())?;
        if target.config_dir != input.target.config_dir {
            bail!("Cambió la configuración de la cuenta «{}». Edita el encargo para revisarla.", target.label);
        }
        let catalog = self.queue_catalog(&req.agent, &target).await?;
        if &catalog.identity != identity {
            bail!("Cambió la identidad de proveedor de «{}». Edita el encargo para revisarla.", target.label);
        }
        let (resolved, effort) = actual_config(req, &catalog.models)?;
        if resolved != input.resolved_model || effort != input.effective_effort {
            bail!("Cambió el modelo o esfuerzo asociado a «{}». Edita el encargo para revisarlo.", req.model);
        }
        let project = self.db.get_project(&entry.project_id)?;
        if resolve_attachments(req, &project.path)? != input.attachments || req.attachments.iter().any(|p| !Path::new(p).exists()) {
            bail!("Cambió la disponibilidad de los adjuntos o referencias. Edita el encargo para revisarlos.");
        }
        Ok(catalog.server)
    }
}

fn actual_config(req: &SendRequest, catalog: &Value) -> Result<(Option<String>, Option<String>)> {
    let model = catalog["models"].as_array().and_then(|models| models.iter().find(|m| m["id"] == req.model))
        .ok_or_else(|| anyhow!("El modelo «{}» ya no está disponible para esta cuenta.", req.model))?;
    let effort = req.effort.clone().or_else(|| model["defaultEffort"].as_str().map(str::to_owned));
    if let Some(level) = &effort {
        if !model["efforts"].as_array().is_some_and(|levels| levels.iter().any(|value| value == level)) {
            bail!("El modelo «{}» no admite el esfuerzo «{}».", req.model, level);
        }
    }
    if let Some(speed) = req.speed.as_deref().filter(|speed| *speed != "default") {
        if model["fast"]["id"].as_str() != Some(speed) {
            bail!("El modelo «{}» no admite el modo rápido.", req.model);
        }
    }
    let resolved = model["resolved"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    if req.agent == "claude" && req.model == "default" && resolved.is_none() {
        bail!("Claude Code no informó el modelo asociado a «Predeterminado». Elige un modelo explícito.");
    }
    Ok((resolved, effort))
}
