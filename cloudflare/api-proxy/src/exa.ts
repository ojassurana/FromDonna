/**
 * Transparent Exa API reverse proxy for Hermes exa-py (base_url override).
 *
 * Sandbox:  Exa(api_key="STUB", base_url="https://…/v1/exa")
 * Worker:   validates stub → rewrites x-api-key → https://api.exa.ai/{search|contents}
 *
 * TODO: replace stub auth with real short-lived capability HMAC (like llm-proxy).
 */

import type { Env } from "./env";
import { EXA_UPSTREAM, stubToken } from "./env";

const ALLOWED_PATHS = new Set(["/search", "/contents"]);

function jsonError(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

/**
 * Extract the credential the sandbox presented.
 * Supports x-api-key (exa-py default) and Authorization: Bearer …
 */
export function presentedCredential(request: Request): string | null {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey) return xApiKey;
  const auth = request.headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i)?.[1]?.trim();
  return bearer || null;
}

/** Return true when the sandbox credential matches the MVP stub. */
export function validStubAuth(env: Env, request: Request): boolean {
  // TODO: real capability HMAC verification (gateway-minted, api-proxy-verified).
  const presented = presentedCredential(request);
  if (!presented) return false;
  const expected = stubToken(env);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Map request path under /v1/exa/* to upstream Exa path.
 * Returns null if path is not allowed.
 */
export function upstreamPath(pathname: string): string | null {
  const prefix = "/v1/exa";
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.slice(prefix.length) || "/";
  const normalized = rest.startsWith("/") ? rest : `/${rest}`;
  if (!ALLOWED_PATHS.has(normalized)) return null;
  return normalized;
}

/**
 * Proxy one Exa API call. Caller must already have verified stub auth.
 */
export async function proxyExa(
  request: Request,
  env: Env,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const key = (env.EXA_API_KEY || "").trim();
  if (!key) {
    return jsonError(503, "Exa is not configured on the API proxy.", "exa_not_configured");
  }

  const method = request.method.toUpperCase();
  if (method !== "POST") {
    return jsonError(405, "Only POST is supported for Exa routes.", "method_not_allowed");
  }

  const body = await request.arrayBuffer();
  const upstreamUrl = `${EXA_UPSTREAM}${path}`;

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") || "application/json",
        "x-api-key": key,
        "user-agent": "fromdonna-api-proxy/0.1",
        "x-exa-integration": "fromdonna-api-proxy",
      },
      body: body.byteLength ? body : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream_fetch_failed";
    return jsonError(502, `Exa upstream unreachable: ${message}`, "exa_upstream_error");
  }

  // Pass through status + body; do not forward hop-by-hop / secret headers.
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Route handler for /v1/exa/* */
export async function handleExaRequest(
  request: Request,
  env: Env,
  pathname: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!validStubAuth(env, request)) {
    return jsonError(401, "A valid API stub token is required.", "invalid_stub_token");
  }
  const path = upstreamPath(pathname);
  if (!path) {
    return jsonError(404, "Exa path not found. Allowed: /v1/exa/search, /v1/exa/contents.", "not_found");
  }
  return proxyExa(request, env, path, fetchImpl);
}
