//! Git worktrees (1.0.9): espacios de trabajo independientes de un mismo repositorio.
//!
//! Se usa Git real (`git worktree add/list/remove/repair`): los worktrees comparten los objetos
//! del repositorio, así que no se copia el historial. Duovra nunca ejecuta instaladores, no copia
//! `.env` ni secretos, no cambia la rama del directorio principal y no usa `--force`,
//! `reset --hard` ni limpiezas destructivas. Fusionar, rebasar o hacer commit sigue siendo cosa
//! del usuario o del agente que él elija.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

pub struct GitOut {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl GitOut {
    fn ok(self) -> Result<String> {
        if self.code == Some(0) {
            Ok(self.stdout)
        } else {
            bail!("{}", if self.stderr.is_empty() { "Git devolvió un error".to_owned() } else { self.stderr })
        }
    }
}

fn git_exe() -> Result<PathBuf> {
    #[cfg(windows)]
    return which::which("git.exe").context("No se encontró Git. Instálalo y vuelve a intentarlo.");
    #[cfg(not(windows))]
    return which::which("git").context("No se encontró Git. Instálalo y vuelve a intentarlo.");
}

/// Ejecuta Git sin heredar variables `GIT_*`, sin preguntas interactivas y con límite de tiempo.
pub async fn git(dir: &Path, args: &[&str], timeout: Duration) -> Result<GitOut> {
    let exe = git_exe()?;
    let mut command = crate::util::hidden_command(&exe);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C")
        .args(["--no-pager", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"])
        .args(args)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().context("No se pudo iniciar Git")?;
    let mut stdout = child.stdout.take().unwrap().take(OUTPUT_LIMIT as u64);
    let mut stderr = child.stderr.take().unwrap().take(64 * 1024);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let status = tokio::time::timeout(timeout, async {
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        child.wait().await
    }).await.map_err(|_| anyhow!("Git tardó demasiado en responder"))??;
    Ok(GitOut {
        code: status.code(),
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).trim().to_owned(),
    })
}

const QUICK: Duration = Duration::from_secs(15);

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    git(dir, args, QUICK).await?.ok()
}

/// Un worktree tal y como lo describe `git worktree list --porcelain`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

pub fn parse_worktree_list(text: &str) -> Vec<GitWorktree> {
    let mut list = Vec::new();
    for block in text.split("\n\n") {
        let mut wt = GitWorktree { path: String::new(), head: None, branch: None, detached: false, bare: false, locked: false, prunable: false };
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => wt.path = normalize(value),
                "HEAD" => wt.head = Some(value.to_owned()),
                "branch" => wt.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
                "detached" => wt.detached = true,
                "bare" => wt.bare = true,
                "locked" => wt.locked = true,
                "prunable" => wt.prunable = true,
                _ => {}
            }
        }
        if !wt.path.is_empty() {
            list.push(wt);
        }
    }
    list
}

/// Rutas con separadores del sistema y sin barra final, para comparar las que devuelve Git.
fn normalize(path: &str) -> String {
    let p = path.trim().trim_end_matches(['/', '\\']);
    #[cfg(windows)]
    return p.replace('/', "\\");
    #[cfg(not(windows))]
    p.to_owned()
}

pub fn same_path(a: &str, b: &str) -> bool {
    let eq = |a: &str, b: &str| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
    let (na, nb) = (normalize(a), normalize(b));
    if eq(&na, &nb) {
        return true;
    }
    // Rutas que existen escritas de otra forma: nombres cortos 8.3 de Windows (`RUNNER~1`),
    // enlaces o `..`. Git siempre informa la ruta larga.
    match (std::fs::canonicalize(&na), std::fs::canonicalize(&nb)) {
        (Ok(ca), Ok(cb)) => eq(&normalize(&ca.to_string_lossy()), &normalize(&cb.to_string_lossy())),
        _ => false,
    }
}

/// Repositorio del proyecto: raíz del directorio principal (no la de un worktree enlazado).
pub struct Repo {
    /// Directorio de trabajo principal.
    pub main: PathBuf,
    /// Rama actual del directorio principal (si no está separada).
    pub branch: Option<String>,
}

pub async fn repo_of(project_path: &str) -> Result<Repo> {
    let dir = Path::new(project_path);
    if !dir.is_dir() {
        bail!("La carpeta del proyecto no existe.");
    }
    let common = git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"], QUICK).await?;
    if common.code != Some(0) {
        bail!("Este proyecto no es un repositorio Git.");
    }
    let common = PathBuf::from(normalize(common.stdout.trim()));
    let list = parse_worktree_list(&git_ok(dir, &["worktree", "list", "--porcelain"]).await?);
    let main = list.first().filter(|w| !w.bare).map(|w| PathBuf::from(&w.path))
        .or_else(|| common.parent().map(Path::to_path_buf))
        .ok_or_else(|| anyhow!("No se pudo localizar el directorio principal del repositorio."))?;
    let branch = list.first().and_then(|w| w.branch.clone());
    Ok(Repo { main, branch })
}

pub async fn list(repo: &Repo) -> Result<Vec<GitWorktree>> {
    Ok(parse_worktree_list(&git_ok(&repo.main, &["worktree", "list", "--porcelain"]).await?))
}

/// Carpeta base de los worktrees de Duovra: junto al repositorio (`<repo>.worktrees`), fuera de su
/// árbol de archivos para no anidar repositorios. Con una ubicación configurada, `<ubicación>/<repo>`.
pub fn base_dir(repo: &Repo, configured: Option<&str>) -> PathBuf {
    let name = repo.main.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => Path::new(dir).join(&name),
        None => repo.main.parent().unwrap_or(&repo.main).join(format!("{name}.worktrees")),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub name: String,
    pub path: String,
    /// `true`: crea `branch` desde `base`. `false`: usa la rama existente `branch`.
    pub new_branch: bool,
    pub branch: String,
    pub base: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub git_version: Option<String>,
    pub main_path: String,
    pub main_branch: Option<String>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    /// Ramas ya en uso por otro worktree (Git no permite usarlas dos veces).
    pub busy_branches: Vec<String>,
    pub base_dir: String,
    pub suggested_name: String,
    pub suggested_branch: String,
    pub suggested_path: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub free_bytes: Option<u64>,
    pub estimated_bytes: Option<u64>,
    /// El directorio principal tiene cambios sin commit (no viajan al nuevo worktree).
    pub main_dirty: bool,
}

async fn branches(repo: &Repo) -> Result<(Vec<String>, Vec<String>)> {
    let out = git_ok(&repo.main, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).await?;
    let (mut local, mut remote) = (Vec::new(), Vec::new());
    for line in out.lines() {
        if let Some(b) = line.strip_prefix("refs/heads/") {
            local.push(b.to_owned());
        } else if let Some(b) = line.strip_prefix("refs/remotes/") {
            if !b.ends_with("/HEAD") {
                remote.push(b.to_owned());
            }
        }
    }
    Ok((local, remote))
}

/// Comprobaciones previas a crear un worktree. Sin `req` solo propone nombre, rama y ruta.
pub async fn preflight(repo: &Repo, configured: Option<&str>, req: Option<&CreateRequest>) -> Result<Preflight> {
    let mut p = Preflight {
        main_path: repo.main.to_string_lossy().into_owned(),
        main_branch: repo.branch.clone(),
        ..Default::default()
    };
    p.git_version = git_ok(&repo.main, &["--version"]).await.ok().map(|v| v.trim().to_owned());
    let (local, remote) = branches(repo).await?;
    p.local_branches = local.clone();
    p.remote_branches = remote;
    let worktrees = list(repo).await?;
    p.busy_branches = worktrees.iter().filter_map(|w| w.branch.clone()).collect();
    let base = base_dir(repo, configured);
    p.base_dir = base.to_string_lossy().into_owned();
    let mut n = 1;
    let (name, branch, path) = loop {
        let name = if n == 1 { "nuevo-espacio".to_owned() } else { format!("nuevo-espacio-{n}") };
        let path = base.join(&name);
        if !local.contains(&name) && !path.exists() {
            break (name.clone(), name, path);
        }
        n += 1;
    };
    p.suggested_name = name;
    p.suggested_branch = branch;
    p.suggested_path = path.to_string_lossy().into_owned();
    p.main_dirty = !git_ok(&repo.main, &["status", "--porcelain", "--untracked-files=no"]).await.unwrap_or_default().trim().is_empty();

    if let Some(req) = req {
        let target = PathBuf::from(req.path.trim());
        if req.name.trim().is_empty() {
            p.errors.push("Escribe un nombre para el worktree.".into());
        }
        let branch = req.branch.trim();
        if branch.is_empty() {
            p.errors.push("Indica una rama.".into());
        } else if git(&repo.main, &["check-ref-format", "--branch", branch], QUICK).await?.code != Some(0) {
            p.errors.push(format!("«{branch}» no es un nombre de rama válido."));
        }
        if req.new_branch {
            if local.iter().any(|b| b == branch) {
                p.errors.push(format!("La rama «{branch}» ya existe. Elige otro nombre o usa la rama existente."));
            }
            let base_ref = req.base.as_deref().unwrap_or("HEAD");
            if git(&repo.main, &["rev-parse", "--verify", "--quiet", &format!("{base_ref}^{{commit}}")], QUICK).await?.code != Some(0) {
                p.errors.push(format!("La referencia base «{base_ref}» no existe."));
            } else if let Some(size) = tree_size(repo, base_ref).await {
                p.estimated_bytes = Some(size);
            }
        } else if !local.iter().any(|b| b == branch) {
            p.errors.push(format!("La rama «{branch}» no existe en este repositorio."));
        } else if worktrees.iter().any(|w| w.branch.as_deref() == Some(branch)) {
            p.errors.push(format!("La rama «{branch}» ya está en uso en otro worktree o en el directorio principal."));
        } else {
            p.estimated_bytes = tree_size(repo, branch).await;
        }
        if !target.is_absolute() {
            p.errors.push("La ubicación debe ser una ruta completa.".into());
        } else {
            if worktrees.iter().any(|w| same_path(&w.path, &req.path)) {
                p.errors.push("Ya hay un worktree en esa ubicación.".into());
            }
            if target.exists() && std::fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(true) {
                p.errors.push("La carpeta de destino ya existe y no está vacía.".into());
            }
            if target.starts_with(&repo.main) {
                p.warnings.push("La ubicación está dentro del repositorio: Git y las herramientas pueden verla como archivos anidados.".into());
            }
            match nearest_existing(&target) {
                Some(dir) => {
                    if !writable(&dir) {
                        p.errors.push(format!("No hay permiso de escritura en {}.", dir.display()));
                    }
                    p.free_bytes = free_space(&dir);
                }
                None => p.errors.push("La unidad de destino no está disponible.".into()),
            }
            if let (Some(free), Some(needed)) = (p.free_bytes, p.estimated_bytes) {
                if needed.saturating_mul(11) / 10 > free {
                    p.errors.push("No hay espacio libre suficiente en la unidad de destino.".into());
                }
            }
        }
    }
    Ok(p)
}

/// Tamaño de los archivos versionados de una referencia (lo que ocupará la copia de trabajo).
async fn tree_size(repo: &Repo, reference: &str) -> Option<u64> {
    let out = git(&repo.main, &["ls-tree", "-r", "-l", "--full-tree", reference], QUICK).await.ok()?;
    if out.code != Some(0) {
        return None;
    }
    Some(out.stdout.lines().filter_map(|line| line.split_whitespace().nth(3)?.parse::<u64>().ok()).sum())
}

fn nearest_existing(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf)
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".duovra-write-{}", crate::util::new_id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, free: *mut u64, total: *mut u64, total_free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
    // SAFETY: cadena terminada en nulo y punteros a variables locales válidas.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// Crea el worktree con `git worktree add`. No cambia la rama del directorio principal, no copia
/// cambios locales, `.env` ni dependencias y no ejecuta instaladores.
pub async fn create(repo: &Repo, req: &CreateRequest) -> Result<()> {
    let path = req.path.trim();
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).context("No se pudo crear la carpeta de worktrees")?;
    }
    let branch = req.branch.trim();
    let base = req.base.as_deref().unwrap_or("HEAD");
    let args: Vec<&str> = if req.new_branch {
        vec!["worktree", "add", "-b", branch, path, base]
    } else {
        vec!["worktree", "add", path, branch]
    };
    git(&repo.main, &args, Duration::from_secs(300)).await?.ok()
        .map_err(|e| anyhow!("Git no pudo crear el worktree: {e}"))?;
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub exists: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    /// Archivos con cambios (indexados o no), sin contar los no seguidos.
    pub changed: usize,
    pub untracked: usize,
    pub conflicted: usize,
    /// Primeras rutas con cambios, para el resumen de integración.
    pub files: Vec<String>,
}

pub async fn status(path: &str) -> Result<Status> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Ok(Status::default());
    }
    let out = git_ok(dir, &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).await?;
    let mut s = Status { exists: true, ..Default::default() };
    for record in out.split('\0') {
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            s.branch = (rest != "(detached)").then(|| rest.to_owned());
        } else if let Some(rest) = record.strip_prefix("# branch.oid ") {
            s.head = Some(rest.to_owned());
        } else if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            s.upstream = Some(rest.to_owned());
        } else if let Some(rest) = record.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            s.ahead = parts.next().and_then(|v| v.trim_start_matches('+').parse().ok()).unwrap_or(0);
            s.behind = parts.next().and_then(|v| v.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(rest) = record.strip_prefix("? ") {
            s.untracked += 1;
            if s.files.len() < 40 { s.files.push(rest.to_owned()); }
        } else if record.starts_with("u ") {
            s.conflicted += 1;
            s.changed += 1;
            if s.files.len() < 40 { s.files.push(record.rsplit(' ').next().unwrap_or_default().to_owned()); }
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            s.changed += 1;
            if s.files.len() < 40 { s.files.push(record.splitn(9, ' ').nth(8).unwrap_or_default().to_owned()); }
        }
    }
    Ok(s)
}

/// Espacio ocupado por la carpeta del worktree (bajo demanda; con presupuesto de tiempo).
pub fn disk_usage(path: &str) -> Result<(u64, bool)> {
    let started = Instant::now();
    let mut total = 0u64;
    let mut stack = vec![PathBuf::from(path)];
    while let Some(dir) = stack.pop() {
        if started.elapsed() > Duration::from_secs(20) {
            return Ok((total, true));
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 { continue; }
                }
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok((total, false))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalCheck {
    pub exists: bool,
    pub branch: Option<String>,
    /// La carpeta se puede eliminar sin perder información.
    pub can_remove_dir: bool,
    /// Motivos que bloquean la eliminación de la carpeta.
    pub blockers: Vec<String>,
    /// Avisos que no bloquean (p. ej. dependencias regenerables que se borrarán).
    pub warnings: Vec<String>,
    /// La rama se puede borrar con `git branch -d` (sin trabajo exclusivo).
    pub can_delete_branch: bool,
    pub branch_note: Option<String>,
    pub exclusive_commits: i64,
    pub conversations: i64,
}

/// Archivos ignorados que no se pueden regenerar y suelen contener datos o secretos.
fn important_ignored(path: &str) -> bool {
    let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    name.starts_with(".env") || name.starts_with("id_rsa") || name.starts_with("id_ed25519")
        || name.contains("secret") || name.contains("credential")
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".sqlite", ".sqlite3", ".db", ".kdbx"].iter().any(|ext| name.ends_with(ext))
}

/// Carpetas ignoradas que se regeneran (dependencias, compilaciones, cachés).
fn regenerable(path: &str) -> bool {
    let first = path.split('/').find(|s| !s.is_empty()).unwrap_or(path);
    ["node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv",
        "__pycache__", "coverage", ".parcel-cache", ".svelte-kit", ".vite", ".pytest_cache", ".gradle", "bin", "obj"]
        .contains(&first.trim_end_matches('/'))
}

pub async fn removal_check(repo: &Repo, path: &str, branch: Option<&str>, usage: (i64, i64, i64), running: bool) -> Result<RemovalCheck> {
    let (conversations, queued, running_db) = usage;
    let mut check = RemovalCheck { conversations, branch: branch.map(str::to_owned), ..Default::default() };
    let dir = Path::new(path);
    check.exists = dir.is_dir();
    if running || running_db > 0 {
        check.blockers.push("Hay un agente trabajando en este worktree. Detén la ejecución antes de eliminarlo.".into());
    }
    if queued > 0 {
        check.blockers.push(format!("Hay {queued} mensaje(s) en cola para este worktree. Retíralos o espera a que terminen."));
    }
    if same_path(path, &repo.main.to_string_lossy()) {
        check.blockers.push("Es el directorio principal del repositorio: no se puede eliminar desde aquí.".into());
    }
    if check.exists {
        let st = status(path).await?;
        if st.changed > 0 {
            check.blockers.push(format!("Tiene {} archivo(s) con cambios sin commit.", st.changed));
        }
        if st.untracked > 0 {
            check.blockers.push(format!("Tiene {} archivo(s) sin seguimiento que se perderían.", st.untracked));
        }
        let ignored = git_ok(dir, &["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"]).await?;
        let ignored: Vec<&str> = ignored.split('\0').filter_map(|r| r.strip_prefix("!! ")).collect();
        let important: Vec<&str> = ignored.iter().copied().filter(|p| important_ignored(p)).collect();
        if !important.is_empty() {
            check.blockers.push(format!("Contiene archivos ignorados que pueden ser importantes: {}.", important.iter().take(5).copied().collect::<Vec<_>>().join(", ")));
        }
        let regen: Vec<&str> = ignored.iter().copied().filter(|p| regenerable(p)).collect();
        let other: Vec<&str> = ignored.iter().copied().filter(|p| !regenerable(p) && !important_ignored(p)).collect();
        if !regen.is_empty() {
            check.warnings.push(format!("Se borrarán dependencias o compilaciones regenerables: {}.", regen.iter().take(4).copied().collect::<Vec<_>>().join(", ")));
        }
        if !other.is_empty() {
            check.blockers.push(format!("Contiene archivos ignorados que no se pueden recuperar con Git: {}.", other.iter().take(5).copied().collect::<Vec<_>>().join(", ")));
        }
        let listed = list(repo).await?;
        if listed.iter().any(|w| same_path(&w.path, path) && w.locked) {
            check.blockers.push("Git tiene este worktree bloqueado (git worktree lock).".into());
        }
    }
    check.can_remove_dir = check.blockers.is_empty() && check.exists;

    // Rama: solo se puede borrar si su trabajo está en otra rama o en un remoto.
    if let Some(branch) = branch {
        let exists = git(&repo.main, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], QUICK).await?.code == Some(0);
        if !exists {
            check.branch_note = Some(format!("La rama «{branch}» ya no existe."));
        } else if repo.branch.as_deref() == Some(branch) {
            check.branch_note = Some("Es la rama del directorio principal.".into());
        } else {
            let exclude = format!("--exclude={branch}");
            let count = git_ok(&repo.main, &["rev-list", "--count", &format!("refs/heads/{branch}"), "--not", &exclude, "--branches", "--remotes"]).await?;
            check.exclusive_commits = count.trim().parse().unwrap_or(0);
            if check.exclusive_commits > 0 {
                check.branch_note = Some(format!("La rama tiene {} commit(s) que no están en ninguna otra rama: se conservará.", check.exclusive_commits));
            } else {
                check.can_delete_branch = true;
            }
        }
    }
    Ok(check)
}

/// `git worktree remove` sin `--force`: Git vuelve a negarse si hay cambios o archivos sin seguimiento.
pub async fn remove_dir(repo: &Repo, path: &str) -> Result<()> {
    git(&repo.main, &["worktree", "remove", path], Duration::from_secs(120)).await?.ok()
        .map_err(|e| anyhow!("Git no eliminó el worktree: {e}"))?;
    Ok(())
}

/// `git branch -d` (nunca `-D`): Git se niega si la rama no está integrada.
pub async fn delete_branch(repo: &Repo, branch: &str) -> Result<()> {
    git_ok(&repo.main, &["branch", "-d", branch]).await.map_err(|e| anyhow!("Git no borró la rama: {e}"))?;
    Ok(())
}

/// Vuelve a enlazar un worktree movido fuera de Duovra (`git worktree repair <ruta>`).
pub async fn repair(repo: &Repo, new_path: &str) -> Result<Option<String>> {
    git_ok(&repo.main, &["worktree", "repair", new_path]).await.map_err(|e| anyhow!("Git no pudo reparar el worktree: {e}"))?;
    let listed = list(repo).await?;
    let found = listed.iter().find(|w| same_path(&w.path, new_path))
        .ok_or_else(|| anyhow!("Esa carpeta no es un worktree de este repositorio."))?;
    Ok(found.branch.clone())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub source: Option<String>,
    pub target: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub changed: usize,
    pub untracked: usize,
    pub files: Vec<String>,
    /// Archivos que chocarían al fusionar (simulación de `git merge-tree`, sin tocar nada).
    pub conflicts: Vec<String>,
    pub conflicts_checked: bool,
}

pub async fn integration(repo: &Repo, path: &str) -> Result<Integration> {
    let st = status(path).await?;
    let mut info = Integration {
        source: st.branch.clone(), target: repo.branch.clone(), changed: st.changed, untracked: st.untracked,
        files: st.files.into_iter().take(25).collect(), ..Default::default()
    };
    if let (Some(source), Some(target)) = (&info.source, &info.target) {
        if let Ok(out) = git_ok(&repo.main, &["rev-list", "--left-right", "--count", &format!("{target}...{source}")]).await {
            let mut parts = out.split_whitespace();
            info.behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            info.ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        }
        // Solo lectura: escribe objetos en la base de Git pero no toca ramas ni directorios.
        if let Ok(out) = git(&repo.main, &["merge-tree", "--write-tree", "--name-only", "--no-messages", target, source], QUICK).await {
            match out.code {
                Some(0) => info.conflicts_checked = true,
                Some(1) => {
                    info.conflicts_checked = true;
                    info.conflicts = out.stdout.lines().skip(1).filter(|l| !l.is_empty()).take(25).map(str::to_owned).collect();
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreta_la_lista_de_worktrees() {
        let text = "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo.worktrees/feat\nHEAD def\nbranch refs/heads/feat\nlocked\n\nworktree C:/x\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n";
        let list = parse_worktree_list(text);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[1].locked);
        assert!(list[2].detached && list[2].prunable && list[2].branch.is_none());
        assert!(same_path("C:/repo.worktrees/feat/", &list[1].path));
    }

    #[test]
    fn clasificacion_de_ignorados() {
        assert!(important_ignored(".env.local"));
        assert!(important_ignored("config/prod.key"));
        assert!(!important_ignored("node_modules/"));
        assert!(regenerable("node_modules/"));
        assert!(regenerable("target/"));
        assert!(!regenerable("notas.txt"));
    }

    /// Repositorio Git real y temporal (nunca un proyecto del usuario).
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("duovra-wt-{}", crate::util::new_id()));
            let repo = root.join("demo");
            std::fs::create_dir_all(&repo).unwrap();
            let s = Self(root);
            s.git(&repo, &["init", "-q", "-b", "main"]);
            std::fs::write(repo.join("README.md"), "demo\n").unwrap();
            std::fs::write(repo.join(".gitignore"), "node_modules/\n.env\n*.log\n").unwrap();
            s.git(&repo, &["add", "."]);
            s.git(&repo, &["commit", "-q", "-m", "inicio"]);
            s
        }
        fn repo(&self) -> PathBuf { self.0.join("demo") }
        fn git(&self, dir: &Path, args: &[&str]) {
            let out = std::process::Command::new("git").current_dir(dir)
                .args(["-c", "user.name=Duovra QA", "-c", "user.email=qa@duovra.invalid", "-c", "commit.gpgsign=false"])
                .args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn request(name: &str, path: &Path, new_branch: bool, branch: &str) -> CreateRequest {
        CreateRequest { name: name.into(), path: path.to_string_lossy().into(), new_branch, branch: branch.into(), base: Some("main".into()) }
    }

    #[tokio::test]
    async fn ciclo_real_de_worktrees_con_git() {
        let sb = Sandbox::new();
        let main = sb.repo();
        let repo = repo_of(&main.to_string_lossy()).await.unwrap();
        assert_eq!(repo.branch.as_deref(), Some("main"));
        let base = base_dir(&repo, None);
        assert!(base.ends_with("demo.worktrees"), "{}", base.display());

        // Cambios sin commit en el principal: no viajan al worktree ni cambian su rama.
        std::fs::write(main.join("README.md"), "demo local\n").unwrap();
        let pf = preflight(&repo, None, None).await.unwrap();
        assert!(pf.main_dirty);
        assert_eq!(pf.suggested_branch, "nuevo-espacio");

        // Dos worktrees: rama nueva y rama existente.
        let a = base.join("pagos");
        let req_a = request("pagos", &a, true, "feat/pagos");
        assert!(preflight(&repo, None, Some(&req_a)).await.unwrap().errors.is_empty());
        create(&repo, &req_a).await.unwrap();
        sb.git(&main, &["branch", "fix/login"]);
        let b = base.join("login");
        let req_b = request("login", &b, false, "fix/login");
        create(&repo, &req_b).await.unwrap();
        assert_eq!(std::fs::read_to_string(a.join("README.md")).unwrap().replace("\r\n", "\n"), "demo\n");
        assert_eq!(repo_of(&main.to_string_lossy()).await.unwrap().branch.as_deref(), Some("main"));
        assert!(!a.join(".env").exists());

        // Conflictos detectados antes de crear.
        let dup = preflight(&repo, None, Some(&request("otra", &base.join("otra"), true, "feat/pagos"))).await.unwrap();
        assert!(dup.errors.iter().any(|e| e.contains("ya existe")));
        let busy = preflight(&repo, None, Some(&request("otra", &base.join("otra"), false, "fix/login"))).await.unwrap();
        assert!(busy.errors.iter().any(|e| e.contains("en uso")));
        let taken = preflight(&repo, None, Some(&request("x", &a, true, "nueva"))).await.unwrap();
        assert!(taken.errors.iter().any(|e| e.contains("Ya hay un worktree")));
        assert!(!preflight(&repo, None, Some(&request("x", &base.join("x"), true, "rama no válida"))).await.unwrap().errors.is_empty());

        // Un tercer worktree creado fuera de Duovra aparece para importarlo.
        let external = sb.0.join("externo");
        sb.git(&main, &["worktree", "add", "-q", "-b", "hotfix", &external.to_string_lossy()]);
        let listed = list(&repo).await.unwrap();
        assert_eq!(listed.len(), 4);
        assert!(listed.iter().any(|w| same_path(&w.path, &external.to_string_lossy()) && w.branch.as_deref() == Some("hotfix")));

        // Estado y eliminación segura.
        std::fs::write(a.join("nuevo.ts"), "x").unwrap();
        std::fs::write(a.join("README.md"), "cambio\n").unwrap();
        let st = status(&a.to_string_lossy()).await.unwrap();
        assert_eq!((st.changed, st.untracked, st.branch.as_deref()), (1, 1, Some("feat/pagos")));
        let check = removal_check(&repo, &a.to_string_lossy(), Some("feat/pagos"), (1, 0, 0), false).await.unwrap();
        assert!(!check.can_remove_dir && check.blockers.len() == 2, "{:?}", check.blockers);
        assert!(check.can_delete_branch, "rama sin commits propios");
        let queued = removal_check(&repo, &b.to_string_lossy(), Some("fix/login"), (1, 1, 0), true).await.unwrap();
        assert!(!queued.can_remove_dir && queued.blockers.len() == 2);

        // Commit exclusivo: la rama no se puede borrar.
        sb.git(&a, &["add", "."]);
        sb.git(&a, &["commit", "-q", "-m", "pagos"]);
        std::fs::write(a.join(".env"), "SECRET=1").unwrap();
        let check = removal_check(&repo, &a.to_string_lossy(), Some("feat/pagos"), (0, 0, 0), false).await.unwrap();
        assert!(!check.can_remove_dir, "un .env ignorado bloquea");
        assert_eq!(check.exclusive_commits, 1);
        assert!(!check.can_delete_branch);
        let info = integration(&repo, &a.to_string_lossy()).await.unwrap();
        assert_eq!((info.ahead, info.behind, info.conflicts_checked), (1, 0, true));
        assert_eq!(info.target.as_deref(), Some("main"));

        // Worktree limpio (con node_modules ignorado): se elimina sin --force y su rama también.
        std::fs::create_dir_all(b.join("node_modules/pkg")).unwrap();
        std::fs::write(b.join("node_modules/pkg/index.js"), "1").unwrap();
        let check = removal_check(&repo, &b.to_string_lossy(), Some("fix/login"), (0, 0, 0), false).await.unwrap();
        assert!(check.can_remove_dir, "{:?}", check.blockers);
        assert!(!check.warnings.is_empty());
        assert!(check.can_delete_branch);
        remove_dir(&repo, &b.to_string_lossy()).await.unwrap();
        delete_branch(&repo, "fix/login").await.unwrap();
        assert!(!b.exists());
        // Git sin --force solo se niega con cambios o archivos sin seguimiento: borraría el .env
        // ignorado. Por eso la comprobación de Duovra (arriba) bloquea antes de llamarlo.
        std::fs::write(a.join("borrador.txt"), "sin seguimiento").unwrap();
        assert!(remove_dir(&repo, &a.to_string_lossy()).await.is_err());
        assert!(a.join(".env").exists() && a.join("borrador.txt").exists());

        // Worktree movido fuera de Duovra: se repara con `git worktree repair`.
        let moved = sb.0.join("externo-movido");
        std::fs::rename(&external, &moved).unwrap();
        assert!(list(&repo).await.unwrap().iter().any(|w| w.prunable));
        assert_eq!(repair(&repo, &moved.to_string_lossy()).await.unwrap().as_deref(), Some("hotfix"));
        let ok = disk_usage(&moved.to_string_lossy()).unwrap();
        assert!(ok.0 > 0 && !ok.1);
    }
}
