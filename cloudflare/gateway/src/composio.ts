/**
 * Gateway client for fromdonna-composio-proxy.
 * Ensures per-user Composio binding (D1) and mints production-duration MCP access for bootstrap.
 */

export type ComposioEnv = {
  FROMDONNA_ROUTING: D1Database;
  WORKER_TO_HARNESS_SECRET: string;
  /** Optional dedicated secret; falls back to WORKER_TO_HARNESS_SECRET */
  COMPOSIO_SESSION_SECRET?: string;
  COMPOSIO_PROXY_URL?: string;
};

const DEFAULT_COMPOSIO_PROXY = "https://fromdonna-composio-proxy.code-df4.workers.dev";

/** Keep in sync with cloudflare/composio-proxy/src/toolkits.ts */
export const DEFAULT_COMPOSIO_TOOLKITS = [
  "gmail",
  "google_drive",
  "google_calendar",
  "google_sheets",
  "google_docs",
  "github",
  "notion",
  "linkedin",
  "dropbox",
  "onedrive",
  "sharepoint",
  "docusign",
  "strava",
  "splitwise",
  "outlook",
  "dropbox_sign",
] as const;

export type ComposioMcpAccess = {
  mcp_url: string;
  mcp_token: string;
  toolkits: string[];
  user_id: string;
  composio_session_id?: string;
  composio_mcp_url?: string;
  exp?: number;
  ttl_seconds?: number;
  reused_composio_session?: boolean;
};

type UserComposioRow = {
  toolkits_json: string;
  composio_session_id: string | null;
  composio_mcp_url: string | null;
};

function proxyBase(env: ComposioEnv): string {
  return (env.COMPOSIO_PROXY_URL || DEFAULT_COMPOSIO_PROXY).replace(/\/$/, "");
}

function internalAuth(env: ComposioEnv): string {
  return (env.COMPOSIO_SESSION_SECRET || env.WORKER_TO_HARNESS_SECRET || "").trim();
}

export async function loadUserComposio(
  env: ComposioEnv,
  userId: string,
): Promise<{ toolkits: string[]; sessionId?: string; mcpUrl?: string } | null> {
  const row = await env.FROMDONNA_ROUTING.prepare(
    `SELECT toolkits_json, composio_session_id, composio_mcp_url FROM user_composio WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<UserComposioRow>();
  if (!row?.toolkits_json) return null;
  try {
    const parsed = JSON.parse(row.toolkits_json) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) return null;
    return {
      toolkits: parsed as string[],
      sessionId: row.composio_session_id || undefined,
      mcpUrl: row.composio_mcp_url || undefined,
    };
  } catch {
    return null;
  }
}

export async function loadUserToolkits(env: ComposioEnv, userId: string): Promise<string[] | null> {
  const row = await loadUserComposio(env, userId);
  return row?.toolkits ?? null;
}

export async function ensureUserComposio(
  env: ComposioEnv,
  userId: string,
  toolkits: string[] = [...DEFAULT_COMPOSIO_TOOLKITS],
): Promise<string[]> {
  const existing = await loadUserToolkits(env, userId);
  if (existing) return existing;

  const toolkitsJson = JSON.stringify(toolkits);
  await env.FROMDONNA_ROUTING.prepare(
    `INSERT INTO user_composio (user_id, toolkits_json, composio_ready, created_at, updated_at)
     VALUES (?1, ?2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       toolkits_json = excluded.toolkits_json,
       composio_ready = 1,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(userId, toolkitsJson)
    .run();
  return toolkits;
}

async function persistComposioSession(
  env: ComposioEnv,
  userId: string,
  sessionId: string,
  mcpUrl: string,
): Promise<void> {
  await env.FROMDONNA_ROUTING.prepare(
    `UPDATE user_composio
     SET composio_session_id = ?2, composio_mcp_url = ?3, composio_ready = 1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?1`,
  )
    .bind(userId, sessionId, mcpUrl)
    .run();
}

/**
 * Mint production-duration MCP access for Hermes via composio-proxy.
 * Reuses sticky Composio session when D1 has one (same user forever).
 * Soft-fails (returns null) if proxy is unreachable — gateway bootstrap still succeeds.
 */
export async function mintComposioMcpAccess(
  env: ComposioEnv,
  userId: string,
  runtimeId?: string,
  opts?: { forceNewComposioSession?: boolean },
): Promise<ComposioMcpAccess | null> {
  const auth = internalAuth(env);
  if (!auth || auth.length < 16) {
    console.error("composio: missing COMPOSIO_SESSION_SECRET / WORKER_TO_HARNESS_SECRET");
    return null;
  }

  let stored = await loadUserComposio(env, userId);
  if (!stored) {
    await ensureUserComposio(env, userId);
    stored = await loadUserComposio(env, userId);
  }
  const toolkits = stored?.toolkits ?? [...DEFAULT_COMPOSIO_TOOLKITS];

  try {
    const res = await fetch(`${proxyBase(env)}/internal/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth}`,
        "x-fromdonna-internal": auth,
      },
      body: JSON.stringify({
        user_id: userId,
        toolkits,
        runtime_id: runtimeId,
        force_new_composio_session: !!opts?.forceNewComposioSession,
        ...(stored?.sessionId && stored?.mcpUrl && !opts?.forceNewComposioSession
          ? {
              composio_session_id: stored.sessionId,
              composio_mcp_url: stored.mcpUrl,
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Sticky session may be dead — retry with force new once
      if (!opts?.forceNewComposioSession && stored?.sessionId) {
        console.error(`composio session mint HTTP ${res.status}, retrying force new: ${detail.slice(0, 150)}`);
        return mintComposioMcpAccess(env, userId, runtimeId, { forceNewComposioSession: true });
      }
      console.error(`composio session mint HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      mcp_url?: string;
      mcp_token?: string;
      toolkits?: string[];
      user_id?: string;
      composio_session_id?: string;
      composio_mcp_url?: string;
      exp?: number;
      ttl_seconds?: number;
      reused_composio_session?: boolean;
    };
    if (!data.mcp_url || !data.mcp_token) {
      console.error("composio session mint: missing mcp_url/mcp_token");
      return null;
    }
    if (data.composio_session_id && data.composio_mcp_url) {
      await persistComposioSession(env, userId, data.composio_session_id, data.composio_mcp_url).catch(
        (e) => console.error("composio persist session failed:", e),
      );
    }
    return {
      mcp_url: data.mcp_url,
      mcp_token: data.mcp_token,
      toolkits: data.toolkits || toolkits,
      user_id: data.user_id || userId,
      composio_session_id: data.composio_session_id,
      composio_mcp_url: data.composio_mcp_url,
      exp: data.exp,
      ttl_seconds: data.ttl_seconds,
      reused_composio_session: data.reused_composio_session,
    };
  } catch (error) {
    console.error(
      "composio session mint error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Mint Composio Connect / login URL for an allowed toolkit. */
export async function mintComposioConnectLink(
  env: ComposioEnv,
  userId: string,
  toolkit: string,
  callbackUrl?: string,
): Promise<{ redirect_url: string; toolkit: string } | null> {
  const auth = internalAuth(env);
  if (!auth || auth.length < 16) return null;

  let stored = await loadUserComposio(env, userId);
  if (!stored) {
    await ensureUserComposio(env, userId);
    stored = await loadUserComposio(env, userId);
  }
  const toolkits = stored?.toolkits ?? [...DEFAULT_COMPOSIO_TOOLKITS];
  const tk = toolkit.trim().toLowerCase();
  if (!toolkits.includes(tk)) {
    console.error(`composio connect: toolkit not allowed: ${tk}`);
    return null;
  }

  try {
    const res = await fetch(`${proxyBase(env)}/internal/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth}`,
        "x-fromdonna-internal": auth,
      },
      body: JSON.stringify({
        user_id: userId,
        toolkit: tk,
        toolkits,
        callback_url: callbackUrl,
        composio_session_id: stored?.sessionId,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`composio connect HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      redirect_url?: string;
      toolkit?: string;
      composio_session_id?: string;
    };
    if (!data.redirect_url) return null;
    return { redirect_url: data.redirect_url, toolkit: data.toolkit || tk };
  } catch (error) {
    console.error("composio connect error:", error instanceof Error ? error.message : error);
    return null;
  }
}
