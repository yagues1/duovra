CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    issue_number INTEGER
);

-- Capturas privadas (JPEG reexportado, sin metadatos, hasta 1 MB) cuando no se usa R2.
CREATE TABLE IF NOT EXISTS captures (
    key TEXT PRIMARY KEY NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
);
