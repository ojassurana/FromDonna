/**
 * fromdonna-ops-dashboard — standalone ops UI for per-message turn flow.
 *
 * Reads D1 tables written by fromdonna-gateway (message_turns / events).
 * Does not handle Telegram, E2B, or product traffic.
 *
 * Auth: open for now (TODO: re-enable OPS_ADMIN_SECRET before public exposure).
 */

import { getTurn, getTurnEvents, listActiveUsers, listTurns } from "./turns";
import { dashboardHtml } from "./ui";

export interface Env {
  FROMDONNA_ROUTING: D1Database;
  /** Optional; unused while auth is off. */
  OPS_ADMIN_SECRET?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname === "" ? "/" : url.pathname;

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, service: "fromdonna-ops-dashboard", auth: "off" });
    }

    if (request.method === "GET" && (path === "/" || path === "/turns" || path === "/turns/")) {
      return new Response(dashboardHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (path === "/api/turns" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || "50");
      const userId = url.searchParams.get("userId") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const turns = await listTurns(env.FROMDONNA_ROUTING, { limit, userId, status });
      return json({ ok: true, turns });
    }

    const turnMatch = path.match(/^\/api\/turns\/([^/]+)$/);
    if (turnMatch && request.method === "GET") {
      const turnId = decodeURIComponent(turnMatch[1]);
      const turn = await getTurn(env.FROMDONNA_ROUTING, turnId);
      if (!turn) return json({ ok: false, error: "not_found" }, 404);
      const events = await getTurnEvents(env.FROMDONNA_ROUTING, turnId);
      return json({ ok: true, turn, events });
    }

    if (path === "/api/users" && request.method === "GET") {
      const users = await listActiveUsers(env.FROMDONNA_ROUTING);
      return json({ ok: true, users });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
