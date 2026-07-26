-- Last-N chat snippets for contextual presence acks (edge, not Hermes memory).
CREATE TABLE IF NOT EXISTS user_presence_ring (
  user_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
