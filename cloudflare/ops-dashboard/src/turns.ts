/**
 * Read-only queries against gateway-written message turn tables.
 * Writers live in fromdonna-gateway (`turn_trace.ts`); this Worker only displays.
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

export async function listActiveUsers(
  db: D1Database,
  limit = 40,
): Promise<Array<{ user_id: string; turns: number; last_status: string; last_at: string }>> {
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
