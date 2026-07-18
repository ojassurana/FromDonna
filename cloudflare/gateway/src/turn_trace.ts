/**
 * Per-message turn tracing for the ops dashboard.
 *
 * Gateway records stages as a Telegram (or future channel) update flows:
 * webhook received → D1 route/provision → sandbox inject → outbound Bot API.
 * Best-effort only: never throw into the hot path if D1 write fails.
 */

export type TurnStatus =
  | "received"
  | "routing"
  | "provisioning"
  | "injecting"
  | "injected"
  | "error"
  | "complete";

export type TurnRow = {
  turn_id: string;
  user_id: string;
  gateway: string;
  gateway_user_id: string;
  gateway_conversation_id: string;
  telegram_update_id: number | null;
  inbound_kind: string | null;
  inbound_preview: string | null;
  status: TurnStatus;
  runtime_id: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type TurnEventRow = {
  id: number;
  turn_id: string;
  ts: string;
  stage: string;
  ok: number;
  detail_json: string | null;
  duration_ms: number | null;
};

const PREVIEW_MAX = 240;
const DETAIL_MAX = 1500;
/** Keep recent history only (D1 is for ops, not forever archive). */
const RETENTION_DAYS = 7;

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function safeJson(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  try {
    return truncate(JSON.stringify(detail), DETAIL_MAX);
  } catch {
    return truncate(String(detail), DETAIL_MAX);
  }
}

async function swallow(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error("turn_trace write failed:", error instanceof Error ? error.message : String(error));
  }
}

export function newTurnId(): string {
  return crypto.randomUUID();
}

export type StartTurnInput = {
  turnId: string;
  userId: string;
  gateway: string;
  gatewayUserId: string;
  gatewayConversationId: string;
  telegramUpdateId?: number | null;
  inboundKind?: string | null;
  inboundPreview?: string | null;
};

export async function startTurn(db: D1Database, input: StartTurnInput): Promise<void> {
  await swallow(async () => {
    const ts = nowIso();
    await db
      .prepare(
        `INSERT INTO message_turns (
           turn_id, user_id, gateway, gateway_user_id, gateway_conversation_id,
           telegram_update_id, inbound_kind, inbound_preview, status,
           runtime_id, error, started_at, updated_at, finished_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'received', NULL, NULL, ?9, ?9, NULL)`,
      )
      .bind(
        input.turnId,
        input.userId,
        input.gateway,
        input.gatewayUserId,
        input.gatewayConversationId,
        input.telegramUpdateId ?? null,
        input.inboundKind ?? null,
        input.inboundPreview ? truncate(input.inboundPreview, PREVIEW_MAX) : null,
        ts,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO message_turn_events (turn_id, ts, stage, ok, detail_json, duration_ms)
         VALUES (?1, ?2, 'webhook.received', 1, ?3, NULL)`,
      )
      .bind(
        input.turnId,
        ts,
        safeJson({
          update_id: input.telegramUpdateId ?? null,
          kind: input.inboundKind ?? null,
        }),
      )
      .run();

    // Best-effort prune old rows (once per turn start is enough).
    await db
      .prepare(
        `DELETE FROM message_turn_events
         WHERE turn_id IN (
           SELECT turn_id FROM message_turns
           WHERE started_at < datetime('now', ?1)
         )`,
      )
      .bind(`-${RETENTION_DAYS} days`)
      .run();
    await db
      .prepare(`DELETE FROM message_turns WHERE started_at < datetime('now', ?1)`)
      .bind(`-${RETENTION_DAYS} days`)
      .run();
  });
}

export async function addTurnEvent(
  db: D1Database,
  turnId: string,
  stage: string,
  opts?: {
    ok?: boolean;
    detail?: unknown;
    durationMs?: number | null;
    status?: TurnStatus;
    runtimeId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await swallow(async () => {
    const ts = nowIso();
    const ok = opts?.ok === false ? 0 : 1;
    await db
      .prepare(
        `INSERT INTO message_turn_events (turn_id, ts, stage, ok, detail_json, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(turnId, ts, stage, ok, safeJson(opts?.detail), opts?.durationMs ?? null)
      .run();

    const sets: string[] = ["updated_at = ?2"];
    const binds: unknown[] = [turnId, ts];
    let i = 3;
    if (opts?.status) {
      sets.push(`status = ?${i++}`);
      binds.push(opts.status);
    }
    if (opts?.runtimeId !== undefined) {
      sets.push(`runtime_id = ?${i++}`);
      binds.push(opts.runtimeId);
    }
    if (opts?.error !== undefined) {
      sets.push(`error = ?${i++}`);
      binds.push(opts.error ? truncate(opts.error, PREVIEW_MAX) : null);
    }
    if (opts?.status === "error" || opts?.status === "complete" || opts?.status === "injected") {
      if (opts.status === "error" || opts.status === "complete") {
        sets.push(`finished_at = ?${i++}`);
        binds.push(ts);
      }
    }

    await db
      .prepare(`UPDATE message_turns SET ${sets.join(", ")} WHERE turn_id = ?1`)
      .bind(...binds)
      .run();
  });
}

/** Attach an outbound Bot API call to the latest open turn for this user. */
export async function attachOutboundEvent(
  db: D1Database,
  userId: string,
  stage: string,
  opts?: { ok?: boolean; detail?: unknown; durationMs?: number | null },
): Promise<void> {
  await swallow(async () => {
    const row = await db
      .prepare(
        `SELECT turn_id FROM message_turns
         WHERE user_id = ?1
           AND status IN ('received', 'routing', 'provisioning', 'injecting', 'injected')
           AND started_at > datetime('now', '-30 minutes')
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .bind(userId)
      .first<{ turn_id: string }>();

    if (!row?.turn_id) return;

    const ts = nowIso();
    const ok = opts?.ok === false ? 0 : 1;
    await db
      .prepare(
        `INSERT INTO message_turn_events (turn_id, ts, stage, ok, detail_json, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(row.turn_id, ts, stage, ok, safeJson(opts?.detail), opts?.durationMs ?? null)
      .run();

    await db
      .prepare(`UPDATE message_turns SET updated_at = ?2 WHERE turn_id = ?1`)
      .bind(row.turn_id, ts)
      .run();
  });
}

export async function listTurns(
  db: D1Database,
  opts?: { limit?: number; userId?: string; status?: string },
): Promise<TurnRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  let sql = `SELECT * FROM message_turns`;
  const binds: unknown[] = [];
  const where: string[] = [];
  if (opts?.userId) {
    where.push(`user_id = ?${binds.length + 1}`);
    binds.push(opts.userId);
  }
  if (opts?.status) {
    where.push(`status = ?${binds.length + 1}`);
    binds.push(opts.status);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY started_at DESC LIMIT ${limit}`;
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<TurnRow>();
  return result.results ?? [];
}

export async function getTurn(db: D1Database, turnId: string): Promise<TurnRow | null> {
  return (await db.prepare(`SELECT * FROM message_turns WHERE turn_id = ?1`).bind(turnId).first<TurnRow>()) ?? null;
}

export async function getTurnEvents(db: D1Database, turnId: string): Promise<TurnEventRow[]> {
  const result = await db
    .prepare(
      `SELECT id, turn_id, ts, stage, ok, detail_json, duration_ms
       FROM message_turn_events WHERE turn_id = ?1 ORDER BY id ASC`,
    )
    .bind(turnId)
    .all<TurnEventRow>();
  return result.results ?? [];
}

export async function listActiveUsers(db: D1Database, limit = 40): Promise<
  Array<{ user_id: string; turns: number; last_status: string; last_at: string }>
> {
  const result = await db
    .prepare(
      `SELECT user_id,
              COUNT(*) AS turns,
              MAX(started_at) AS last_at,
              (
                SELECT status FROM message_turns t2
                WHERE t2.user_id = t1.user_id
                ORDER BY started_at DESC LIMIT 1
              ) AS last_status
       FROM message_turns t1
       GROUP BY user_id
       ORDER BY last_at DESC
       LIMIT ?1`,
    )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<{ user_id: string; turns: number; last_status: string; last_at: string }>();
  return result.results ?? [];
}

export function inboundPreviewFromUpdate(update: {
  message?: { text?: string; caption?: string };
  edited_message?: { text?: string; caption?: string };
  callback_query?: { data?: string };
}): { kind: string; preview: string } {
  if (update.callback_query) {
    return { kind: "callback_query", preview: update.callback_query.data || "(callback)" };
  }
  if (update.edited_message) {
    const t = update.edited_message.text || update.edited_message.caption || "(edited)";
    return { kind: "edited_message", preview: t };
  }
  if (update.message) {
    const t = update.message.text || update.message.caption || "(message)";
    return { kind: "message", preview: t };
  }
  return { kind: "update", preview: "(unknown update)" };
}
