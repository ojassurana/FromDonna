-- Per-user Composio binding: forever identity rules (toolkits allowlist).
-- Composio user_id === product user_id.
-- Capability Bearer (30d default HMAC) is NOT stored here — harness process env only.

CREATE TABLE IF NOT EXISTS user_composio (
  user_id TEXT PRIMARY KEY REFERENCES user_agents(user_id),
  toolkits_json TEXT NOT NULL,
  composio_ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_composio_ready ON user_composio (composio_ready);
