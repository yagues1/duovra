//! Copias de seguridad de los datos personales de Duovra y su restauración.
//!
//! Una copia es una base SQLite creada con `VACUUM INTO`: instantánea consistente, también con
//! el WAL activo, nunca una copia de archivos abiertos. Lleva una tabla `duovra_backup` con el
//! formato y se valida (integridad, formato, esquema y tablas) antes de publicarla o usarla.
//!
//! La restauración no sustituye nunca la base mientras Duovra la usa. Se valida y se prepara en
//! `restore/pending.duovra` con los agentes parados y se aplica al iniciar, con el bloqueo de
//! instancia ya tomado y antes de abrir los datos:
//! 1. Se guarda una copia del estado actual en `backups/antes-de-restaurar-*.duovra`.
//! 2. Se aparta la base anterior y la copia validada ocupa su lugar.
//! 3. Si la copia no abre, se devuelve la base anterior. Si no se pudo validar, se rechaza.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::agents::Studio;
use crate::db::Db;
use crate::export::{ensure_extension, utc_stamp};
use crate::util::{new_id, now_ms};

/// Versión de la aplicación que escribe la copia (`CARGO_PKG_VERSION`).
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EXTENSION: &str = "duovra";
const FORMAT: &str = "duovra-backup";
const FORMAT_VERSION: &str = "1";
/// `user_version` más alto que esta compilación entiende (ver `insights::migrate`).
const MAX_SCHEMA_VERSION: i64 = 1;
const REQUIRED_TABLES: [&str; 4] = ["projects", "conversations", "messages", "settings"];
const RESTORE_DIR: &str = "restore";
const BACKUP_DIR: &str = "backups";
const PENDING: &str = "pending.duovra";
const APPLYING: &str = "applying.duovra";
const PREVIOUS: &str = "previous.sqlite3";
const NOTICE: &str = "last-restore.json";
const NOT_A_BACKUP: &str = "El archivo no es una copia de seguridad de Duovra.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub created_at: Option<i64>,
    pub app_version: Option<String>,
    pub projects: i64,
    pub conversations: i64,
    pub messages: i64,
    pub backgrounds: i64,
}

/// Archivo de copia elegido en el selector y validado, pendiente de confirmar la restauración.
#[derive(Default)]
pub struct RestoreSelection(Mutex<Option<PathBuf>>);

/// `VACUUM INTO`: escribe una instantánea consistente de `conn` en `dest` (debe no existir).
pub(crate) fn snapshot_into(conn: &Connection, dest: &Path) -> Result<()> {
    let target = dest.to_str().context("La ruta de la copia no es válida.")?;
    conn.execute("VACUUM INTO ?1", [target])?;
    Ok(())
}

fn sync(path: &Path) -> Result<()> {
    std::fs::OpenOptions::new().write(true).open(path)?.sync_all()?;
    Ok(())
}

fn tmp_sibling(path: &Path) -> Result<PathBuf> {
    let name = path.file_name().and_then(|n| n.to_str()).context("Nombre de archivo no válido")?;
    Ok(path.with_file_name(format!(".{name}.{}.tmp", new_id())))
}

/// Publica `from` en `to`, sustituyendo el destino si ya existe.
fn publish(from: &Path, to: &Path) -> Result<()> {
    std::fs::rename(from, to).with_context(|| format!("No se pudo guardar el archivo en {}.", to.display()))
}

fn stamp_name(ms: i64) -> String {
    format!("{}-{}", utc_stamp(ms).replace([' ', ':'], "-"), &new_id()[..8])
}

/// Marca la copia con su formato. Deja la base en modo de diario clásico (sin WAL ajeno).
fn stamp(path: &Path, created_at: i64) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "DELETE")?;
    conn.execute_batch("CREATE TABLE duovra_backup (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    for (key, value) in [
        ("format", FORMAT.to_string()),
        ("formatVersion", FORMAT_VERSION.to_string()),
        ("appVersion", APP_VERSION.to_string()),
        ("createdAt", created_at.to_string()),
    ] {
        conn.execute("INSERT INTO duovra_backup(key, value) VALUES(?1, ?2)", params![key, value])?;
    }
    conn.close().map_err(|(_, error)| error)?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)", [name], |row| row.get(0))?)
}

fn count(conn: &Connection, table: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))?)
}

/// Valida una copia sin modificarla: integridad, marca de formato, esquema y tablas básicas.
pub fn inspect(path: &Path) -> Result<Summary> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| anyhow!(NOT_A_BACKUP))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| anyhow!(NOT_A_BACKUP))?;
    if integrity != "ok" {
        bail!("La copia de seguridad está dañada y no se puede restaurar.");
    }
    if !table_exists(&conn, "duovra_backup")? {
        bail!(NOT_A_BACKUP);
    }
    let mut meta = std::collections::HashMap::new();
    {
        let mut statement = conn.prepare("SELECT key, value FROM duovra_backup")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        for row in rows {
            let (key, value) = row?;
            meta.insert(key, value);
        }
    }
    if meta.get("format").map(String::as_str) != Some(FORMAT) {
        bail!(NOT_A_BACKUP);
    }
    if meta.get("formatVersion").map(String::as_str) != Some(FORMAT_VERSION) {
        bail!("Esta copia usa un formato que esta versión de Duovra no entiende.");
    }
    let schema: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema > MAX_SCHEMA_VERSION {
        bail!("La copia se creó con una versión más reciente de Duovra. Actualiza Duovra antes de restaurarla.");
    }
    for table in REQUIRED_TABLES {
        if !table_exists(&conn, table)? {
            bail!(NOT_A_BACKUP);
        }
    }
    let backgrounds = if table_exists(&conn, "background_images")? { count(&conn, "background_images")? } else { 0 };
    Ok(Summary {
        created_at: meta.get("createdAt").and_then(|value| value.parse().ok()),
        app_version: meta.get("appVersion").cloned(),
        projects: count(&conn, "projects")?,
        conversations: count(&conn, "conversations")?,
        messages: count(&conn, "messages")?,
        backgrounds,
    })
}

/// Crea la copia en `dest`. Se escribe en un temporal y solo se publica si la validación pasa.
pub fn write(db: &Db, dest: &Path) -> Result<Summary> {
    let tmp = tmp_sibling(dest)?;
    let result: Result<Summary> = (|| {
        db.snapshot_to(&tmp)?;
        stamp(&tmp, now_ms())?;
        let summary = inspect(&tmp)?;
        sync(&tmp)?;
        publish(&tmp, dest)?;
        Ok(summary)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Copia `source` a la cola de restauración tras validarla. No toca la base en uso.
pub fn stage(source: &Path, data_dir: &Path) -> Result<Summary> {
    let summary = inspect(source)?;
    let restore = data_dir.join(RESTORE_DIR);
    std::fs::create_dir_all(&restore)?;
    let pending = restore.join(PENDING);
    let tmp = tmp_sibling(&pending)?;
    let result: Result<()> = (|| {
        std::fs::copy(source, &tmp)?;
        sync(&tmp)?;
        // Se valida la copia interna: es la que se aplicará aunque el original cambie después.
        let staged = inspect(&tmp)?;
        if staged.projects != summary.projects || staged.conversations != summary.conversations || staged.messages != summary.messages {
            bail!("La copia cambió mientras se preparaba. Vuelve a elegirla.");
        }
        publish(&tmp, &pending)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| summary)
}

fn write_notice(restore: &Path, notice: Value) -> Result<()> {
    std::fs::create_dir_all(restore)?;
    std::fs::write(restore.join(NOTICE), notice.to_string())?;
    Ok(())
}

/// Deja la copia que no pudo aplicarse en `restore/` y avisa al iniciar. Los datos no cambian.
fn reject(restore: &Path, applying: &Path, error: &anyhow::Error) -> Result<()> {
    let target = restore.join(format!("rechazada-{}.{EXTENSION}", stamp_name(now_ms())));
    publish(applying, &target)?;
    write_notice(
        restore,
        json!({
            "status": "failed",
            "at": now_ms(),
            "error": format!("La copia no se restauró: {error:#}. Tus datos actuales se conservan."),
        }),
    )
}

/// Guarda una instantánea validada del estado actual antes de sustituirlo.
fn snapshot_current(db_path: &Path, data_dir: &Path) -> Result<PathBuf> {
    let backups = data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&backups)?;
    let target = backups.join(format!("antes-de-restaurar-{}.{EXTENSION}", stamp_name(now_ms())));
    let tmp = tmp_sibling(&target)?;
    let result: Result<()> = (|| {
        let conn = Connection::open(db_path)?;
        // Vuelca el WAL a la base y lo elimina al cerrar: la instantánea es el estado completo.
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        snapshot_into(&conn, &tmp)?;
        drop(conn);
        stamp(&tmp, now_ms())?;
        inspect(&tmp)?;
        sync(&tmp)?;
        publish(&tmp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| target)
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

/// Resultado de aplicar una restauración; se cierra con `finish` o `rollback`.
pub(crate) struct Applied {
    summary: Summary,
    safety: Option<PathBuf>,
    previous: Option<PathBuf>,
}

/// Aplica una restauración preparada, si la hay. Devuelve `None` cuando no hay nada que aplicar
/// o cuando la copia se rechazó (en ese caso Duovra abre los datos actuales).
pub(crate) fn apply_pending(db_path: &Path) -> Result<Option<Applied>> {
    let Some(data_dir) = db_path.parent() else { return Ok(None) };
    let restore = data_dir.join(RESTORE_DIR);
    let pending = restore.join(PENDING);
    let applying = restore.join(APPLYING);
    let previous = restore.join(PREVIOUS);
    if applying.exists() {
        // Un intento interrumpido: la base apartada vuelve a su sitio y el encargo queda pendiente.
        if previous.exists() && !db_path.exists() {
            publish(&previous, db_path)?;
        }
        publish(&applying, &pending)?;
    }
    if !pending.exists() {
        return Ok(None);
    }
    publish(&pending, &applying)?;
    let summary = match inspect(&applying) {
        Ok(summary) => summary,
        Err(error) => return reject(&restore, &applying, &error).map(|()| None),
    };
    let safety = if db_path.exists() {
        match snapshot_current(db_path, data_dir) {
            Ok(path) => Some(path),
            Err(error) => return reject(&restore, &applying, &error).map(|()| None),
        }
    } else {
        None
    };
    let wal = sidecar(db_path, "-wal");
    if wal.exists() {
        // Tras el punto de control y el cierre no debería quedar WAL; si queda, no se toca la base.
        return reject(&restore, &applying, &anyhow!("la base anterior mantiene cambios sin volcar")).map(|()| None);
    }
    let moved = db_path.exists();
    if moved {
        if let Err(error) = publish(db_path, &previous) {
            return reject(&restore, &applying, &error).map(|()| None);
        }
    }
    let _ = std::fs::remove_file(sidecar(db_path, "-shm"));
    if let Err(error) = publish(&applying, db_path) {
        if moved {
            let _ = publish(&previous, db_path);
        }
        return reject(&restore, &applying, &error).map(|()| None);
    }
    Ok(Some(Applied { summary, safety, previous: moved.then_some(previous) }))
}

impl Applied {
    /// La restauración abrió bien: se retira la base anterior y se deja constancia.
    pub(crate) fn finish(self, db_path: &Path) {
        if let Some(previous) = &self.previous {
            let _ = std::fs::remove_file(previous);
        }
        if let Some(dir) = db_path.parent() {
            let notice = json!({
                "status": "restored",
                "at": now_ms(),
                "summary": self.summary,
                "safetyCopy": self.safety.as_ref().map(|path| path.to_string_lossy().into_owned()),
            });
            let _ = write_notice(&dir.join(RESTORE_DIR), notice);
        }
    }

    /// La copia no abrió: se recupera la base anterior y se avisa.
    pub(crate) fn rollback(self, db_path: &Path, error: &anyhow::Error) -> Result<()> {
        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_file(sidecar(db_path, "-wal"));
        let _ = std::fs::remove_file(sidecar(db_path, "-shm"));
        if let Some(previous) = &self.previous {
            publish(previous, db_path).context("No se pudo recuperar la base anterior. Su copia de seguridad está en la carpeta backups.")?;
        }
        if let Some(dir) = db_path.parent() {
            let _ = write_notice(
                &dir.join(RESTORE_DIR),
                json!({
                    "status": "failed",
                    "at": now_ms(),
                    "error": format!("La copia no se pudo abrir ({error:#}). Tus datos anteriores se conservan."),
                }),
            );
        }
        Ok(())
    }
}

/// Lee y consume el aviso de la última restauración para mostrarlo una vez.
pub fn take_notice(db: &Db) -> Option<Value> {
    let restore = db.data_dir()?.join(RESTORE_DIR);
    let path = restore.join(NOTICE);
    let raw = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

// ---------- Comandos ----------

type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    format!("{err:#}")
}

/// Crea una copia en la ubicación que elija el usuario. Devuelve la ruta o `None` si cancela.
#[tauri::command]
pub async fn backup_create(app: AppHandle, studio: State<'_, Arc<Studio>>) -> Res<Option<String>> {
    let suggested = format!("duovra-copia-{}.{EXTENSION}", utc_stamp(now_ms()).replace([' ', ':'], "-"));
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Crear copia de seguridad de Duovra")
        .set_file_name(&suggested)
        .add_filter("Copia de seguridad de Duovra", &[EXTENSION])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = ensure_extension(picked.into_path().map_err(e)?, EXTENSION);
    let db = studio.db.clone();
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || write(&db, &written))
        .await
        .map_err(e)?
        .map_err(e)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Elige una copia y la valida. Muestra su resumen antes de cualquier cambio.
#[tauri::command]
pub async fn backup_pick_restore(app: AppHandle, selection: State<'_, RestoreSelection>) -> Res<Option<Summary>> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Restaurar copia de seguridad de Duovra")
        .add_filter("Copia de seguridad de Duovra", &[EXTENSION])
        .blocking_pick_file()
    else {
        *selection.0.lock() = None;
        return Ok(None);
    };
    let path = picked.into_path().map_err(e)?;
    let checked = path.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || inspect(&checked)).await.map_err(e)?.map_err(e)?;
    *selection.0.lock() = Some(path);
    Ok(Some(summary))
}

/// Confirma la restauración: prepara la copia y reinicia Duovra para aplicarla.
#[tauri::command]
pub fn backup_confirm_restore(app: AppHandle, studio: State<'_, Arc<Studio>>, selection: State<'_, RestoreSelection>) -> Res<()> {
    let source = selection.0.lock().take().ok_or("Selecciona primero una copia de seguridad.")?;
    let data_dir = studio.db.data_dir().ok_or("Esta instancia no tiene una carpeta de datos.")?;
    // Con los agentes parados y la copia validada, se reinicia para aplicarla antes de abrir los datos.
    let staged = studio.when_idle_for("restaurar una copia", || stage(&source, &data_dir)).map_err(e)?;
    staged.map_err(e)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duovra-{label}-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seeded(dir: &Path, project: &str, messages: usize) -> Db {
        let db = Db::open(&dir.join("studio.sqlite3")).unwrap();
        db.create_project(project, project, "C:/tmp").unwrap();
        db.create_conversation(&format!("{project}-c"), project, Some("Tema")).unwrap();
        for index in 0..messages {
            db.insert_message(&format!("{project}-m{index}"), &format!("{project}-c"), "user", None, None, None, &format!("texto {index}"), "done", &json!(null), &json!([]))
                .unwrap();
        }
        db
    }

    fn user_texts(db: &Db, conversation: &str) -> Vec<String> {
        db.list_messages(conversation).unwrap().into_iter().map(|m| m.content).collect()
    }

    #[test]
    fn copia_incluye_el_wal_y_se_valida() {
        let dir = temp_dir("backup-create");
        let db = seeded(&dir, "a", 3);
        let copy = dir.join("copia.duovra");
        let summary = write(&db, &copy).unwrap();
        assert_eq!((summary.projects, summary.conversations, summary.messages), (1, 1, 3));
        assert_eq!(summary.app_version.as_deref(), Some(APP_VERSION));
        assert!(summary.created_at.is_some());
        let inspected = inspect(&copy).unwrap();
        assert_eq!(inspected.messages, 3, "los mensajes aún en el WAL forman parte de la copia");
        assert!(!dir.join(".copia.duovra").exists());
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rechaza_archivos_que_no_son_copias() {
        let dir = temp_dir("backup-reject");
        let db = seeded(&dir, "a", 1);
        let live = dir.join("studio.sqlite3");
        assert!(inspect(&live).is_err(), "la base viva no tiene marca de copia");
        let text = dir.join("texto.duovra");
        std::fs::write(&text, "no es una base de datos").unwrap();
        assert_eq!(inspect(&text).unwrap_err().to_string(), NOT_A_BACKUP);
        assert!(inspect(&dir.join("no-existe.duovra")).is_err());

        let copy = dir.join("copia.duovra");
        write(&db, &copy).unwrap();
        let future = dir.join("futura.duovra");
        std::fs::copy(&copy, &future).unwrap();
        Connection::open(&future).unwrap().pragma_update(None, "user_version", 99).unwrap();
        assert!(inspect(&future).unwrap_err().to_string().contains("más reciente"));
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rechaza_copias_truncadas_o_alteradas() {
        let dir = temp_dir("backup-corrupt");
        let db = seeded(&dir, "a", 40);
        let copy = dir.join("copia.duovra");
        write(&db, &copy).unwrap();
        let bytes = std::fs::read(&copy).unwrap();
        let truncated = dir.join("truncada.duovra");
        std::fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
        assert!(inspect(&truncated).is_err());
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn raw_message_count(path: &Path) -> i64 {
        Connection::open(path).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn preparar_no_aplica_hasta_el_arranque() {
        let source = temp_dir("restore-source");
        let source_db = seeded(&source, "origen", 2);
        let copy = source.join("copia.duovra");
        write(&source_db, &copy).unwrap();
        drop(source_db);

        let target = temp_dir("restore-target");
        let target_db = seeded(&target, "actual", 5);
        drop(target_db);

        let summary = stage(&copy, &target).unwrap();
        assert_eq!(summary.messages, 2);
        // La copia preparada no se aplica hasta el siguiente arranque: la base sigue intacta.
        assert_eq!(raw_message_count(&target.join("studio.sqlite3")), 5);
        assert!(target.join(RESTORE_DIR).join(PENDING).exists());
    }

    #[test]
    fn aplica_la_copia_en_el_siguiente_arranque() {
        let source = temp_dir("apply-source");
        let source_db = seeded(&source, "origen", 2);
        let copy = source.join("copia.duovra");
        write(&source_db, &copy).unwrap();
        drop(source_db);

        let target = temp_dir("apply-target");
        let target_db = seeded(&target, "actual", 5);
        drop(target_db);
        stage(&copy, &target).unwrap();

        let restored = Db::open(&target.join("studio.sqlite3")).unwrap();
        assert_eq!(user_texts(&restored, "origen-c").len(), 2, "llegan los datos de la copia");
        assert!(restored.list_conversations().unwrap().iter().all(|c| c.project_id == "origen"));
        assert!(restored.list_projects().unwrap().iter().all(|p| p.id == "origen"));
        let notice = take_notice(&restored).expect("aviso de restauración");
        assert_eq!(notice["status"], "restored");
        let safety = notice["safetyCopy"].as_str().expect("copia de seguridad previa");
        assert!(Path::new(safety).exists());
        assert!(take_notice(&restored).is_none(), "el aviso se muestra una sola vez");
        let previous = inspect(Path::new(safety)).unwrap();
        assert_eq!(previous.messages, 5, "el estado anterior queda en la copia previa");
        assert!(!target.join(RESTORE_DIR).join(PREVIOUS).exists());
        drop(restored);
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn una_copia_invalida_no_toca_los_datos_actuales() {
        let target = temp_dir("reject-target");
        let target_db = seeded(&target, "actual", 4);
        drop(target_db);
        let restore = target.join(RESTORE_DIR);
        std::fs::create_dir_all(&restore).unwrap();
        std::fs::write(restore.join(PENDING), b"basura").unwrap();

        let reopened = Db::open(&target.join("studio.sqlite3")).unwrap();
        assert_eq!(user_texts(&reopened, "actual-c").len(), 4);
        let notice = take_notice(&reopened).expect("aviso de rechazo");
        assert_eq!(notice["status"], "failed");
        assert!(notice["error"].as_str().unwrap().contains("Tus datos actuales se conservan"));
        assert!(!restore.join(PENDING).exists());
        drop(reopened);
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn una_copia_que_no_abre_devuelve_los_datos_anteriores() {
        let source = temp_dir("rollback-source");
        let source_db = seeded(&source, "origen", 2);
        let copy = source.join("copia.duovra");
        write(&source_db, &copy).unwrap();
        drop(source_db);
        // Pasa la validación, pero la migración falla al abrirla (tabla en conflicto con el esquema).
        Connection::open(&copy)
            .unwrap()
            .execute_batch("DROP TABLE run_insights; CREATE TABLE run_insights (conflict INTEGER); PRAGMA user_version = 0;")
            .unwrap();

        let target = temp_dir("rollback-target");
        let target_db = seeded(&target, "actual", 4);
        drop(target_db);
        stage(&copy, &target).unwrap();

        let reopened = Db::open(&target.join("studio.sqlite3")).unwrap();
        assert_eq!(user_texts(&reopened, "actual-c").len(), 4, "la base anterior vuelve a abrirse intacta");
        let notice = take_notice(&reopened).expect("aviso de la copia no abierta");
        assert_eq!(notice["status"], "failed");
        assert!(notice["error"].as_str().unwrap().contains("no se pudo abrir"));
        assert!(!target.join(RESTORE_DIR).join(PREVIOUS).exists());
        drop(reopened);
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn restaurar_en_un_perfil_vacio_crea_los_datos() {
        let source = temp_dir("empty-source");
        let source_db = seeded(&source, "origen", 1);
        let copy = source.join("copia.duovra");
        write(&source_db, &copy).unwrap();
        drop(source_db);

        let target = temp_dir("empty-target");
        std::fs::create_dir_all(&target).unwrap();
        stage(&copy, &target).unwrap();
        let restored = Db::open(&target.join("studio.sqlite3")).unwrap();
        assert_eq!(restored.list_projects().unwrap().len(), 1);
        assert!(!target.join(BACKUP_DIR).exists(), "sin datos previos no hay nada que guardar");
        drop(restored);
        std::fs::remove_dir_all(&source).unwrap();
        std::fs::remove_dir_all(&target).unwrap();
    }
}
