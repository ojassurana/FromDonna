-- One active E2B sandbox routing record per Telegram user.
-- The Worker finds the row by telegram_user_id before forwarding a turn.
CREATE TABLE IF NOT EXISTS telegram_user_sandboxes (
  telegram_user_id TEXT PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  e2b_sandbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_sandboxes_chat_id
  ON telegram_user_sandboxes (telegram_chat_id);
