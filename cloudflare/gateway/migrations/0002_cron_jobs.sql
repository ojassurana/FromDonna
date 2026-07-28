-- Migration: add user_cron_jobs table for the Cloudflare Cron Trigger prototype.
-- Apply with: npx wrangler d1 execute fromdonna-routing --file=migrations/0002_cron_jobs.sql
--
-- Rows are written by the harness (Python) whenever Donna creates a cron job via
-- cronjob_tools.py. The gateway cron tick reads this table every minute to find
-- due jobs and wake the right sandbox.

CREATE TABLE IF NOT EXISTS user_cron_jobs (
  id                       TEXT PRIMARY KEY,          -- matches job id in sandbox state.db
  user_id                  TEXT NOT NULL,             -- gateway user id (e.g. "telegram:123456")
  gateway_conversation_id  TEXT NOT NULL,             -- chat_id the job belongs to
  runtime_id               TEXT NOT NULL,             -- E2B sandbox id to resume
  prompt                   TEXT NOT NULL,             -- message injected when the job fires
  schedule                 TEXT NOT NULL,             -- cron expression e.g. "0 22 * * *"
  next_run                 INTEGER NOT NULL,          -- unix seconds; gateway fires when <= now()
  last_fired               INTEGER,                   -- unix seconds of last successful fire
  enabled                  INTEGER NOT NULL DEFAULT 1 -- 0 = paused/deleted
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON user_cron_jobs (next_run, enabled);
