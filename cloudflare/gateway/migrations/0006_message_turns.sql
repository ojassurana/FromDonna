-- Per-message turn tracing for ops (message flow dashboard).
-- Gateway writes stages as a turn progresses: webhook → route → inject → outbound Bot API.

CREATE TABLE IF NOT EXISTS message_turns (
  turn_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gateway TEXT NOT NULL,
  gateway_user_id TEXT NOT NULL,
  gateway_conversation_id TEXT NOT NULL,
  telegram_update_id INTEGER,
  inbound_kind TEXT,
  inbound_preview TEXT,
  status TEXT NOT NULL
    CHECK (status IN (
      'received',
      'routing',
      'provisioning',
      'injecting',
      'injected',
      'error',
      'complete'
    )),
  runtime_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS message_turn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  stage TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  detail_json TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (turn_id) REFERENCES message_turns(turn_id)
);

CREATE INDEX IF NOT EXISTS idx_message_turns_started
  ON message_turns (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_turns_user_started
  ON message_turns (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_turns_status
  ON message_turns (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_turn_events_turn
  ON message_turn_events (turn_id, id);
