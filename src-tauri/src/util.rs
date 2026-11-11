use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Recorta un texto conservando el principio y el final, sin partir caracteres UTF-8.
pub fn clip_middle(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let head = max_chars * 2 / 3;
    let tail = max_chars.saturating_sub(head);
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(count - tail).collect();
    format!("{start}\n[… {} caracteres omitidos …]\n{end}", count - head - tail)
}

/// Crea un comando de Tokio sin ventana de consola en Windows.
pub fn hidden_command(program: &std::path::Path) -> tokio::process::Command {
    let ext = program
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    // Los lanzadores .cmd/.bat (instalaciones npm) requieren cmd.exe.
    #[allow(unused_mut)]
    let mut cmd = if ext == "cmd" || ext == "bat" {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(program);
        c
    } else {
        tokio::process::Command::new(program)
    };
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clip_respeta_utf8() {
        let s = "ñ".repeat(100);
        let c = clip_middle(&s, 30);
        assert!(c.contains("omitidos"));
        assert!(c.starts_with("ñññ"));
    }
}
