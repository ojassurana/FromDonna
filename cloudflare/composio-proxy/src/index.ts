/**
 * FromDonna Composio proxy Worker (fromdonna-composio-proxy).
 *
 * - Holds COMPOSIO_API_KEY
 * - Mints per-user MCP capability tokens for Hermes (default TTL 30d)
 * - Proxies MCP HTTP to Composio tool-router session MCP
 * - Internal APIs for gateway: ensure session + connect links
 *
 * Never put COMPOSIO_API_KEY in E2B.
 */

import type { Env } from "./env";
import { internalSecrets, sessionSecret, sessionTtlSeconds } from "./env";
import {
  createToolRouterSession,
  createToolkitLink,
  extractRedirectUrl,
  proxyToComposioMcp,
} from "./composio_api";
import { canonicalizeToolkit, defaultToolkits, resolveToolkits } from "./toolkits";
import {
  bearerToken,
  mintSessionToken,
  refreshSessionToken,
  verifySessionToken,
  type SessionClaims,
} from "./session_token";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Constant-time string equality (length must already match). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) {
    ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return ok === 0;
}

/**
 * Accept x-fromdonna-internal OR Authorization: Bearer.
 * Presented secret must match ANY configured candidate
 * (INTERNAL_AUTH_SECRET, COMPOSIO_SESSION_SECRET, WORKER_TO_HARNESS_SECRET).
 */
function requireInternalAuth(request: Request, env: Env): boolean {
  const presented =
    request.headers.get("x-fromdonna-internal") ||
    bearerToken(request) ||
    "";
  if (!presented) return false;
  try {
    const candidates = internalSecrets(env);
    for (const expected of candidates) {
      if (timingSafeEqual(presented, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function publicBase(request: Request, env: Env): string {
  const configured = (env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function handleInternalSession(request: Request, env: Env): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return json({ error: { message: "Unauthorized.", code: "unauthorized" } }, 401);
  }
  if (!env.COMPOSIO_API_KEY?.trim()) {
    return json({ error: { message: "COMPOSIO_API_KEY not configured.", code: "misconfigured" } }, 503);
  }

  let body: {
    user_id?: string;
    toolkits?: string[];
    runtime_id?: string;
    ttl_seconds?: number;
    /** If set, re-mint our Bearer without creating a new Composio session */
    composio_session_id?: string;
    composio_mcp_url?: string;
    force_new_composio_session?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: { message: "Invalid JSON.", code: "invalid_json" } }, 400);
  }

  const userId = (body.user_id || "").trim();
  if (!userId) {
    return json({ error: { message: "user_id required.", code: "invalid_body" } }, 400);
  }

  const toolkits = resolveToolkits(body.toolkits);
  const ttl = body.ttl_seconds ?? sessionTtlSeconds(env);
  const secret = sessionSecret(env);

  try {
    let sessionId = (body.composio_session_id || "").trim();
    let mcpUrl = (body.composio_mcp_url || "").trim();
    let reused = false;

    if (!body.force_new_composio_session && sessionId && mcpUrl) {
      reused = true;
    } else {
      const session = await createToolRouterSession(env.COMPOSIO_API_KEY, userId, toolkits);
      sessionId = session.session_id;
      mcpUrl = session.mcp.url;
    }

    const token = await mintSessionToken(secret, {
      user_id: userId,
      toolkits,
      runtime_id: body.runtime_id,
      composio_session_id: sessionId,
      composio_mcp_url: mcpUrl,
      ttlSeconds: ttl,
    });

    const base = publicBase(request, env);
    return json({
      ok: true,
      user_id: userId,
      toolkits,
      composio_session_id: sessionId,
      /** Shared product MCP URL (all sandboxes) */
      mcp_url: `${base}/mcp`,
      /** Per-user Bearer for Hermes — production TTL default 30d */
      mcp_token: token,
      exp: Math.floor(Date.now() / 1000) + ttl,
      ttl_seconds: ttl,
      reused_composio_session: reused,
      /** Server-side Composio MCP target (not the product key) */
      composio_mcp_url: mcpUrl,
    });
  } catch (error) {
    console.error("internal/session error:", error instanceof Error ? error.message : error);
    return json(
      {
        error: {
          message: error instanceof Error ? error.message : "session create failed",
          code: "composio_session_failed",
        },
      },
      502,
    );
  }
}

/** Refresh Bearer from a still-valid (or recently valid) token without new Composio user. */
async function handleInternalRefresh(request: Request, env: Env): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return json({ error: { message: "Unauthorized.", code: "unauthorized" } }, 401);
  }
  let body: { mcp_token?: string; ttl_seconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: { message: "Invalid JSON.", code: "invalid_json" } }, 400);
  }
  const priorToken = (body.mcp_token || "").trim();
  if (!priorToken) {
    return json({ error: { message: "mcp_token required.", code: "invalid_body" } }, 400);
  }
  const secret = sessionSecret(env);
  const now = Math.floor(Date.now() / 1000);
  // Accept tokens expired up to 7 days (long E2B idle) for re-mint only
  const claims = await verifySessionToken(secret, priorToken, now, 7 * 24 * 3600);
  if (!claims) {
    return json({ error: { message: "Invalid token; cannot refresh.", code: "unauthorized" } }, 401);
  }
  const ttl = body.ttl_seconds ?? sessionTtlSeconds(env);
  const token = await refreshSessionToken(secret, claims, ttl, now);
  const base = publicBase(request, env);
  return json({
    ok: true,
    user_id: claims.user_id,
    toolkits: claims.toolkits,
    composio_session_id: claims.composio_session_id,
    mcp_url: `${base}/mcp`,
    mcp_token: token,
    exp: now + ttl,
    ttl_seconds: ttl,
    refreshed: true,
    composio_mcp_url: claims.composio_mcp_url,
  });
}

async function handleInternalConnect(request: Request, env: Env): Promise<Response> {
  if (!requireInternalAuth(request, env)) {
    return json({ error: { message: "Unauthorized.", code: "unauthorized" } }, 401);
  }
  if (!env.COMPOSIO_API_KEY?.trim()) {
    return json({ error: { message: "COMPOSIO_API_KEY not configured.", code: "misconfigured" } }, 503);
  }

  let body: {
    user_id?: string;
    toolkit?: string;
    toolkits?: string[];
    callback_url?: string;
    composio_session_id?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: { message: "Invalid JSON.", code: "invalid_json" } }, 400);
  }

  const userId = (body.user_id || "").trim();
  // Canonicalize aliases (google_drive → googledrive) before allowlist membership
  const toolkit = canonicalizeToolkit(body.toolkit || "");
  if (!userId || !toolkit) {
    return json({ error: { message: "user_id and toolkit required.", code: "invalid_body" } }, 400);
  }

  const allowed = resolveToolkits(body.toolkits);
  if (!allowed.includes(toolkit)) {
    return json(
      { error: { message: `toolkit not in allowlist: ${toolkit}`, code: "toolkit_not_allowed" } },
      403,
    );
  }

  try {
    let sessionId = (body.composio_session_id || "").trim();
    if (!sessionId) {
      const session = await createToolRouterSession(env.COMPOSIO_API_KEY, userId, allowed);
      sessionId = session.session_id;
    }
    const link = await createToolkitLink(
      env.COMPOSIO_API_KEY,
      sessionId,
      toolkit,
      body.callback_url,
    );
    const redirectUrl = extractRedirectUrl(link);
    if (!redirectUrl) {
      return json(
        { error: { message: "Composio link missing redirect_url", code: "composio_link_failed", raw: link } },
        502,
      );
    }
    return json({
      ok: true,
      user_id: userId,
      toolkit,
      composio_session_id: sessionId,
      redirect_url: redirectUrl,
    });
  } catch (error) {
    console.error("internal/connect error:", error instanceof Error ? error.message : error);
    return json(
      {
        error: {
          message: error instanceof Error ? error.message : "connect failed",
          code: "composio_connect_failed",
        },
      },
      502,
    );
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) {
    return json({ error: { message: "Missing Bearer token.", code: "unauthorized" } }, 401);
  }
  let claims;
  try {
    claims = await verifySessionToken(sessionSecret(env), token);
  } catch {
    return json({ error: { message: "Session secret misconfigured.", code: "misconfigured" } }, 503);
  }
  if (!claims) {
    return json({ error: { message: "Invalid or expired session token.", code: "unauthorized" } }, 401);
  }
  if (!env.COMPOSIO_API_KEY?.trim()) {
    return json({ error: { message: "COMPOSIO_API_KEY not configured.", code: "misconfigured" } }, 503);
  }

  let mcpUrl = claims.composio_mcp_url;
  if (!mcpUrl) {
    // Re-create Composio session if token lacks URL (older tokens)
    try {
      const session = await createToolRouterSession(
        env.COMPOSIO_API_KEY,
        claims.user_id,
        claims.toolkits.length ? claims.toolkits : defaultToolkits(),
      );
      mcpUrl = session.mcp.url;
    } catch (error) {
      console.error("mcp re-session error:", error instanceof Error ? error.message : error);
      return json({ error: { message: "Failed to resolve Composio MCP.", code: "composio_session_failed" } }, 502);
    }
  }

  try {
    return await proxyToComposioMcp(request, mcpUrl, env.COMPOSIO_API_KEY);
  } catch (error) {
    console.error("mcp proxy error:", error instanceof Error ? error.message : error);
    return json({ error: { message: "Upstream MCP proxy failed.", code: "proxy_failed" } }, 502);
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return json({
      ok: true,
      service: "fromdonna-composio-proxy",
      default_toolkits: defaultToolkits(),
      auth: "session_hmac",
    });
  }

  if (request.method === "GET" && path === "/v1/toolkits/default") {
    return json({ toolkits: defaultToolkits() });
  }

  if (request.method === "POST" && path === "/internal/session") {
    return handleInternalSession(request, env);
  }

  if (request.method === "POST" && path === "/internal/session/refresh") {
    return handleInternalRefresh(request, env);
  }

  if (request.method === "POST" && path === "/internal/connect") {
    return handleInternalConnect(request, env);
  }

  // MCP endpoint (Hermes)
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    return handleMcp(request, env);
  }

  return json({ error: { message: "Not found.", code: "not_found" } }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("composio-proxy error:", error instanceof Error ? error.message : error);
      return json({ error: { message: "Internal error.", code: "internal_error" } }, 500);
    }
  },
};

// Re-exports for tests
export { defaultToolkits, resolveToolkits, canonicalizeToolkit } from "./toolkits";
export {
  mintSessionToken,
  verifySessionToken,
  refreshSessionToken,
  needsRefresh,
  bearerToken,
} from "./session_token";
export {
  DEFAULT_SESSION_TTL_SECONDS,
  sessionTtlSeconds,
  internalSecret,
  internalSecrets,
} from "./env";
