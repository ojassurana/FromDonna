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

/**
 * All secrets accepted for gateway → /internal/* auth.
 * Match against ANY configured candidate (≥16 chars) so proxy
 * INTERNAL_AUTH_SECRET ≠ gateway COMPOSIO_SESSION_SECRET does not 401 forever.
 * Order preserved; duplicates removed. sessionSecret chain is separate.
 */
export function internalSecrets(env: Env): string[] {
  const raw = [
    (env.INTERNAL_AUTH_SECRET || "").trim(),
    (env.COMPOSIO_SESSION_SECRET || "").trim(),
    (env.WORKER_TO_HARNESS_SECRET || "").trim(),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (s.length >= 16 && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  if (out.length === 0) {
    throw new Error("INTERNAL_AUTH_SECRET missing/too short");
  }
  return out;
}

/** First configured internal secret (single-secret helper / diagnostics). */
export function internalSecret(env: Env): string {
  return internalSecrets(env)[0];
}

/** Production default: 30 days — covers long-lived E2B pause/resume without hourly death. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 3600;

export function sessionTtlSeconds(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS || String(DEFAULT_SESSION_TTL_SECONDS));
  // Floor 1h so misconfig never goes sub-hour; ceiling 90d
  if (!Number.isFinite(n)) return DEFAULT_SESSION_TTL_SECONDS;
  return Math.min(90 * 24 * 3600, Math.max(3600, Math.floor(n)));
}
