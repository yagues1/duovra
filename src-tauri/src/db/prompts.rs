//! Esquema histórico de la biblioteca de prompts retirada de 1.0.11.
//! No se expone por IPC. Se mantiene para conservar datos y la compatibilidad de SQLite.

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;
