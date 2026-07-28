/**
 * Direct-provider fallback for the OAuth relay.
 *
 * Both adapters normally send traffic to the private host relay, which resolves
 * Hermes's OAuth credential per request (see codex.ts / grok.ts). That relay is
 * a single point of failure: if the tunnel is down or the OAuth plan is out of
 * quota, every turn fails and the agent goes silent.
 *
 * When a provider API key is configured on this Worker, a relay failure is
 * retried once against the provider's own public API. The request body and the
 * response parsing are unchanged — only the transport differs.
 *
 * Fallback is opt-in per provider: with no key configured, the original relay
 * error propagates exactly as before.
 */

/**
 * Is this relay failure worth retrying on the direct provider API?
 *
 * Yes for "the relay itself is the problem":
 *   5xx      relay/tunnel down, or upstream broken
 *   429      OAuth plan out of quota or rate limited  <- "runs out"
 *   401/403  relay rejected us, or its OAuth credential expired
 *   408      relay timed out
 *
 * No for 4xx request errors (400, 404, 422, …): the request itself is bad, so
 * the direct API would reject it identically and we'd burn the API key for
 * nothing. Those must surface to the caller unchanged.
 */
export function isRelayFailure(status: number): boolean {
  if (status >= 500) return true;
  return status === 429 || status === 401 || status === 403 || status === 408;
}

/** Status used when the relay never answered (tunnel down, DNS, TLS). */
export const RELAY_UNREACHABLE = 503;

/**
 * Some relays answer HTTP 200 with an error envelope in the body instead of a
 * real status code — grok.ts has carried a note about this for a while. A quota
 * error hidden that way would never reach isRelayFailure(), so the fallback
 * would silently not fire on exactly the case it exists for.
 *
 * Returns the status this response should be treated as, or null when the body
 * carries no error envelope at all.
 */
export function embeddedErrorStatus(raw: string): number | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const fields = error as Record<string, unknown>;

  // Prefer an explicit numeric status the upstream already handed us.
  for (const key of ["status", "status_code", "code"]) {
    const value = fields[key];
    if (typeof value === "number" && value >= 400 && value <= 599) return value;
  }

  const text = [fields.message, fields.type, fields.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  // Check request-shape errors FIRST: the direct API would reject these
  // identically, so they must not spend the API key.
  if (/invalid.?request|malformed|unsupported|bad.?request|does not exist|not.?found/.test(text)) return 400;
  // Quota/rate exhaustion is the case this whole feature exists for.
  if (/quota|rate.?limit|rate_limit|insufficient|exceeded|too many|billing|credit/.test(text)) return 429;
  if (/unauthor|forbidden|invalid.?api.?key|expired|revoked/.test(text)) return 401;

  // Unrecognized envelope: treat as an upstream failure worth one retry.
  return 502;
}

/**
 * Structured log so relay health is visible in `wrangler tail`. Fallback firing
 * is an incident, not routine — it means the primary credential path is broken.
 */
export function logFallback(fields: {
  provider: "codex" | "grok";
  stage: "relay_failed" | "fallback_ok" | "fallback_failed" | "no_fallback_configured";
  status: number;
  model: string;
  detail?: unknown;
}): void {
  const detail =
    fields.detail instanceof Error
      ? fields.detail.message
      : typeof fields.detail === "string"
        ? fields.detail.slice(0, 500)
        : undefined;
  console.error(
    JSON.stringify({
      msg: "llm_proxy_fallback",
      provider: fields.provider,
      stage: fields.stage,
      status: fields.status,
      model: fields.model,
      ...(detail ? { detail } : {}),
    }),
  );
}
