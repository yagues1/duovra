//! Contexto compartido entre agentes.
//!
//! Cada proveedor conserva su propia sesión interna (hilo de Codex, sesión de Claude Code).
//! Cuando el usuario cambia de agente, el agente elegido solo recibe los intercambios que su
//! sesión no ha visto: los posteriores a su último turno (`last_seq`) o, si todavía no tiene
//! sesión en esta conversación, el historial previo. Se envía una sola vez, recortado a un
//! presupuesto de caracteres y empezando por lo más reciente, para no duplicar contexto.

use serde_json::{json, Value};
use std::collections::BTreeSet;

use crate::db::Message;
use crate::util::clip_middle;

/// Presupuesto total aproximado (≈ 8–10 mil tokens).
pub const DEFAULT_BUDGET_CHARS: usize = 36_000;
const PER_MESSAGE_CHARS: usize = 6_000;

pub struct ContextPlan {
    pub prompt: String,
    pub note: Value,
}

pub fn agent_label(agent: &str) -> &'static str {
    match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "Agente",
    }
}

fn actions_summary(items: &Value) -> Option<String> {
    let arr = items.as_array()?;
    let mut files = BTreeSet::new();
    let mut commands = Vec::new();
    for it in arr {
        match it.get("kind").and_then(Value::as_str) {
            Some("file_change") => {
                if let Some(changes) = it.get("changes").and_then(Value::as_array) {
                    for ch in changes {
                        if let Some(p) = ch.get("path").and_then(Value::as_str) {
                            files.insert(p.to_string());
                        }
                    }
                }
            }
            Some("command") => {
                if let Some(c) = it.get("command").and_then(Value::as_str) {
                    let exit = it
                        .get("exitCode")
                        .and_then(Value::as_i64)
                        .map(|e| format!(" (exit {e})"))
                        .unwrap_or_default();
                    commands.push(format!("`{}`{}", clip_middle(c, 160), exit));
                }
            }
            _ => {}
        }
    }
    if files.is_empty() && commands.is_empty() {
        return None;
    }
    let mut out = String::new();
    if !files.is_empty() {
        out.push_str("Files changed: ");
        out.push_str(&files.into_iter().collect::<Vec<_>>().join(", "));
        out.push('\n');
    }
    if !commands.is_empty() {
        let shown: Vec<_> = commands.iter().take(12).cloned().collect();
        out.push_str("Commands run: ");
        out.push_str(&shown.join("; "));
        if commands.len() > shown.len() {
            out.push_str(&format!("; … and {} more", commands.len() - shown.len()));
        }
        out.push('\n');
    }
    Some(out)
}

fn format_message(m: &Message) -> String {
    let agent = m.agent.as_deref().map(agent_label).unwrap_or("Agente");
    let model = m.model.as_deref().unwrap_or("modelo desconocido");
    if m.role == "user" {
        format!("### User (sent to {agent} · {model})\n{}\n", clip_middle(&m.content, PER_MESSAGE_CHARS))
    } else {
        let mut s = format!("### {agent} · {model} replied");
        match m.status.as_str() {
            "interrupted" => s.push_str(" (interrupted by the user)"),
            "failed" => s.push_str(" (run failed)"),
            _ => {}
        }
        s.push('\n');
        if m.content.trim().is_empty() {
            s.push_str("(no text answer)\n");
        } else {
            s.push_str(&clip_middle(&m.content, PER_MESSAGE_CHARS));
            s.push('\n');
        }
        if let Some(a) = actions_summary(&m.items) {
            s.push_str(&a);
        }
        s
    }
}

/// Construye el texto que se envía al agente elegido.
///
/// * `history`: mensajes existentes de la conversación, sin incluir el mensaje nuevo.
/// * `seen_until`: último `seq` que la sesión del agente ya conoce (`None` = sesión nueva).
pub fn build_prompt(
    history: &[Message],
    target_agent: &str,
    seen_until: Option<i64>,
    user_text: &str,
    budget: usize,
) -> ContextPlan {
    let unseen: Vec<&Message> = history
        .iter()
        .filter(|m| seen_until.map_or(true, |s| m.seq > s))
        .filter(|m| m.role == "user" || m.role == "assistant")
        .filter(|m| m.status != "running")
        .filter(|m| !(m.role == "assistant" && m.content.trim().is_empty() && m.items.as_array().map_or(true, |a| a.is_empty())))
        .collect();

    if unseen.is_empty() {
        return ContextPlan {
            prompt: user_text.to_string(),
            note: json!({ "mode": "none", "freshSession": seen_until.is_none() }),
        };
    }

    // Más reciente primero, hasta agotar el presupuesto.
    let mut blocks: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut included = 0usize;
    for m in unseen.iter().rev() {
        let b = format_message(m);
        if used + b.len() > budget && included > 0 {
            break;
        }
        used += b.len();
        blocks.push(b);
        included += 1;
    }
    blocks.reverse();
    let omitted = unseen.len() - included;
    let agents: BTreeSet<String> = unseen
        .iter()
        .rev()
        .take(included)
        .filter(|m| m.role == "assistant")
        .filter_map(|m| m.agent.clone())
        .collect();

    let omitted_line = if omitted > 0 {
        format!(" {omitted} older message(s) were omitted to respect the context budget.")
    } else {
        String::new()
    };
    let target = agent_label(target_agent);
    let prompt = format!(
        "<conversation_context source=\"Duovra\">\n\
The user works in a desktop app where they manually choose which coding agent ({target} or another one) answers each message. \
The exchanges below happened earlier in this same conversation but are NOT part of your own session history: they were handled by another agent or by a previous session. \
Use them as reference context, keep attribution accurate, and do not redo finished work unless asked.{omitted_line}\n\n\
{}\n</conversation_context>\n\n{user_text}",
        blocks.join("\n")
    );
    ContextPlan {
        prompt,
        note: json!({
            "mode": "shared",
            "messages": included,
            "omitted": omitted,
            "agents": agents.into_iter().collect::<Vec<_>>(),
            "chars": used,
            "freshSession": seen_until.is_none(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(seq: i64, role: &str, agent: &str, content: &str) -> Message {
        Message {
            id: format!("m{seq}"),
            conversation_id: "c".into(),
            seq,
            role: role.into(),
            agent: Some(agent.into()),
            model: Some("model-x".into()),
            effort: None,
            content: content.into(),
            items: json!([]),
            status: "done".into(),
            error: None,
            usage: Value::Null,
            context_note: Value::Null,
            attachments: json!([]),
            created_at: 0,
            completed_at: None,
        }
    }

    #[test]
    fn sin_historial_no_anade_contexto() {
        let p = build_prompt(&[], "claude", None, "hola", DEFAULT_BUDGET_CHARS);
        assert_eq!(p.prompt, "hola");
        assert_eq!(p.note["mode"], "none");
    }

    #[test]
    fn solo_incluye_lo_no_visto_por_el_agente() {
        let h = vec![
            msg(1, "user", "claude", "primera"),
            msg(2, "assistant", "claude", "respuesta claude"),
            msg(3, "user", "codex", "pregunta a codex"),
            msg(4, "assistant", "codex", "respuesta codex"),
        ];
        // Claude ya vio hasta seq 2: solo recibe el intercambio con Codex.
        let p = build_prompt(&h, "claude", Some(2), "sigue", DEFAULT_BUDGET_CHARS);
        assert!(p.prompt.contains("respuesta codex"));
        assert!(!p.prompt.contains("respuesta claude"));
        assert!(p.prompt.ends_with("sigue"));
        assert_eq!(p.note["messages"], 2);
        assert_eq!(p.note["agents"][0], "codex");
    }

    #[test]
    fn sesion_al_dia_no_duplica() {
        let h = vec![msg(1, "user", "codex", "a"), msg(2, "assistant", "codex", "b")];
        let p = build_prompt(&h, "codex", Some(2), "c", DEFAULT_BUDGET_CHARS);
        assert_eq!(p.prompt, "c");
    }

    #[test]
    fn respeta_el_presupuesto_empezando_por_lo_reciente() {
        let h: Vec<Message> = (1..=40).map(|i| msg(i, "assistant", "codex", &"x".repeat(1000))).collect();
        let p = build_prompt(&h, "claude", None, "q", 5_000);
        let n = p.note["messages"].as_u64().unwrap();
        assert!(n < 40 && n >= 1);
        assert_eq!(p.note["omitted"].as_u64().unwrap() + n, 40);
        assert!(p.prompt.contains("omitted"));
    }
}
