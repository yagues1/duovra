//! Worktrees de Git registrados en Duovra (1.0.9).
//!
//! Solo se guarda la referencia (ruta, rama, etiqueta y origen): los worktrees son de Git y viven
//! en disco. Una conversación con `worktree_id` se ejecuta en ese directorio; sin él, en el
//! directorio principal del proyecto (todas las conversaciones anteriores a la 1.0.9).

use super::Db;
use crate::util::now_ms;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  branch TEXT,
  label TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  base_ref TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub branch: Option<String>,
    pub label: String,
    /// Creado por Duovra (`true`) o importado de un worktree existente (`false`).
    pub managed: bool,
    pub base_ref: Option<String>,
    /// Retirado de Duovra: se conserva solo para el historial de sus conversaciones.
    pub retired: bool,
    pub created_at: i64,
    /// El directorio existe en disco (calculado al leer, no se guarda).
    pub exists: bool,
}

fn map(row: &Row) -> rusqlite::Result<Worktree> {
    let path: String = row.get("path")?;
    Ok(Worktree {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        exists: std::path::Path::new(&path).is_dir(),
        path,
        branch: row.get("branch")?,
        label: row.get("label")?,
        managed: row.get("managed")?,
        base_ref: row.get("base_ref")?,
        retired: row.get("retired")?,
        created_at: row.get("created_at")?,
    })
}

pub struct NewWorktree<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub path: &'a str,
    pub branch: Option<&'a str>,
    pub label: &'a str,
    pub managed: bool,
    pub base_ref: Option<&'a str>,
}

impl Db {
    pub fn list_worktrees(&self) -> Result<Vec<Worktree>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT * FROM worktrees ORDER BY created_at")?;
        let rows = st.query_map([], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_worktree(&self, id: &str) -> Result<Worktree> {
        self.conn.lock().query_row("SELECT * FROM worktrees WHERE id=?1", [id], map)
            .optional()?.ok_or_else(|| anyhow!("Worktree no encontrado"))
    }

    pub fn insert_worktree(&self, w: NewWorktree) -> Result<Worktree> {
        let c = self.conn.lock();
        // Volver a registrar una ruta retirada la reactiva en lugar de duplicarla.
        let existing: Option<String> = c.query_row(
            "SELECT id FROM worktrees WHERE project_id=?1 AND lower(path)=lower(?2)", params![w.project_id, w.path], |r| r.get(0),
        ).optional()?;
        let id = if let Some(id) = existing {
            c.execute(
                "UPDATE worktrees SET retired=0, branch=?2, label=?3 WHERE id=?1",
                params![id, w.branch, w.label],
            )?;
            id
        } else {
            c.execute(
                "INSERT INTO worktrees(id,project_id,path,branch,label,managed,base_ref,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![w.id, w.project_id, w.path, w.branch, w.label, w.managed, w.base_ref, now_ms()],
            )?;
            w.id.to_owned()
        };
        drop(c);
        self.get_worktree(&id)
    }

    pub fn rename_worktree(&self, id: &str, label: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE worktrees SET label=?2 WHERE id=?1", params![id, label])?;
        Ok(())
    }

    pub fn update_worktree_location(&self, id: &str, path: &str, branch: Option<&str>) -> Result<()> {
        self.conn.lock().execute("UPDATE worktrees SET path=?2, branch=?3 WHERE id=?1", params![id, path, branch])?;
        Ok(())
    }

    /// Retira el worktree de Duovra. Si conserva conversaciones queda como referencia retirada
    /// (su historial sigue disponible); si no, desaparece el registro. Nunca toca el disco.
    pub fn retire_worktree(&self, id: &str) -> Result<()> {
        let c = self.conn.lock();
        let used: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversations WHERE worktree_id=?1)", [id], |r| r.get(0),
        )?;
        if used {
            c.execute("UPDATE worktrees SET retired=1 WHERE id=?1", [id])?;
        } else {
            c.execute("DELETE FROM worktrees WHERE id=?1", [id])?;
        }
        Ok(())
    }

    /// Conversaciones del worktree, encargos en cola y ejecuciones registradas en curso.
    pub fn worktree_usage(&self, id: &str) -> Result<(i64, i64, i64)> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT
               (SELECT COUNT(*) FROM conversations WHERE worktree_id=?1),
               (SELECT COUNT(*) FROM execution_queue q JOIN conversations c ON c.id=q.conversation_id
                  WHERE c.worktree_id=?1 AND q.state IN ('pending','running','blocked','review')),
               (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id
                  WHERE c.worktree_id=?1 AND m.status='running')",
            [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?)
    }

    /// Directorio raíz de un espacio: el de un proyecto o el de uno de sus worktrees.
    pub fn space_root(&self, space_id: &str) -> Result<String> {
        if let Ok(project) = self.get_project(space_id) {
            return Ok(project.path);
        }
        let worktree = self.get_worktree(space_id).map_err(|_| anyhow!("Proyecto no encontrado"))?;
        if worktree.retired {
            return Err(anyhow!("Este worktree se retiró de Duovra; su directorio ya no está disponible."));
        }
        Ok(worktree.path)
    }

    /// Directorio en el que trabaja una conversación. Falla con un motivo claro si su worktree se
    /// retiró o ya no existe en disco: nunca recae en otro directorio.
    pub fn conversation_root(&self, conversation_id: &str) -> Result<String> {
        let conv = self.get_conversation(conversation_id)?;
        let Some(worktree_id) = conv.worktree_id else {
            return Ok(self.get_project(&conv.project_id)?.path);
        };
        let worktree = self.get_worktree(&worktree_id)
            .map_err(|_| anyhow!("El worktree de esta conversación ya no está registrado en Duovra."))?;
        if worktree.retired {
            return Err(anyhow!("El worktree de esta conversación se retiró de Duovra. Su directorio original ({}) ya no está disponible.", worktree.path));
        }
        if !worktree.exists {
            return Err(anyhow!("El directorio del worktree «{}» ya no existe ({}). Repáralo o retíralo desde la barra lateral.", worktree.label, worktree.path));
        }
        Ok(worktree.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversaciones_por_espacio_y_retirada_sin_perder_historial() {
        let db = Db::open_memory().unwrap();
        let dir = std::env::temp_dir();
        let root = dir.to_string_lossy().to_string();
        db.create_project("p", "Demo", &root).unwrap();
        let wt = db.insert_worktree(NewWorktree {
            id: "w", project_id: "p", path: &root, branch: Some("feat"), label: "feat", managed: true, base_ref: Some("main"),
        }).unwrap();
        assert!(wt.exists && wt.managed);
        db.create_conversation("main", "p", None).unwrap();
        db.create_conversation_in("c", "p", None, Some("w")).unwrap();
        assert_eq!(db.get_conversation("main").unwrap().worktree_id, None);
        assert_eq!(db.get_conversation("c").unwrap().worktree_id.as_deref(), Some("w"));
        assert_eq!(db.space_root("w").unwrap(), root);
        assert_eq!(db.conversation_root("c").unwrap(), root);
        assert_eq!(db.worktree_usage("w").unwrap(), (1, 0, 0));

        // Retirar con conversaciones: el registro queda retirado y la conversación no recae en otro sitio.
        db.retire_worktree("w").unwrap();
        assert!(db.get_worktree("w").unwrap().retired);
        assert!(db.conversation_root("c").is_err());
        assert!(db.space_root("w").is_err());
        assert_eq!(db.get_conversation("c").unwrap().worktree_id.as_deref(), Some("w"));

        // Registrar de nuevo la misma ruta lo reactiva sin duplicar.
        let again = db.insert_worktree(NewWorktree {
            id: "otro", project_id: "p", path: &root, branch: Some("feat"), label: "feat", managed: false, base_ref: None,
        }).unwrap();
        assert_eq!(again.id, "w");
        assert!(!again.retired);

        // Sin conversaciones, retirar borra la referencia.
        db.insert_worktree(NewWorktree { id: "v", project_id: "p", path: "C:/no/existe", branch: None, label: "v", managed: false, base_ref: None }).unwrap();
        assert!(!db.get_worktree("v").unwrap().exists);
        db.retire_worktree("v").unwrap();
        assert!(db.get_worktree("v").is_err());
    }
}
