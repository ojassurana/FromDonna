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
  /** Service binding — preferred; avoids CF 1042 on workers.dev Worker→Worker fetch */
  COMPOSIO_PROXY?: Fetcher;
};

const DEFAULT_COMPOSIO_PROXY = "https://fromdonna-composio-proxy.code-df4.workers.dev";

/** Fetch composio-proxy via service binding when available (same-account Worker). */
async function proxyFetch(env: ComposioEnv, path: string, init: RequestInit): Promise<Response> {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (env.COMPOSIO_PROXY) {
    // Service binding requires an absolute URL host; path/query is what the target sees.
    return env.COMPOSIO_PROXY.fetch(new Request(`https://composio-proxy.internal${p}`, init));
  }
  const base = proxyBase(env);
  return fetch(`${base}${p}`, init);
}

/** Keep in sync with cloudflare/composio-proxy/src/toolkits.ts (Composio Tool Router slugs). */
export const DEFAULT_COMPOSIO_TOOLKITS = [
  // Google Workspace
  "gmail",
  "googledrive",
  "googlecalendar",
  "googlesheets",
  "googledocs",
  "googleslides",
  "googlemeet",
  "googletasks",
  "googlecontacts",
  "googleforms",
  "googlephotos",
  "google_chat",
  // Microsoft 365
  "outlook",
  "one_drive",
  "excel",
  "microsoft_teams",
  "onenote",
  "share_point",
  // Other product apps
  "github",
  "linkedin",
  "dropbox",
  "dropbox_sign",
] as const;

/**
 * Aliases → canonical Composio slug.
 * Keep in sync with cloudflare/composio-proxy/src/toolkits.ts TOOLKIT_ALIASES.
 */
const TOOLKIT_ALIASES: Record<string, string> = {
  google_drive: "googledrive",
  google_drive_api: "googledrive",
  "google-drive": "googledrive",
  drive: "googledrive",
  gdrive: "googledrive",

  google_calendar: "googlecalendar",
  "google-calendar": "googlecalendar",
  calendar: "googlecalendar",

  google_sheets: "googlesheets",
  "google-sheets": "googlesheets",
  sheets: "googlesheets",

  google_docs: "googledocs",
  "google-docs": "googledocs",
  docs: "googledocs",

  google_slides: "googleslides",
  "google-slides": "googleslides",
  slides: "googleslides",

  google_meet: "googlemeet",
  "google-meet": "googlemeet",
  meet: "googlemeet",

  google_tasks: "googletasks",
  "google-tasks": "googletasks",
  tasks: "googletasks",

  google_contacts: "googlecontacts",
  "google-contacts": "googlecontacts",
  contacts: "googlecontacts",

  google_forms: "googleforms",
  "google-forms": "googleforms",
  forms: "googleforms",

  google_photos: "googlephotos",
  "google-photos": "googlephotos",
  photos: "googlephotos",

  googlechat: "google_chat",
  "google-chat": "google_chat",
  chat: "google_chat",

  onedrive: "one_drive",
  "one-drive": "one_drive",

  teams: "microsoft_teams",
  "microsoft-teams": "microsoft_teams",
  ms_teams: "microsoft_teams",

  sharepoint: "share_point",
  "share-point": "share_point",

  "one-note": "onenote",
  one_note: "onenote",

  dropboxsign: "dropbox_sign",
  "dropbox-sign": "dropbox_sign",
};

/** Normalize common alias / marketing names to canonical Composio Tool Router slugs. */
export function canonicalizeToolkit(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return "";
  return TOOLKIT_ALIASES[t] || t;
}

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

/** Last mint failure reason (for bootstrap error messages). Cleared on success. */
let lastMintError = "";

export function getLastComposioMintError(): string {
  return lastMintError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Mint production-duration (default 30d) MCP access for Hermes via composio-proxy.
 * Reuses sticky Composio session when D1 has one (same user forever).
 * Returns null on failure (never throws). Callers decide hard vs soft:
 *   - bootstrapHarness({ requireComposio: true })  → provision/replace fails
 *   - bootstrapHarness({ requireComposio: false }) → inject continues without Composio
 */
export async function mintComposioMcpAccess(
  env: ComposioEnv,
  userId: string,
  runtimeId?: string,
  opts?: { forceNewComposioSession?: boolean },
): Promise<ComposioMcpAccess | null> {
  const auth = internalAuth(env);
  if (!auth || auth.length < 16) {
    lastMintError = "missing COMPOSIO_SESSION_SECRET / WORKER_TO_HARNESS_SECRET (len<16)";
    console.error("composio:", lastMintError);
    return null;
  }

  let stored = await loadUserComposio(env, userId);
  if (!stored) {
    await ensureUserComposio(env, userId);
    stored = await loadUserComposio(env, userId);
  }
  const toolkits = stored?.toolkits ?? [...DEFAULT_COMPOSIO_TOOLKITS];

  // Retry transient upstream failures (Composio 429 → proxy 502).
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Send both header styles so proxy multi-secret auth always sees a match.
      // Prefer service binding (COMPOSIO_PROXY) — public workers.dev fetch → CF 1042.
      const res = await proxyFetch(env, "/internal/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fromdonna-internal": auth,
          Authorization: `Bearer ${auth}`,
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
        const snippet = detail.slice(0, 220);
        // 401 is internal-auth failure — force-new cannot fix a secret mismatch.
        if (res.status === 401) {
          lastMintError = `mint HTTP 401 secret mismatch gateway→proxy (auth_len=${auth.length}): ${snippet}`;
          console.error("composio", lastMintError);
          return null;
        }
        // Sticky session may be dead — retry with force new once when we had a sticky id.
        if (!opts?.forceNewComposioSession && stored?.sessionId) {
          console.error(`composio session mint HTTP ${res.status}, retrying force new: ${snippet}`);
          return mintComposioMcpAccess(env, userId, runtimeId, { forceNewComposioSession: true });
        }
        // Rate limit / upstream flakiness — backoff and retry.
        if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < maxAttempts - 1) {
          lastMintError = `mint HTTP ${res.status} attempt ${attempt + 1}: ${snippet}`;
          console.error("composio", lastMintError, "— backing off");
          await sleep(800 * (attempt + 1) * (attempt + 1));
          continue;
        }
        lastMintError = `mint HTTP ${res.status}: ${snippet}`;
        console.error("composio session", lastMintError);
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
        lastMintError = "mint ok but missing mcp_url/mcp_token";
        console.error("composio session", lastMintError);
        return null;
      }
      if (data.composio_session_id && data.composio_mcp_url) {
        await persistComposioSession(env, userId, data.composio_session_id, data.composio_mcp_url).catch(
          (e) => console.error("composio persist session failed:", e),
        );
      }
      lastMintError = "";
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
      lastMintError = `mint fetch error: ${error instanceof Error ? error.message : String(error)}`;
      console.error("composio session", lastMintError);
      if (attempt < maxAttempts - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
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
  // Canonicalize aliases (google_drive → googledrive, etc.) before allowlist check —
  // matches composio-proxy resolveToolkits / canonicalizeToolkit.
  const tk = canonicalizeToolkit(toolkit);
  if (!tk || !toolkits.includes(tk)) {
    console.error(`composio connect: toolkit not allowed: ${toolkit.trim().toLowerCase()} (canonical: ${tk || "(empty)"})`);
    return null;
  }

  try {
    const res = await proxyFetch(env, "/internal/connect", {
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
