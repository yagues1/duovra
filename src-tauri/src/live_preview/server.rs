//! Servidores de desarrollo iniciados por Duovra para Live Preview.
//!
//! - Solo se ejecuta el comando que el usuario configuró, y solo cuando pulsa «Iniciar».
//! - El proceso corre en el directorio del espacio (proyecto o worktree) que lo inició.
//! - Duovra solo detiene procesos que inició él mismo: nunca toca servidores externos ni de los
//!   agentes. Un Job Object con `KILL_ON_JOB_CLOSE` garantiza que no queden huérfanos si Duovra
//!   termina de forma inesperada.
//! - La salida se conserva en un búfer limitado (no es una terminal interactiva).

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

const MAX_LINES: usize = 300;
const MAX_LINE: usize = 600;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub running: bool,
    pub pid: Option<u32>,
    pub command: String,
    pub root: String,
    pub started_at: i64,
    pub exit_code: Option<i32>,
    pub lines: Vec<String>,
    /// Direcciones locales que el propio servidor anunció en su salida.
    pub urls: Vec<String>,
}

struct Proc {
    view: ServerView,
    lines: VecDeque<String>,
}

#[derive(Default)]
pub struct Servers {
    procs: Mutex<HashMap<String, Arc<Mutex<Proc>>>>,
}

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::*;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(Job(handle))
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// El proceso y los que cree después mueren con Duovra.
    pub fn adopt(pid: u32) {
        let Some(job) = job() else { return };
        unsafe {
            if let Ok(process) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
                let _ = AssignProcessToJobObject(job, process);
                let _ = CloseHandle(process);
            }
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Direcciones locales http(s) en un texto (localhost, 127.0.0.1, 0.0.0.0, [::1]).
pub fn local_urls(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for start in ["http://", "https://"] {
        let mut rest = text;
        while let Some(i) = rest.find(start) {
            let tail = &rest[i..];
            let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')' | '`')).unwrap_or(tail.len());
            let candidate = tail[..end].trim_end_matches(['.', ',', ';']);
            let host = &candidate[start.len()..];
            if ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].iter().any(|h| host.starts_with(h)) {
                let url = candidate.replacen("0.0.0.0", "localhost", 1);
                if !found.contains(&url) {
                    found.push(url);
                }
            }
            rest = &tail[end.max(1)..];
        }
    }
    found
}

impl Servers {
    pub fn view(&self, space: &str) -> Option<ServerView> {
        let proc = self.procs.lock().get(space).cloned()?;
        let p = proc.lock();
        let mut view = p.view.clone();
        view.lines = p.lines.iter().cloned().collect();
        Some(view)
    }

    pub fn start(&self, space: &str, root: &str, command: &str, changed: Arc<dyn Fn() + Send + Sync>) -> anyhow::Result<ServerView> {
        let command = command.trim();
        if command.is_empty() || command.len() > 400 || command.contains(['\n', '\r']) {
            anyhow::bail!("El comando del servidor no es válido.");
        }
        if let Some(view) = self.view(space) {
            if view.running {
                anyhow::bail!("Este espacio ya tiene un servidor iniciado por Duovra.");
            }
        }
        if !std::path::Path::new(root).is_dir() {
            anyhow::bail!("El directorio del espacio no existe: {root}");
        }
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/D").arg("/S").arg("/C").arg(command).current_dir(root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("FORCE_COLOR", "0")
            .env("BROWSER", "none");
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| anyhow::anyhow!("No se pudo iniciar el servidor: {e}"))?;
        let pid = child.id();
        #[cfg(windows)]
        if let Some(pid) = pid {
            job::adopt(pid);
        }
        let proc = Arc::new(Mutex::new(Proc {
            view: ServerView { running: true, pid, command: command.into(), root: root.into(), started_at: now(), ..Default::default() },
            lines: VecDeque::new(),
        }));
        self.procs.lock().insert(space.into(), proc.clone());

        let pump = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
            let proc = proc.clone();
            let changed = changed.clone();
            tauri::async_runtime::spawn(async move {
                let Some(stream) = stream else { return };
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut line = strip_ansi(&line);
                    if line.len() > MAX_LINE {
                        let mut cut = MAX_LINE;
                        while !line.is_char_boundary(cut) { cut -= 1; }
                        line.truncate(cut);
                    }
                    {
                        let mut p = proc.lock();
                        for url in local_urls(&line) {
                            if !p.view.urls.contains(&url) && p.view.urls.len() < 6 {
                                p.view.urls.push(url);
                            }
                        }
                        if p.lines.len() >= MAX_LINES { p.lines.pop_front(); }
                        p.lines.push_back(line);
                    }
                    changed();
                }
            });
        };
        pump(child.stdout.take().map(|s| Box::new(s) as _));
        pump(child.stderr.take().map(|s| Box::new(s) as _));
        let waiter = proc.clone();
        tauri::async_runtime::spawn(async move {
            let status = child.wait().await.ok();
            {
                let mut p = waiter.lock();
                p.view.running = false;
                p.view.exit_code = status.and_then(|s| s.code());
            }
            changed();
        });
        Ok(self.view(space).unwrap_or_default())
    }

    /// Detiene solo el árbol de procesos que inició Duovra para este espacio.
    pub fn stop(&self, space: &str) -> anyhow::Result<()> {
        let Some(proc) = self.procs.lock().get(space).cloned() else { return Ok(()) };
        let (running, pid) = { let p = proc.lock(); (p.view.running, p.view.pid) };
        if let (true, Some(pid)) = (running, pid) {
            kill_tree(pid);
        }
        Ok(())
    }

    pub fn forget(&self, space: &str) {
        let stopped = self.procs.lock().get(space).map(|p| !p.lock().view.running).unwrap_or(false);
        if stopped {
            self.procs.lock().remove(space);
        }
    }

    pub fn shutdown(&self) {
        for proc in self.procs.lock().values() {
            let p = proc.lock();
            if let (true, Some(pid)) = (p.view.running, p.view.pid) {
                kill_tree(pid);
            }
        }
    }
}

fn kill_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_local_urls_in_dev_server_output() {
        assert_eq!(local_urls("  ➜  Local:   http://localhost:5173/"), vec!["http://localhost:5173/"]);
        assert_eq!(local_urls("ready on http://0.0.0.0:3000, also https://example.com"), vec!["http://localhost:3000"]);
        assert!(local_urls("visit https://example.com").is_empty());
        assert_eq!(strip_ansi("\u{1b}[32mhttp://127.0.0.1:8080\u{1b}[0m"), "http://127.0.0.1:8080");
    }
}
