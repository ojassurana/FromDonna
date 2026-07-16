/**
 * Gateway client for fromdonna-composio-proxy.
 * Ensures per-user Composio binding (D1) and mints short-lived MCP access for bootstrap.
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
  exp?: number;
};

function proxyBase(env: ComposioEnv): string {
  return (env.COMPOSIO_PROXY_URL || DEFAULT_COMPOSIO_PROXY).replace(/\/$/, "");
}

function internalAuth(env: ComposioEnv): string {
  return (env.COMPOSIO_SESSION_SECRET || env.WORKER_TO_HARNESS_SECRET || "").trim();
}

export async function loadUserToolkits(env: ComposioEnv, userId: string): Promise<string[] | null> {
  const row = await env.FROMDONNA_ROUTING.prepare(
    `SELECT toolkits_json FROM user_composio WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ toolkits_json: string }>();
  if (!row?.toolkits_json) return null;
  try {
    const parsed = JSON.parse(row.toolkits_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    /* fall through */
  }
  return null;
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

/**
 * Mint short-lived MCP access for Hermes via composio-proxy.
 * Soft-fails (returns null) if proxy is unreachable — gateway bootstrap still succeeds.
 */
export async function mintComposioMcpAccess(
  env: ComposioEnv,
  userId: string,
  runtimeId?: string,
): Promise<ComposioMcpAccess | null> {
  const auth = internalAuth(env);
  if (!auth || auth.length < 16) {
    console.error("composio: missing COMPOSIO_SESSION_SECRET / WORKER_TO_HARNESS_SECRET");
    return null;
  }

  let toolkits = await loadUserToolkits(env, userId);
  if (!toolkits) {
    toolkits = await ensureUserComposio(env, userId);
  }

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
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`composio session mint HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as {
      mcp_url?: string;
      mcp_token?: string;
      toolkits?: string[];
      user_id?: string;
      composio_session_id?: string;
      exp?: number;
    };
    if (!data.mcp_url || !data.mcp_token) {
      console.error("composio session mint: missing mcp_url/mcp_token");
      return null;
    }
    return {
      mcp_url: data.mcp_url,
      mcp_token: data.mcp_token,
      toolkits: data.toolkits || toolkits,
      user_id: data.user_id || userId,
      composio_session_id: data.composio_session_id,
      exp: data.exp,
    };
  } catch (error) {
    console.error(
      "composio session mint error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
