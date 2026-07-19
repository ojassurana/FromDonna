/**
 * Hermes → composio-proxy capability tokens (HMAC-SHA256 over payload).
 * Production default TTL is 30 days (see env.sessionTtlSeconds) — not a short-lived
 * per-turn nonce. Secret never leaves Workers.
 */

export type SessionClaims = {
  user_id: string;
  toolkits: string[];
  runtime_id?: string;
  /** Composio tool-router session id (trs_…) when known */
  composio_session_id?: string;
  /** Hosted Composio MCP URL for this session */
  composio_mcp_url?: string;
  exp: number; // unix seconds
};

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintSessionToken(
  secret: string,
  claims: Omit<SessionClaims, "exp"> & { exp?: number; ttlSeconds?: number },
): Promise<string> {
  const ttl = claims.ttlSeconds ?? 3600;
  const exp = claims.exp ?? Math.floor(Date.now() / 1000) + ttl;
  const payload: SessionClaims = {
    user_id: claims.user_id,
    toolkits: claims.toolkits,
    runtime_id: claims.runtime_id,
    composio_session_id: claims.composio_session_id,
    composio_mcp_url: claims.composio_mcp_url,
    exp,
  };
  const body = b64urlJson(payload);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  /** Accept tokens expired by up to this many seconds (for refresh). */
  allowExpiredSeconds = 0,
): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigB64] = parts as [string, string];
  if (!body || !sigB64) return null;
  const key = await hmacKey(secret);
  // reconstruct signature bytes from b64url
  const pad = "=".repeat((4 - (sigB64.length % 4)) % 4);
  const sigBin = atob(sigB64.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const sigBytes = new Uint8Array(sigBin.length);
  for (let i = 0; i < sigBin.length; i++) sigBytes[i] = sigBin.charCodeAt(i);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!ok) return null;
  try {
    const pad2 = "=".repeat((4 - (body.length % 4)) % 4);
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/") + pad2);
    const claims = JSON.parse(json) as SessionClaims;
    if (!claims.user_id || !Array.isArray(claims.toolkits)) return null;
    if (typeof claims.exp !== "number") return null;
    if (claims.exp + allowExpiredSeconds < nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const h = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Re-mint a token from prior claims (same user/toolkits/composio urls), new exp.
 * Used for production refresh without recreating Composio identity.
 */
export async function refreshSessionToken(
  secret: string,
  prior: SessionClaims,
  ttlSeconds = 30 * 24 * 3600,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return mintSessionToken(secret, {
    user_id: prior.user_id,
    toolkits: prior.toolkits,
    runtime_id: prior.runtime_id,
    composio_session_id: prior.composio_session_id,
    composio_mcp_url: prior.composio_mcp_url,
    exp: nowSeconds + ttlSeconds,
  });
}

/** True if token expires within `withinSeconds` (default 24h). */
export function needsRefresh(
  claims: SessionClaims,
  withinSeconds = 24 * 3600,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return claims.exp - nowSeconds < withinSeconds;
}
