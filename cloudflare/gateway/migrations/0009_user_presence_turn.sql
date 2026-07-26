-- Per-user turn budget for presence lines (ack + up to 2 process).
CREATE TABLE IF NOT EXISTS user_presence_turn (
  user_id TEXT PRIMARY KEY,
  process_count INTEGER NOT NULL DEFAULT 0,
  pre_final_count INTEGER NOT NULL DEFAULT 0,
  last_stage TEXT,
  last_line_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
