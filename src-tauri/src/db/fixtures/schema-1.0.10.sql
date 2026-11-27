-- SQLite 1.0.10: esquema de 0c8fbea (identico en 9a289f7), init_schema y migrate de db.rs y modulos.
-- Se ejecutan todas las migraciones sobre una base vacia, como al instalar 1.0.10.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_agent TEXT,
  last_model TEXT,
  last_effort TEXT,
  draft TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  effort TEXT,
  content TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT,
  usage TEXT NOT NULL DEFAULT 'null',
  context_note TEXT NOT NULL DEFAULT 'null',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_seq ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS provider_sessions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  account_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS execution_queue (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','blocked','review','done','removed')),
    revision INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    message_id TEXT,
    session_id TEXT,
    turn_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_position ON execution_queue(conversation_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_running ON execution_queue(conversation_id) WHERE state='running';
CREATE TABLE IF NOT EXISTS steer_attempts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_pauses (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    message_id TEXT
);


CREATE TABLE IF NOT EXISTS background_images (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  thumbnail BLOB NOT NULL
);

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

ALTER TABLE conversations ADD COLUMN agent_prefs TEXT NOT NULL DEFAULT '{}';
UPDATE conversations SET agent_prefs = json_object(last_agent, json_object('model', last_model, 'effort', last_effort))              WHERE last_agent IS NOT NULL AND last_model IS NOT NULL;
ALTER TABLE conversations ADD COLUMN draft_attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversations ADD COLUMN auto_title_pending INTEGER NOT NULL DEFAULT 0;
             UPDATE conversations SET auto_title_pending=1 WHERE title='Nueva conversación'
               AND NOT EXISTS (
                 SELECT 1 FROM messages WHERE conversation_id=conversations.id
                   AND role='user' AND trim(content, char(9, 10, 13, 32)) <> ''
               );
ALTER TABLE conversations ADD COLUMN worktree_id TEXT;
ALTER TABLE conversations ADD COLUMN permission_prefs TEXT NOT NULL DEFAULT '{}';
CREATE TABLE run_insights (
           message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
           conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
           started_at INTEGER NOT NULL,
           details TEXT NOT NULL DEFAULT '{}',
           metrics TEXT NOT NULL DEFAULT '{}',
           provider_key TEXT UNIQUE,
           duplicate INTEGER NOT NULL DEFAULT 0,
           observed_end INTEGER,
           legacy INTEGER NOT NULL DEFAULT 0,
           input INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.inputTokens')) STORED,
           fresh INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.freshInputTokens')) STORED,
           cache_read INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.cachedInputTokens')) STORED,
           cache_write INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.cacheWriteInputTokens')) STORED,
           output INTEGER GENERATED ALWAYS AS (json_extract(metrics,'$.outputTokens')) STORED,
           cost_estimated REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metrics,'$.costKind')='estimate' THEN json_extract(metrics,'$.costUsd') END) STORED,
           cost_reported REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metrics,'$.costKind')='reported' THEN json_extract(metrics,'$.costUsd') END) STORED,
           partial INTEGER GENERATED ALWAYS AS (coalesce(json_extract(metrics,'$.partial'),0)) STORED
         );
         CREATE INDEX run_insights_time ON run_insights(started_at);
         CREATE INDEX run_insights_conversation ON run_insights(conversation_id,started_at);
         CREATE TABLE insight_claude_requests (
           session_id TEXT NOT NULL, request_id TEXT NOT NULL,
           message_id TEXT NOT NULL REFERENCES run_insights(message_id) ON DELETE CASCADE,
           PRIMARY KEY(session_id,request_id)
         );
         CREATE INDEX insight_claude_requests_message ON insight_claude_requests(message_id);
         INSERT INTO run_insights(message_id,conversation_id,started_at,legacy,observed_end)
           SELECT id,conversation_id,created_at,1,
                  CASE WHEN status IN ('done','failed','cancelled') THEN completed_at END
           FROM messages WHERE role='assistant' AND agent IN ('claude','codex');
         CREATE TRIGGER run_insights_insert AFTER INSERT ON messages
           WHEN NEW.role='assistant' AND NEW.agent IN ('claude','codex')
         BEGIN
           INSERT INTO run_insights(message_id,conversation_id,started_at)
           VALUES(NEW.id,NEW.conversation_id,NEW.created_at);
         END;
         PRAGMA user_version = 1;
