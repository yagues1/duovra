//! Copias administradas, aisladas en el mismo perfil que los ajustes de apariencia.

use std::collections::HashSet;

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use super::Db;

pub(super) const SETTINGS_KEY: &str = "appearance.background.v1";
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS background_images (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  thumbnail BLOB NOT NULL
);";
const PROFILE_MAX_BYTES: i64 = 128 * 1024 * 1024;
const MAX_IMAGES: i64 = 64;

pub(crate) fn parse_image_id(raw: &str) -> Result<Uuid> {
    Uuid::parse_str(raw)
        .ok()
        .filter(|id| id.get_version_num() == 4 && id.to_string() == raw)
        .ok_or_else(|| anyhow!("La referencia de la imagen de fondo no es válida."))
}

fn image_references(settings: &Value) -> Result<HashSet<Uuid>> {
    let active = settings.get("active").into_iter();
    let presets = settings.get("presets").and_then(Value::as_array).into_iter().flatten();
    active
        .chain(presets)
        .filter_map(|entry| entry.get("config"))
        .filter(|config| config["kind"] == "image")
        .filter(|config| !config["image"]["id"].is_null())
        .map(|config| {
            let id = config["image"]["id"]
                .as_str()
                .ok_or_else(|| anyhow!("La referencia de la imagen de fondo no es válida."))?;
            parse_image_id(id)
        })
        .collect()
}

fn stored_references(conn: &Connection) -> Result<HashSet<Uuid>> {
    let settings: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [SETTINGS_KEY], |row| row.get(0))
        .optional()?;
    match settings {
        Some(value) => image_references(&serde_json::from_str(&value)?),
        None => Ok(HashSet::new()),
    }
}

pub(super) fn validate_references(conn: &Connection, value: &Value) -> Result<()> {
    for id in image_references(value)? {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM background_images WHERE id=?1)",
            [id.to_string()],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(anyhow!("La imagen de fondo ya no está disponible. Selecciona otra imagen."));
        }
    }
    Ok(())
}

impl Db {
    pub(crate) fn add_background_image(&self, data: &[u8], thumbnail: &[u8]) -> Result<Uuid> {
        let conn = self.conn.lock();
        let (count, stored): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(data) + length(thumbnail)), 0) FROM background_images",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if count >= MAX_IMAGES || stored + (data.len() + thumbnail.len()) as i64 > PROFILE_MAX_BYTES {
            return Err(anyhow!("El perfil alcanzó el límite de imágenes de fondo. Elimina imágenes que no uses."));
        }
        let id = Uuid::new_v4();
        conn.execute(
            "INSERT INTO background_images(id,data,thumbnail) VALUES(?1,?2,?3)",
            params![id.to_string(), data, thumbnail],
        )?;
        Ok(id)
    }

    pub(crate) fn read_background_image(&self, id: Uuid, thumbnail: bool) -> Result<Vec<u8>> {
        let query = if thumbnail {
            "SELECT thumbnail FROM background_images WHERE id=?1"
        } else {
            "SELECT data FROM background_images WHERE id=?1"
        };
        self.conn
            .lock()
            .query_row(query, [id.to_string()], |row| row.get(0))
            .optional()?
            .ok_or_else(|| anyhow!("La imagen de fondo ya no está disponible. Selecciona otra imagen."))
    }

    pub(crate) fn release_background_images(&self, ids: &[Uuid]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let retained = stored_references(&tx)?;
        for id in ids.iter().filter(|id| !retained.contains(id)) {
            tx.execute("DELETE FROM background_images WHERE id=?1", [id.to_string()])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// El bloqueo del perfil garantiza que ya no hay un editor con un borrador abierto.
    pub(super) fn recover_background_images(&self) -> Result<()> {
        let ids = {
            let conn = self.conn.lock();
            let mut query = conn.prepare("SELECT id FROM background_images")?;
            let stored = query.query_map([], |row| row.get::<_, String>(0))?;
            stored.filter_map(|raw| raw.ok().and_then(|id| parse_image_id(&id).ok())).collect::<Vec<_>>()
        };
        if !ids.is_empty() {
            self.release_background_images(&ids)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_keeps_active_and_preset_images() {
        let db = Db::open_memory().unwrap();
        let active = db.add_background_image(b"active", b"preview").unwrap();
        let preset = db.add_background_image(b"preset", b"preview").unwrap();
        let abandoned = db.add_background_image(b"abandoned", b"preview").unwrap();
        let config = |id: Uuid| json!({ "config": { "kind": "image", "image": { "id": id.to_string() } } });

        db.set_setting(SETTINGS_KEY, &json!({ "active": config(active), "presets": [config(preset)] })).unwrap();
        db.release_background_images(&[active, preset, abandoned]).unwrap();
        assert_eq!(db.read_background_image(active, false).unwrap(), b"active");
        assert_eq!(db.read_background_image(active, true).unwrap(), b"preview");
        assert_eq!(db.read_background_image(preset, false).unwrap(), b"preset");
        assert!(db.read_background_image(abandoned, false).is_err());

        let retired = db.add_background_image(b"retired", b"preview").unwrap();
        db.set_setting(SETTINGS_KEY, &json!({ "active": { "config": { "kind": "minimal" } }, "presets": [config(preset)] })).unwrap();
        db.recover_background_images().unwrap();
        assert!(db.read_background_image(active, false).is_err());
        assert!(db.read_background_image(retired, true).is_err());
        assert_eq!(db.read_background_image(preset, false).unwrap(), b"preset");
        assert!(db.set_setting(SETTINGS_KEY, &json!({ "active": config(active) })).is_err());
    }

    #[test]
    fn rejects_untrusted_image_references() {
        assert!(parse_image_id("../projects.sqlite3").is_err());
        assert!(parse_image_id(&Uuid::nil().to_string()).is_err());
        assert!(parse_image_id(&Uuid::new_v4().simple().to_string()).is_err());
    }
}
