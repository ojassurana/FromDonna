export type Env = {
  /** Real Composio project API key — Worker secret only. */
  COMPOSIO_API_KEY: string;
  /**
   * HMAC secret for minting/verifying Hermes MCP session tokens.
   * Shared with gateway (mint) and this Worker (verify).
   * Prefer dedicated secret; may fall back to WORKER_TO_HARNESS_SECRET if set.
   */
  COMPOSIO_SESSION_SECRET?: string;
  WORKER_TO_HARNESS_SECRET?: string;
  /**
   * Shared secret for gateway → /internal/* calls.
   * Defaults to COMPOSIO_SESSION_SECRET / WORKER_TO_HARNESS_SECRET.
   */
  INTERNAL_AUTH_SECRET?: string;
  /** Public base URL of this Worker (no trailing slash), used in session responses. */
  PUBLIC_BASE_URL?: string;
  /** Default MCP token TTL seconds */
  SESSION_TTL_SECONDS?: string;
};

export function sessionSecret(env: Env): string {
  const s =
    (env.COMPOSIO_SESSION_SECRET || "").trim() ||
    (env.WORKER_TO_HARNESS_SECRET || "").trim();
  if (!s || s.length < 16) {
    throw new Error("COMPOSIO_SESSION_SECRET (or WORKER_TO_HARNESS_SECRET) missing/too short");
  }
  return s;
}

export function internalSecret(env: Env): string {
  const s =
    (env.INTERNAL_AUTH_SECRET || "").trim() ||
    (env.COMPOSIO_SESSION_SECRET || "").trim() ||
    (env.WORKER_TO_HARNESS_SECRET || "").trim();
  if (!s || s.length < 16) {
    throw new Error("INTERNAL_AUTH_SECRET missing/too short");
  }
  return s;
}

export function sessionTtlSeconds(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS || "3600");
  return Number.isFinite(n) && n >= 60 ? Math.floor(n) : 3600;
}
