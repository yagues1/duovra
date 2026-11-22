use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

const MAX_FILE: usize = 1024 * 1024;
const MAX_DIFF: usize = 512 * 1024;
const MAX_NEW_DIFF_LINES: usize = 6_000;
const MAX_ENTRIES: usize = 2_000;
const SCAN_BUDGET: usize = 25_000;
const IGNORED: &[&str] = &[".git", "node_modules", "target", ".next", ".venv", "dist"];

pub struct Workspace(PathBuf, PathBuf);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    name: String,
    directory: bool,
}

#[derive(Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
    limited: bool,
}

#[derive(Serialize)]
pub struct Document {
    path: PathBuf,
    relative: String,
    revision: Option<String>,
    size: u64,
    truncated: bool,
    binary: bool,
    content: String,
}

fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

fn slash(path: &Path) -> String {
    #[cfg(windows)]
    return path.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    path.to_string_lossy().into_owned()
}

impl Workspace {
    pub fn open(path: &str) -> Result<Self> {
        let root = fs::canonicalize(path).context("No se pudo abrir la carpeta del proyecto")?;
        if !root.is_dir() {
            bail!("La ruta del proyecto no es una carpeta");
        }
        Ok(Self(root, std::path::absolute(path)?))
    }

    fn relative(&self, path: &str, allow_absolute: bool) -> Result<PathBuf> {
        let input = Path::new(path);
        if input.components().any(|c| matches!(c, Component::ParentDir)) {
            bail!("La ruta contiene un salto de carpeta");
        }
        let relative = if allow_absolute && input.is_absolute() {
            // Descarta destinos externos antes de cualquier consulta de su sistema de archivos.
            input.strip_prefix(&self.0).or_else(|_| input.strip_prefix(&self.1))
                .context("La ruta está fuera del proyecto")?
        } else {
            input
        };
        let mut normalized = PathBuf::new();
        for component in relative.components() {
            let name = match component {
                Component::Normal(name) => name,
                Component::CurDir => continue,
                _ => bail!("Se esperaba una ruta relativa al proyecto"),
            };
            let name = name.to_str().context("La ruta no es texto válido")?;
            if name.eq_ignore_ascii_case(".git")
                || (cfg!(windows) && (name.contains(':') || name.ends_with(['.', ' '])))
            {
                bail!("Ruta fuera del espacio de archivos del proyecto");
            }
            normalized.push(name);
        }
        Ok(normalized)
    }

    fn resolve(&self, relative: &Path, allow_missing: bool) -> Result<PathBuf> {
        let mut target = self.0.clone();
        for component in relative.components() {
            target.push(component);
            match fs::symlink_metadata(&target) {
                Ok(meta) if linked(&meta) => bail!("La ruta pasa por un enlace o punto de montaje"),
                Ok(_) => {}
                Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("No se pudo leer la ruta"),
            }
        }
        Ok(target)
    }

    fn existing(&self, relative: &Path) -> Result<PathBuf> {
        let path = fs::canonicalize(self.resolve(relative, false)?).context("No se pudo abrir la ruta")?;
        if !path.starts_with(&self.0) {
            bail!("La ruta está fuera del proyecto");
        }
        self.relative(&slash(path.strip_prefix(&self.0)?), false)?;
        Ok(path)
    }

    /// Las menciones viajan como la misma clase de adjunto de ruta que usan los archivos no incrustados.
    pub fn references(project: &str, text: &str) -> Result<Vec<serde_json::Value>> {
        let mut paths = Vec::new();
        let mut consumed = 0;
        for (start, _) in text.match_indices("@\"") {
            if start < consumed || (start > 0 && !text[..start].ends_with(char::is_whitespace)) {
                continue;
            }
            let mut stream = serde_json::Deserializer::from_str(&text[start + 1..]).into_iter::<String>();
            if let Some(Ok(path)) = stream.next() {
                consumed = start + 1 + stream.byte_offset();
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            if paths.len() > 32 {
                bail!("Un mensaje puede referenciar hasta 32 archivos");
            }
        }
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let workspace = Self::open(project)?;
        paths.into_iter().map(|path| {
            let relative = workspace.relative(&path, false).with_context(|| format!("Referencia inválida: {path}"))?;
            let full = workspace.existing(&relative).with_context(|| format!("No se pudo resolver la referencia: {path}"))?;
            if !full.is_file() {
                bail!("La referencia no es un archivo: {path}");
            }
            let name = relative.file_name().and_then(|n| n.to_str()).context("Nombre de archivo inválido")?;
            Ok(serde_json::json!({ "path": slash(&relative), "name": name, "image": false, "projectReference": true }))
        }).collect()
    }

    pub fn read_if_changed(&self, path: &str, previous: Option<&str>) -> Result<Option<Document>> {
        let relative = self.relative(path, true)?;
        let path = self.existing(&relative)?;
        if !fs::metadata(&path)?.is_file() {
            bail!("La ruta no corresponde a un archivo regular");
        }
        let mut file = File::open(&path)?;
        // En Windows valida la ruta final del descriptor, también si cambió un enlace al abrir.
        #[cfg(windows)]
        self.check_handle(&file)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            bail!("La ruta no corresponde a un archivo regular");
        }
        let size = meta.len();
        let revision = meta.modified().ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| format!("{size}:{}", time.as_nanos()));
        if previous.is_some() && revision.as_deref() == previous {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file).take(MAX_FILE as u64).read_to_end(&mut bytes)?;
        let binary = bytes.iter().take(8192).any(|&b| b == 0);
        let content = if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() };
        Ok(Some(Document { path, relative: slash(&relative), revision, size, truncated: size > MAX_FILE as u64, binary, content }))
    }

    #[cfg(windows)]
    fn check_handle(&self, file: &File) -> Result<()> {
        use std::{ffi::OsString, os::windows::{ffi::OsStringExt, io::AsRawHandle}};
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFinalPathNameByHandleW(file: *mut std::ffi::c_void, output: *mut u16, len: u32, flags: u32) -> u32;
        }
        let mut output = vec![0; 32_768];
        let len = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), output.as_mut_ptr(), output.len() as u32, 0) } as usize;
        if len == 0 || len >= output.len() {
            bail!("No se pudo verificar la ruta abierta");
        }
        let path = PathBuf::from(OsString::from_wide(&output[..len]));
        let relative = path.strip_prefix(&self.0).context("La ruta está fuera del proyecto")?;
        self.relative(&slash(relative), false)?;
        Ok(())
    }

    fn children(&self, relative: &Path, remaining: &mut usize, limit: usize) -> Result<Listing> {
        let dir = self.existing(relative)?;
        let mut entries = Vec::new();
        for child in fs::read_dir(dir).context("No se pudo listar la carpeta")? {
            if *remaining == 0 || entries.len() == limit {
                return Ok(Listing { entries, limited: true });
            }
            *remaining -= 1;
            let Ok(child) = child else { continue };
            let Ok(name) = child.file_name().into_string() else { continue };
            let path = relative.join(&name);
            let Ok(meta) = fs::symlink_metadata(child.path()) else { continue };
            if linked(&meta) || (!meta.is_dir() && !meta.is_file()) || self.relative(&slash(&path), false).is_err() {
                continue;
            }
            entries.push(Entry { path: slash(&path), name, directory: meta.is_dir() });
        }
        Ok(Listing { entries, limited: false })
    }

    pub fn list(&self, path: &str) -> Result<Listing> {
        let mut result = self.children(&self.relative(path, false)?, &mut (MAX_ENTRIES * 2), MAX_ENTRIES)?;
        result.entries.sort_by_cached_key(|e| (!e.directory, e.name.to_lowercase()));
        Ok(result)
    }

    pub fn catalog(&self) -> Result<Listing> {
        let mut queue = VecDeque::from([String::new()]);
        let mut entries = Vec::new();
        let mut remaining = SCAN_BUDGET;
        let mut limited = false;
        while let Some(dir) = queue.pop_front() {
            let result = match self.children(Path::new(&dir), &mut remaining, MAX_ENTRIES) {
                Ok(result) => result,
                Err(error) if dir.is_empty() => return Err(error),
                Err(_) => continue,
            };
            limited |= result.limited;
            for entry in result.entries {
                if entry.directory {
                    if !IGNORED.iter().any(|name| entry.name.eq_ignore_ascii_case(name)) {
                        queue.push_back(entry.path);
                    }
                } else {
                    entries.push(entry);
                }
            }
            if remaining == 0 {
                limited = true;
                break;
            }
        }
        Ok(Listing { entries, limited })
    }

    async fn command(&self, config: &[String], args: &[&str], limit: usize) -> Result<GitOutput> {
        #[cfg(windows)]
        let exe = which::which("git.exe").context("No se encontró Git en PATH")?;
        #[cfg(not(windows))]
        let exe = which::which("git").context("No se encontró Git en PATH")?;
        let mut command = crate::util::hidden_command(&exe);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command.current_dir(&self.0)
            .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1").env("LC_ALL", "C")
            .args(["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false",
                "-c", "core.untrackedCache=false", "-c", "diff.ignoreSubmodules=all", "-c", "protocol.allow=never"])
            .args(config).args(args)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().context("No se pudo iniciar Git")?;
        let mut stdout = child.stdout.take().unwrap().take((limit + 1) as u64);
        let mut stderr = child.stderr.take().unwrap().take(8192);
        let mut data = Vec::new();
        let mut errors = Vec::new();
        let status = tokio::time::timeout(Duration::from_secs(8), async {
            let read = tokio::try_join!(
                async {
                    if stdout.read_to_end(&mut data).await? > limit {
                        return Err(std::io::Error::other("Límite de salida"));
                    }
                    Ok::<_, std::io::Error>(())
                },
                async {
                    if stderr.read_to_end(&mut errors).await? >= 8192 {
                        return Err(std::io::Error::other("Límite de errores"));
                    }
                    Ok::<_, std::io::Error>(())
                }
            );
            if data.len() > limit || errors.len() >= 8192 {
                child.kill().await?;
                return Ok::<_, std::io::Error>(None);
            }
            read?;
            Ok(Some(child.wait().await?))
        }).await.context("Git tardó demasiado")??;
        let limited = data.len() > limit;
        if status.is_none() && !limited {
            bail!("La salida de error de Git supera el límite");
        }
        data.truncate(limit);
        Ok(GitOutput { code: status.and_then(|s| s.code()), data, limited, error: String::from_utf8_lossy(&errors).trim().to_owned() })
    }

    async fn filters(&self) -> Result<Vec<String>> {
        let out = self.command(&[], &["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|smudge|process|required)$"], 32_768).await?;
        if !matches!(out.code, Some(0 | 1)) || out.limited {
            bail!("No se pudo validar la configuración de filtros Git: {}", out.error);
        }
        Ok(std::str::from_utf8(&out.data)?.split_terminator('\0').flat_map(|key| {
            ["-c".to_owned(), format!("{key}={}", if key.ends_with(".required") { "false" } else { "" })]
        }).collect())
    }

    pub async fn git_status(&self) -> Result<GitStatus> {
        let prefix = self.command(&[], &["rev-parse", "--show-prefix"], 8192).await?;
        if prefix.error.contains("not a git repository") {
            return Ok(GitStatus { repository: false, branch: String::new(), entries: Vec::new(), limited: false, initial: false });
        }
        let prefix = prefix.checked()?;
        let prefix = std::str::from_utf8(&prefix.data)?.trim_end_matches(['\r', '\n']);
        let filters = self.filters().await?;
        let output = self.command(&filters, &["status", "--porcelain=v2", "-z", "--branch", "--no-renames",
            "--ignore-submodules=all", "--untracked-files=all", "--", "."], MAX_DIFF).await?.checked()?;
        let mut result = GitStatus { repository: true, branch: "HEAD separado".into(), entries: Vec::new(), limited: output.limited, initial: false };
        for row in output.data.split_inclusive(|&c| c == 0) {
            let Some(row) = row.strip_suffix(&[0]) else { break };
            let Ok(row) = std::str::from_utf8(row) else {
                result.limited = true;
                continue;
            };
            if let Some(branch) = row.strip_prefix("# branch.head ") {
                if branch != "(detached)" { result.branch = branch.to_owned(); }
            } else if row == "# branch.oid (initial)" {
                result.initial = true;
            } else if let Some((xy, path)) = status_row(row) {
                let Some(path) = path.strip_prefix(prefix) else { continue };
                if self.relative(path, false).is_err() {
                    result.limited = true;
                    continue;
                }
                if result.entries.len() == MAX_ENTRIES {
                    result.limited = true;
                    break;
                }
                result.entries.push(GitEntry { path: path.into(), index: xy[..1].into(), worktree: xy[1..].into() });
            }
        }
        Ok(result)
    }

    pub async fn git_diff(&self, path: &str, scope: DiffScope) -> Result<GitDiff> {
        let relative = self.relative(path, false)?;
        if relative.as_os_str().is_empty() {
            bail!("Selecciona un archivo");
        }
        self.resolve(&relative, true)?;
        let filters = self.filters().await?;
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
            "--ignore-submodules=all", "--relative", "--no-prefix"];
        if matches!(scope, DiffScope::Staged) {
            args.push("--cached");
        }
        let path = slash(&relative);
        if matches!(scope, DiffScope::Untracked) {
            let status = self.command(&filters, &["status", "--short", "-z", "--no-renames",
                "--ignore-submodules=all", "--untracked-files=all", "--", &path], 32_768).await?.checked()?;
            if !status.data.starts_with(b"?? ") {
                bail!("El archivo ya no está sin seguimiento. Actualiza Git");
            }
            // El lector de archivos valida la ruta y acota la lectura también para archivos nuevos.
            let document = self.read_if_changed(&path, None)?.context("Archivo nuevo no disponible")?;
            let limit = MAX_DIFF.min(document.content.len());
            let end = document.content.floor_char_boundary(limit);
            let preview = &document.content[..end];
            let end = preview.match_indices('\n').nth(MAX_NEW_DIFF_LINES - 1).map_or(end, |(offset, _)| offset + 1);
            let content = &preview[..end];
            let mut patch = if document.binary { "Archivo nuevo binario".into() } else {
                format!("--- /dev/null\n+++ {}\n@@ -0,0 +1,{} @@\n", document.relative, content.lines().count())
            };
            if !document.binary {
                for line in content.lines() {
                    patch.push('+');
                    patch.push_str(line);
                    patch.push('\n');
                }
                if !content.is_empty() && !content.ends_with('\n') && !document.truncated && end == document.content.len() {
                    patch.push_str("\\ No hay salto de línea al final del archivo\n");
                }
            }
            return Ok(GitDiff { diff: patch, limited: document.truncated || end < document.content.len() });
        }
        args.extend(["--", &path]);
        let out = self.command(&filters, &args, MAX_DIFF).await?.checked()?;
        Ok(GitDiff { diff: String::from_utf8_lossy(&out.data).into_owned(), limited: out.limited })
    }
}

struct GitOutput {
    code: Option<i32>,
    data: Vec<u8>,
    limited: bool,
    error: String,
}

impl GitOutput {
    fn checked(self) -> Result<Self> {
        if self.code != Some(0) && !self.limited {
            bail!("Git: {}", if self.error.is_empty() { "la consulta falló" } else { &self.error });
        }
        Ok(self)
    }
}

fn status_row(row: &str) -> Option<(&str, &str)> {
    if let Some(path) = row.strip_prefix("? ") { return Some((".?", path)); }
    let fields = if row.starts_with("1 ") { 9 } else if row.starts_with("u ") { 11 } else { return None };
    let mut fields = row.splitn(fields, ' ');
    let xy = fields.nth(1)?;
    let path = fields.last()?;
    (xy.len() == 2 && xy.is_ascii()).then_some((xy, path))
}

#[derive(Serialize)]
pub struct GitStatus {
    repository: bool,
    branch: String,
    entries: Vec<GitEntry>,
    limited: bool,
    initial: bool,
}

#[derive(Serialize)]
pub struct GitEntry {
    path: String,
    index: String,
    worktree: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Serialize)]
pub struct GitDiff {
    diff: String,
    limited: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("duovra-workspace-{}", crate::util::new_id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn workspace(&self) -> Workspace {
            Workspace::open(self.0.to_str().unwrap()).unwrap()
        }

        fn git(&self, args: &[&str]) {
            let output = Command::new("git").current_dir(&self.0).args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn directorios_archivos_y_limites() {
        let fixture = Fixture::new();
        let ws = fixture.workspace();
        assert!(ws.list("").unwrap().entries.is_empty());
        fs::create_dir_all(fixture.0.join("src/lib")).unwrap();
        fs::write(fixture.0.join("src/lib/sample.ts"), "const sample = true;").unwrap();
        fs::write(fixture.0.join("large.txt"), vec![b'X'; MAX_FILE + 1]).unwrap();
        assert_eq!(ws.list("src").unwrap().entries[0].path, "src/lib");
        assert_eq!(ws.catalog().unwrap().entries.len(), 2);
        let doc = ws.read_if_changed("./src/lib/sample.ts", None).unwrap().unwrap();
        assert!(doc.content.contains("sample"));
        let absolute = fixture.0.join("src/lib/sample.ts");
        assert!(ws.read_if_changed(absolute.to_str().unwrap(), None).unwrap().is_some());
        assert!(ws.read_if_changed("src/lib/sample.ts", doc.revision.as_deref()).unwrap().is_none());
        assert!(ws.read_if_changed("large.txt", None).unwrap().unwrap().truncated);
        assert!(ws.read_if_changed("missing.ts", None).is_err());
        assert!(ws.read_if_changed("../outside.txt", None).is_err());
        assert!(ws.read_if_changed(".git/config", None).is_err());
        assert!(ws.list("../").is_err());
        let outside = Fixture::new();
        let file = outside.0.join("outside.txt");
        fs::write(&file, "outside").unwrap();
        assert!(ws.read_if_changed(file.to_str().unwrap(), None).is_err());
    }

    #[test]
    fn menciones_solo_resuelven_archivos_del_proyecto() {
        let fixture = Fixture::new();
        let root = fixture.0.to_str().unwrap();
        fs::write(fixture.0.join("a b.ts"), vec![b'x'; MAX_FILE + 1]).unwrap();
        let mentions = Workspace::references(root, r#"Revisa @"a b.ts" y @"a b.ts"."#).unwrap();
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["path"], "a b.ts");
        assert_eq!(mentions[0]["image"], false);
        assert!(Workspace::references(root, r#"@"../outside.ts""#).is_err());
        assert!(Workspace::references(root, r#"@"missing.ts""#).is_err());
        assert!(Workspace::references(root, r#"Escribe \@"missing.ts""#).unwrap().is_empty());
    }

    #[tokio::test]
    async fn git_real_estado_y_diffs_por_ambito() {
        let fixture = Fixture::new();
        let ws = fixture.workspace();
        assert!(!ws.git_status().await.unwrap().repository);
        fixture.git(&["init", "-b", "qa"]);
        assert!(ws.git_status().await.unwrap().initial);
        fs::create_dir(fixture.0.join("src")).unwrap();
        let path = fixture.0.join("src/a path.ts");
        fs::write(&path, "first\nsecond\nthird\n").unwrap();
        fs::write(fixture.0.join("deleted.txt"), "gone\n").unwrap();
        fixture.git(&["add", "."]);
        fixture.git(&["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=.git/disabled", "commit", "-m", "Fixture"]);
        assert!(ws.git_status().await.unwrap().entries.is_empty());
        fs::write(&path, "first\nstaged\nthird\n").unwrap();
        fixture.git(&["add", "src/a path.ts"]);
        fs::write(&path, "unstaged\nstaged\nlast\n").unwrap();
        fs::write(fixture.0.join("new.txt"), "actual\n").unwrap();
        fs::remove_file(fixture.0.join("deleted.txt")).unwrap();
        let index = fs::read(fixture.0.join(".git/index")).unwrap();
        let state = ws.git_status().await.unwrap();
        assert_eq!(state.branch, "qa");
        assert!(state.entries.iter().any(|e| e.path == "src/a path.ts" && e.index == "M" && e.worktree == "M"));
        assert!(state.entries.iter().any(|e| e.path == "deleted.txt" && e.worktree == "D"));
        assert!(state.entries.iter().any(|e| e.path == "new.txt" && e.worktree == "?"));
        let subdir = Workspace::open(fixture.0.join("src").to_str().unwrap()).unwrap();
        assert_eq!(subdir.git_status().await.unwrap().entries[0].path, "a path.ts");
        assert!(subdir.git_diff("a path.ts", DiffScope::Unstaged).await.unwrap().diff.contains("+unstaged"));
        let staged = ws.git_diff("src/a path.ts", DiffScope::Staged).await.unwrap().diff;
        assert!(staged.contains("+staged") && !staged.contains("+unstaged"));
        let unstaged = ws.git_diff("src/a path.ts", DiffScope::Unstaged).await.unwrap().diff;
        assert!(unstaged.contains("+unstaged") && unstaged.contains("+last"));
        assert!(ws.git_diff("new.txt", DiffScope::Untracked).await.unwrap().diff.contains("+actual"));
        assert!(ws.git_diff("../new.txt", DiffScope::Unstaged).await.is_err());
        assert_eq!(fs::read(fixture.0.join(".git/index")).unwrap(), index);
    }
}
