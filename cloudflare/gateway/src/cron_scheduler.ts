/**
 * Cron scheduler handler for FromDonna gateway.
 *
 * Prototype — not wired into production yet.
 *
 * How it works:
 * 1. Cloudflare fires `scheduled()` every minute (see wrangler.toml [triggers])
 * 2. We query D1 `user_cron_jobs` for jobs whose `next_run` is due
 * 3. For each due job: resume the user's E2B sandbox and inject a synthetic
 *    Telegram-style turn so Donna wakes up and runs the task
 *
 * Missing piece before this can ship:
 * - When Donna creates a cron job via cronjob_tools.py, the harness must also
 *   write a row to D1 `user_cron_jobs` (sandbox state.db is unreadable while paused)
 * - The harness needs a POST /internal/cron/sync endpoint the Worker can call
 *   after each turn to pull due-job metadata into D1
 */

import type { Env } from "./index";

type CronJobRow = {
  id: string;
  user_id: string;
  gateway_conversation_id: string;
  runtime_id: string;
  prompt: string;
  next_run: number; // unix seconds
  schedule: string; // cron expression e.g. "0 22 * * *"
};

/**
 * Entry point — called by the `scheduled()` export in index.ts every minute.
 */
export async function handleCronTick(env: Env): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  let jobs: CronJobRow[] = [];
  try {
    const result = await env.FROMDONNA_ROUTING.prepare(
      `SELECT id, user_id, gateway_conversation_id, runtime_id, prompt, next_run, schedule
       FROM user_cron_jobs
       WHERE next_run <= ? AND enabled = 1
       LIMIT 50`,
    )
      .bind(nowSec)
      .all<CronJobRow>();
    jobs = result.results ?? [];
  } catch (err) {
    // Table may not exist yet in dev — log and exit cleanly.
    console.error("cron_tick: D1 query failed:", err instanceof Error ? err.message : err);
    return;
  }

  if (jobs.length === 0) return;
  console.log(`cron_tick: ${jobs.length} job(s) due`);

  await Promise.allSettled(jobs.map((job) => fireJob(env, job)));
}

async function fireJob(env: Env, job: CronJobRow): Promise<void> {
  try {
    // Build a minimal synthetic Telegram Update so the existing
    // injectTelegramUpdate() path handles it without any new code.
    const syntheticUpdate = buildSyntheticUpdate(job);

    // POST to our own /telegram/webhook using the harness secret as auth.
    // In production this should use a service binding instead of a public fetch.
    const workerUrl =
      (env as unknown as Record<string, string>).WORKER_PUBLIC_URL ||
      "https://fromdonna-gateway.code-df4.workers.dev";

    const resp = await fetch(`${workerUrl}/internal/cron/fire`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.WORKER_TO_HARNESS_SECRET}`,
      },
      body: JSON.stringify({ jobId: job.id, userId: job.user_id, update: syntheticUpdate }),
    });

    if (!resp.ok) {
      console.error(`cron_tick: fire failed for job ${job.id}: HTTP ${resp.status}`);
      return;
    }

    // Advance next_run by one schedule interval.
    await advanceNextRun(env, job);
    console.log(`cron_tick: fired job ${job.id} for user ${job.user_id}`);
  } catch (err) {
    console.error(`cron_tick: error firing job ${job.id}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Builds a minimal Telegram Update envelope that looks like a user message.
 * The gateway's normalizeTelegramUpdate() will parse this normally.
 */
function buildSyntheticUpdate(job: CronJobRow): Record<string, unknown> {
  const [gatewayType, gatewayUserId] = job.user_id.includes(":")
    ? job.user_id.split(":", 2)
    : ["telegram", job.user_id];

  return {
    update_id: Date.now(), // synthetic, not from Telegram
    message: {
      message_id: Date.now(),
      from: {
        id: Number(gatewayUserId) || 0,
        is_bot: false,
        first_name: "CronJob",
      },
      chat: {
        id: Number(job.gateway_conversation_id) || 0,
        type: "private",
      },
      date: Math.floor(Date.now() / 1000),
      text: job.prompt,
      // Mark as synthetic so the gateway can skip presence ack if desired.
      _fromdonna_source: "cron",
      _fromdonna_job_id: job.id,
      _fromdonna_gateway_type: gatewayType,
    },
  };
}

/**
 * Naive next-run advance: add the smallest unit implied by the schedule.
 * A real implementation should use croniter (Python side) or a JS cron parser.
 * For the prototype we just add 60 seconds (re-evaluated next minute tick).
 *
 * TODO: call harness /internal/cron/next-run to get the real next timestamp
 * from croniter so we don't re-fire every minute for non-minutely jobs.
 */
async function advanceNextRun(env: Env, job: CronJobRow): Promise<void> {
  // Temporary: mark as fired by setting next_run far in the future.
  // The harness should update this properly via /internal/cron/sync.
  const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
  await env.FROMDONNA_ROUTING.prepare(
    `UPDATE user_cron_jobs SET next_run = ?, last_fired = ? WHERE id = ?`,
  )
    .bind(FAR_FUTURE, Math.floor(Date.now() / 1000), job.id)
    .run();
}
