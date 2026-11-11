//! Detección de las CLIs instaladas de Claude Code y Codex.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use crate::util::hidden_command;

fn binary_name(agent: &str) -> &'static str {
    match agent {
        "claude" => "claude",
        _ => "codex",
    }
}

/// Rutas habituales de instalación en Windows, por si la aplicación se abre sin el PATH del usuario.
fn candidates(agent: &str) -> Vec<PathBuf> {
    let mut v = Vec::new();
    let home = dirs::home_dir();
    let local = dirs::data_local_dir();
    let roaming = dirs::data_dir();
    match agent {
        "claude" => {
            if let Some(h) = &home {
                v.push(h.join(".local").join("bin").join("claude.exe"));
            }
            if let Some(r) = &roaming {
                v.push(r.join("npm").join("claude.cmd"));
            }
        }
        _ => {
            if let Some(l) = &local {
                v.push(l.join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe"));
            }
            if let Some(r) = &roaming {
                v.push(r.join("npm").join("codex.cmd"));
            }
        }
    }
    v
}

pub fn resolve_executable(agent: &str, override_path: Option<String>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(p) = which::which(binary_name(agent)) {
        return Some(p);
    }
    candidates(agent).into_iter().find(|p| p.is_file())
}

pub async fn version(exe: &std::path::Path) -> Option<String> {
    let mut cmd = hidden_command(exe);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

pub async fn detect(agent: &str, override_path: Option<String>) -> Value {
    match resolve_executable(agent, override_path) {
        Some(path) => {
            let v = version(&path).await;
            json!({ "agent": agent, "installed": true, "path": path, "version": v, "working": v.is_some() })
        }
        None => json!({ "agent": agent, "installed": false, "path": Value::Null, "version": Value::Null, "working": false }),
    }
}
