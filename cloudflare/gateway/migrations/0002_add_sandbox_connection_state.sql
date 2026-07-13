-- A claim row prevents two simultaneous first messages from creating two sandboxes.
ALTER TABLE telegram_user_sandboxes
  ADD COLUMN e2b_sandbox_domain TEXT;

ALTER TABLE telegram_user_sandboxes
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
  CHECK (status IN ('provisioning', 'ready', 'failed'));

ALTER TABLE telegram_user_sandboxes
  ADD COLUMN provisioning_started_at TEXT;
