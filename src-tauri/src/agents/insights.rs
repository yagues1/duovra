//! Reglas de proyección. Los contadores ausentes conservan su valor desconocido.

use serde_json::{json, Value};
use std::collections::HashMap;

pub fn number(v: &Value) -> Option<i64> {
    v.as_i64().filter(|n| *n >= 0)
}

fn sum(values: &[Option<i64>]) -> Option<i64> {
    values.iter().try_fold(0i64, |acc, n| acc.checked_add((*n)?))
}

pub fn status(v: &Value) -> Option<&'static str> {
    match v.as_str()? {
        "pending" | "pendingInit" => Some("pending"),
        "in_progress" | "inProgress" | "running" | "started" => Some("running"),
        "completed" => Some("completed"),
        "blocked" => Some("blocked"),
        "failed" | "errored" => Some("failed"),
        "cancelled" | "stopped" | "shutdown" | "killed" => Some("cancelled"),
        "interrupted" => Some("interrupted"),
        _ => None,
    }
}

pub fn plan_steps(value: &Value, title_key: &str) -> Option<Vec<Value>> {
    let rows = value.as_array()?;
    rows.iter().map(|row| {
        Some(json!({
            "title": row[title_key].as_str()?, "status": status(&row["status"]),
            "description": row["description"], "activeForm": row["activeForm"],
        }))
    }).collect()
}

const CODEX_KEYS: [&str; 6] = [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens",
    "outputTokens", "reasoningOutputTokens", "totalTokens",
];

#[derive(Default)]
pub struct CodexUsage {
    previous: Value,
    fresh: bool,
    first: bool,
    discontinuous: bool,
    pub partial: bool,
    added: [Option<i64>; CODEX_KEYS.len()],
}

impl CodexUsage {
    pub fn new(fresh: bool, baseline: Value) -> Self {
        Self { previous: baseline, fresh, first: true, ..Default::default() }
    }

    pub fn snapshot(&mut self, snapshot: &Value, session: &str) -> Option<Value> {
        let total = &snapshot["total"];
        let current_total = number(&total["totalTokens"])?;
        let last = &snapshot["last"];
        let trusted = self.fresh || self.previous.is_object();
        if !trusted { self.partial = true; }
        let prior_total = number(&self.previous["totalTokens"]);
        let regressed = prior_total.is_some_and(|p| current_total < p);
        let gap = self.first && !self.fresh && prior_total
            .is_some_and(|p| current_total > p && Some(current_total - p) != number(&last["totalTokens"]));
        // App Server también puede rellenar el contador hasta la ventana de
        // contexto. Ese snapshot sintético carece de entrada y salida.
        let synthetic = current_total > 0 && number(&total["inputTokens"]) == Some(0)
            && number(&total["outputTokens"]) == Some(0);
        self.discontinuous |= synthetic;
        self.first = false;
        if gap || regressed || synthetic { self.partial = true; }
        let advanced = prior_total.map_or(self.fresh && current_total > 0, |p| current_total > p);
        for (i, key) in CODEX_KEYS.iter().enumerate() {
            let before = if self.fresh { Some(0) } else { number(&self.previous[key]) };
            let delta = number(&total[key]).zip(before)
                .and_then(|(current, before)| current.checked_sub(before).filter(|n| *n >= 0));
            match delta {
                Some(n) if !gap && !regressed && !self.discontinuous && (advanced || self.added[i].is_some()) => {
                    self.added[i] = self.added[i].unwrap_or(0).checked_add(n);
                }
                None if i != 2 => self.partial = true,
                _ => {}
            }
        }
        if !regressed && !synthetic { self.previous = total.clone(); }
        self.fresh = false;
        let [input, read, write, output, reasoning, total_tokens] = self.added;
        let observed_request = total_tokens.is_some() && !regressed && !self.discontinuous;
        Some(json!({
            "accountingVersion": 1, "source": "codex", "sessionId": session,
            "inputTokens": input, "cachedInputTokens": read, "cacheWriteInputTokens": write,
            "freshInputTokens": input.zip(read).and_then(|(i, r)| i.checked_sub(r).filter(|n| *n >= 0)),
            "outputTokens": output, "reasoningTokens": reasoning, "totalTokens": total_tokens,
            "contextTokens": number(&last["inputTokens"]).filter(|n| observed_request && *n > 0),
            "contextWindow": number(&snapshot["modelContextWindow"]).filter(|n| observed_request && *n > 0),
            "threadTotal": self.previous, "lastRequest": if observed_request { last } else { &Value::Null },
            "partial": self.partial || total_tokens.is_none(),
        }))
    }
}

const CLAUDE_INPUT: [&str; 3] = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

#[derive(Default)]
pub struct ClaudeUsage {
    requests: HashMap<String, [Option<i64>; 3]>,
}

impl ClaudeUsage {
    pub fn context_tokens(usage: &Value) -> Option<i64> {
        sum(&CLAUDE_INPUT.map(|key| number(&usage[key])))
    }
    pub fn request(&mut self, id: &str, usage: &Value) -> bool {
        if id.is_empty() || !usage.is_object() || self.requests.contains_key(id) { return false; }
        self.requests.insert(id.to_owned(), CLAUDE_INPUT.map(|key| number(&usage[key])));
        true
    }

    pub fn metrics(&self, result: Option<&Value>) -> Value {
        let crash = result.is_some_and(|r| {
            r["subtype"] == "error_during_execution"
                && number(&r["usage"]["output_tokens"]).unwrap_or(0) == 0
                && !CLAUDE_INPUT.iter().any(|k| number(&r["usage"][*k]).is_some_and(|n| n > 0))
        });
        let usage = result.filter(|_| !crash).map(|r| &r["usage"]);
        let input_parts = CLAUDE_INPUT.map(|key| usage.and_then(|u| number(&u[key])));
        let [fresh, read, write] = std::array::from_fn(|i| {
            input_parts[i].or_else(|| {
                if self.requests.is_empty() { return None; }
                self.requests.values().try_fold(0i64, |acc, usage| acc.checked_add(usage[i]?))
            })
        });
        let input = sum(&[fresh, read, write]);
        let output = usage.and_then(|u| number(&u["output_tokens"]));
        json!({
            "accountingVersion": 1, "source": "claude", "scope": "main",
            "inputTokens": input, "freshInputTokens": fresh, "cachedInputTokens": read,
            "cacheWriteInputTokens": write, "outputTokens": output, "totalTokens": sum(&[input, output]),
            "partial": result.is_none() || crash || input.is_none() || output.is_none()
                || result.is_some_and(|r| r["subtype"] != "success" || r["is_error"] == true),
        })
    }
}

pub fn claude_cost(result: &Value, resume: Option<&str>, previous: Option<&Value>) -> Option<f64> {
    let total = result["total_cost_usd"].as_f64().filter(|n| *n >= 0.0)?;
    if result["subtype"] == "error_during_execution" && total == 0.0 { return None; }
    let session = result["session_id"].as_str()?;
    if resume != Some(session) { return Some(total); }
    let prev = previous.filter(|v| {
        v["sessionId"].as_str() == Some(session) && v["previousStatus"] == "done"
    })?["sessionCostUsd"].as_f64()?;
    (total >= prev).then_some(total - prev)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex(n: i64) -> Value {
        json!({
            "inputTokens": n * 500, "cachedInputTokens": n * 320,
            "outputTokens": n * 70, "reasoningOutputTokens": n * 17, "totalTokens": n * 570,
        })
    }

    fn packet(n: i64) -> Value {
        json!({ "total": codex(n), "last": codex(1), "modelContextWindow": 258400 })
    }

    #[test]
    fn codex_reemplaza_snapshots_y_conserva_el_alcance_de_cada_contador() {
        let mut usage = CodexUsage::new(true, Value::Null);
        let first = usage.snapshot(&packet(1), "thread").unwrap();
        assert_eq!(first, usage.snapshot(&packet(1), "thread").unwrap());
        let final_usage = usage.snapshot(&packet(2), "thread").unwrap();
        assert_eq!(final_usage["inputTokens"], 1000);
        assert_eq!(final_usage["contextTokens"], 500);
        assert_eq!(final_usage["reasoningTokens"], 34);
        assert_eq!(final_usage["totalTokens"], 1140);
        assert!(final_usage["cacheWriteInputTokens"].is_null());
        let mut resumed = CodexUsage::new(false, final_usage["threadTotal"].clone());
        let replay = resumed.snapshot(&packet(2), "thread").unwrap();
        assert!(replay["inputTokens"].is_null());
        assert!(replay["contextTokens"].is_null());
        let later = resumed.snapshot(&packet(3), "thread").unwrap();
        assert_eq!(later["inputTokens"], 500);
        assert_eq!(later["threadTotal"]["inputTokens"], 1500);
        // Las notificaciones atrasadas y un reset no vuelven a sumar tokens.
        assert_eq!(resumed.snapshot(&packet(2), "thread").unwrap()["inputTokens"], 500);
        assert_eq!(resumed.snapshot(&packet(3), "thread").unwrap()["inputTokens"], 500);
    }

    #[test]
    fn codex_no_contabiliza_un_relleno_sintetico_de_contexto() {
        let mut usage = CodexUsage::new(true, Value::Null);
        usage.snapshot(&packet(1), "thread").unwrap();
        let synthetic = json!({
            "total": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 258400 },
            "last": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 257830 },
            "modelContextWindow": 258400,
        });
        let metrics = usage.snapshot(&synthetic, "thread").unwrap();
        assert_eq!(metrics["totalTokens"], 570);
        assert_eq!(metrics["partial"], true);
        assert!(metrics["contextTokens"].is_null());
        assert_eq!(usage.snapshot(&packet(2), "thread").unwrap()["totalTokens"], 570);
    }

    #[test]
    fn codex_reanudado_sin_base_o_con_salto_marca_cobertura_parcial() {
        for base in [Value::Null, codex(1)] {
            let mut usage = CodexUsage::new(false, base);
            let first = usage.snapshot(&packet(5), "thread").unwrap();
            assert!(first["inputTokens"].is_null());
            assert_eq!(first["partial"], true);
            let second = usage.snapshot(&packet(6), "thread").unwrap();
            assert_eq!(second["inputTokens"], 500);
            assert_eq!(second["partial"], true);
        }
    }

    #[test]
    fn claude_reconcilia_resultado_coste_y_solicitudes_repetidas() {
        let mut usage = ClaudeUsage::default();
        let request = json!({ "input_tokens": 120, "cache_read_input_tokens": 1500, "cache_creation_input_tokens": 300, "output_tokens": 1 });
        assert!(usage.request("one", &request));
        assert!(!usage.request("one", &request));
        let crash = json!({ "subtype": "error_during_execution", "usage": { "input_tokens": 0, "output_tokens": 0 } });
        let partial = usage.metrics(Some(&crash));
        assert_eq!(partial["inputTokens"], 1920);
        assert_eq!(partial["partial"], true);
        assert!(partial["outputTokens"].is_null());
        let result = json!({
            "subtype": "success", "session_id": "s", "total_cost_usd": 0.014,
            "usage": { "input_tokens": 120, "cache_read_input_tokens": 1500, "cache_creation_input_tokens": 300, "output_tokens": 84 },
        });
        let final_usage = usage.metrics(Some(&result));
        assert_eq!(final_usage["totalTokens"], 2004);
        assert_eq!(final_usage["partial"], false);
        assert_eq!(claude_cost(&result, None, None), Some(0.014));
        assert!(claude_cost(&result, Some("s"), None).is_none());
        let prior = json!({ "sessionId": "s", "sessionCostUsd": 0.01, "previousStatus": "done" });
        assert!((claude_cost(&result, Some("s"), Some(&prior)).unwrap() - 0.004).abs() < 1e-10);
        let decreasing = json!({ "sessionId": "s", "sessionCostUsd": 0.02, "previousStatus": "done" });
        assert!(claude_cost(&result, Some("s"), Some(&decreasing)).is_none());
        assert!(usage.metrics(Some(&json!({ "usage": {} })))["outputTokens"].is_null());
    }
}
