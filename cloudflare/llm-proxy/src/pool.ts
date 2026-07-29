/**
 * Endpoint pool: how the proxy survives more users than one credential can serve.
 *
 * A single API key is a throughput ceiling, not just a failure risk. Rate limits
 * on the major providers are scoped to the *organization*, not the key, so extra
 * keys on one account buy nothing. Real capacity comes from independent quota
 * pools, which in practice means several providers. Everything here is therefore
 * provider-agnostic: an entry is a URL, a credential name, and a wire format.
 *
 * Selection has three layers:
 *
 *   1. `order` tiers   Lowest order wins outright. The subscription-priced OAuth
 *                      relay sits at order 1 so we never pay per token for
 *                      capacity we already have. Paid endpoints are order 2+ and
 *                      are only reached when the tier above is down or throttled.
 *
 *   2. sticky hash     Within a tier, the entry is chosen by hashing a stable
 *                      routing key (the caller's id). Donna is an agent, so a
 *                      conversation that changes model mid-task changes reasoning
 *                      style and tool-call formatting mid-task. Hashing keeps one
 *                      caller on one endpoint without any shared state, while
 *                      still spreading different callers evenly.
 *
 *   3. weight          Higher weight claims a proportionally larger slice of the
 *                      hash space, so traffic tracks each endpoint's real quota.
 *
 * Deliberately absent: request counters. Workers keep no memory between requests,
 * and Workers KV is capped at one write per second per key and is eventually
 * consistent, so concurrent increments are silently lost. Usage-based routing
 * needs a Durable Object; it is not built here. Cooldowns are the inverse
 * workload — written only on failure, tolerant of staleness — which is what KV
 * is actually good at.
 */

import { isRelayFailure } from "./fallback";
import { ChatCompletionRequestError } from "./openai";

export type WireFormat = "responses" | "chat_completions";

export type PoolEntry = {
  /** Stable identifier, used as the cooldown key. Must be unique in the pool. */
  id: string;
  /** Interchangeable set this entry belongs to, e.g. "codex" or "grok". */
  group: string;
  /** `relay` uses the OAuth relay transport; `direct` uses base + credential. */
  kind: "relay" | "direct";
  /** Lower wins outright. Tier 1 is tried before tier 2 regardless of weight. */
  order: number;
  /** Share of its tier's traffic. Relative, not absolute. */
  weight: number;
  /** Direct only: origin + version prefix, e.g. https://api.openai.com/v1 */
  base?: string;
  /** Direct only: request/response shape to speak. */
  wire?: WireFormat;
  /** Direct only: *name* of the Worker secret holding the key, never the key. */
  keyVar?: string;
  /** Model id to send upstream. Unset = forward whatever the caller asked for. */
  model?: string;
};

/** Cooldowns are read per request, so the binding stays optional. */
type CooldownStore = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };

export type PoolEnv = Record<string, unknown> & {
  LLM_POOL?: string;
  POOL_STATE?: CooldownStore;
  CODEX_TOKENS?: CooldownStore;
};

export type PoolAttemptResult = {
  status: number;
  raw: string;
  headers?: { get(name: string): string | null };
};

export type PoolOutcome = PoolAttemptResult & { entry: PoolEntry; attempts: number };

/**
 * FNV-1a. Chosen for being stable across isolates and deployments — the routing
 * decision must not change just because the request landed elsewhere. A crypto
 * hash would be needless CPU on the hot path; this is not a security boundary.
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Reject malformed entries loudly at parse time rather than mid-request. */
function toEntry(raw: unknown, index: number): PoolEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" && source.id ? source.id : `entry_${index}`;
  const group = typeof source.group === "string" && source.group ? source.group : "";
  if (!group) return null;

  const kind = source.kind === "relay" ? "relay" : "direct";
  const entry: PoolEntry = {
    id,
    group,
    kind,
    order: asPositiveInt(source.order, 1),
    weight: asPositiveInt(source.weight, 1),
  };

  if (kind === "direct") {
    // A direct entry without somewhere to send or something to authenticate
    // with is unusable; dropping it beats failing every request that picks it.
    if (typeof source.base !== "string" || !source.base) return null;
    if (typeof source.keyVar !== "string" || !source.keyVar) return null;
    entry.base = source.base.replace(/\/+$/, "");
    entry.keyVar = source.keyVar;
    entry.wire = source.wire === "responses" ? "responses" : "chat_completions";
  }
  if (typeof source.model === "string" && source.model) entry.model = source.model;
  return entry;
}

/** Trailing-slash tolerant suffix strip, used to turn a full endpoint into a base. */
function stripSuffix(url: string, suffix: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

/**
 * Back-compat shape. With no LLM_POOL configured this reproduces the previous
 * single-key fallback exactly: relay first, then one direct endpoint per
 * provider if its key happens to be set, still honouring the *_URL overrides.
 * Adding the pool must not change the behaviour of a deployment that has not
 * opted into it.
 */
function legacyPool(env: PoolEnv, group: string): PoolEntry[] {
  const entries: PoolEntry[] = [{ id: `${group}-relay`, group, kind: "relay", order: 1, weight: 1 }];
  const legacy: Record<string, { keyVar: string; urlVar: string; base: string; path: string; wire: WireFormat; modelVar: string }> = {
    codex: { keyVar: "OPENAI_API_KEY", urlVar: "OPENAI_RESPONSES_URL", base: "https://api.openai.com/v1", path: "/responses", wire: "responses", modelVar: "OPENAI_FALLBACK_MODEL" },
    grok: { keyVar: "XAI_API_KEY", urlVar: "XAI_CHAT_COMPLETIONS_URL", base: "https://api.x.ai/v1", path: "/chat/completions", wire: "chat_completions", modelVar: "XAI_FALLBACK_MODEL" },
  };
  const spec = legacy[group];
  if (spec && typeof env[spec.keyVar] === "string" && env[spec.keyVar]) {
    const model = env[spec.modelVar];
    const override = env[spec.urlVar];
    entries.push({
      id: `${group}-direct`,
      group,
      kind: "direct",
      order: 2,
      weight: 1,
      base: typeof override === "string" && override ? stripSuffix(override, spec.path) : spec.base,
      wire: spec.wire,
      keyVar: spec.keyVar,
      ...(typeof model === "string" && model ? { model } : {}),
    });
  }
  return entries;
}

/**
 * Parse LLM_POOL for one interchangeable group. Config lives in a plain var so
 * the topology is reviewable in git and changeable without a code deploy; only
 * the credentials are secrets, referenced by name.
 */
export function parsePool(env: PoolEnv, group: string): PoolEntry[] {
  if (typeof env.LLM_POOL !== "string" || !env.LLM_POOL.trim()) return legacyPool(env, group);
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.LLM_POOL);
  } catch {
    // Malformed config must not take the proxy down; fall back to the relay.
    console.error(JSON.stringify({ msg: "llm_pool_parse_failed", group }));
    return legacyPool(env, group);
  }
  if (!Array.isArray(parsed)) return legacyPool(env, group);

  const seen = new Set<string>();
  const entries: PoolEntry[] = [];
  parsed.forEach((raw, index) => {
    const entry = toEntry(raw, index);
    if (!entry || entry.group !== group) return;
    // Duplicate ids would share a cooldown key and mask each other's health.
    if (seen.has(entry.id)) return;
    // A direct entry whose secret is missing is configuration drift, not a
    // runtime condition — skip it rather than sending an unauthenticated call.
    if (entry.kind === "direct" && !(typeof env[entry.keyVar as string] === "string" && env[entry.keyVar as string])) return;
    seen.add(entry.id);
    entries.push(entry);
  });

  return entries.length ? entries : legacyPool(env, group);
}

/**
 * Full candidate list, best first: tier by tier, and within a tier the sticky
 * weighted pick first followed by the remaining entries in config order. The
 * tail matters — it is the retry path when the sticky choice fails.
 */
export function orderedCandidates(entries: PoolEntry[], routingKey: string): PoolEntry[] {
  const tiers = [...new Set(entries.map((entry) => entry.order))].sort((a, b) => a - b);
  const out: PoolEntry[] = [];
  for (const tier of tiers) {
    const members = entries.filter((entry) => entry.order === tier);
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    const total = members.reduce((sum, entry) => sum + entry.weight, 0);
    let cursor = fnv1a32(`${routingKey}:${tier}`) % total;
    let index = 0;
    for (let i = 0; i < members.length; i += 1) {
      if (cursor < members[i].weight) {
        index = i;
        break;
      }
      cursor -= members[i].weight;
    }
    out.push(...members.slice(index), ...members.slice(0, index));
  }
  return out;
}

function parseResetDuration(value: string): number | null {
  // Providers report resets as "6s", "1m30s", "250ms".
  const match = value.trim().match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = match[2] ? Number(match[2]) : 0;
  const millis = match[3] ? Number(match[3]) : 0;
  const total = minutes * 60 + seconds + millis / 1000;
  return total > 0 ? Math.ceil(total) : null;
}

/**
 * How long to stop sending to an endpoint. The provider already knows the
 * answer and puts it in the response, so read it rather than guessing: blind
 * fixed backoff either wastes capacity or keeps hammering a limit, and failed
 * requests still count against the quota.
 */
export function cooldownSeconds(status: number, headers?: { get(name: string): string | null }, body?: string): number {
  const clamp = (value: number) => Math.min(900, Math.max(1, Math.ceil(value)));

  const retryAfterMs = headers?.get("retry-after-ms");
  if (retryAfterMs && Number.isFinite(Number(retryAfterMs))) return clamp(Number(retryAfterMs) / 1000);

  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    if (Number.isFinite(Number(retryAfter))) return clamp(Number(retryAfter));
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return clamp((asDate - Date.now()) / 1000);
  }

  for (const header of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = headers?.get(header);
    const parsed = value ? parseResetDuration(value) : null;
    if (parsed) return clamp(parsed);
  }

  // `rate_limit_exceeded` and `insufficient_quota` are both HTTP 429 but mean
  // opposite things: one clears in seconds, the other never clears until a human
  // adds credit. Retrying a dead key wastes an attempt on every request.
  if (body && /insufficient_quota|billing_hard_limit|exceeded your current quota/i.test(body)) return 900;

  if (status === 429) return 30;
  if (status === 401 || status === 403) return 300;
  if (status === 408) return 10;
  return 15;
}

function cooldownStore(env: PoolEnv): CooldownStore | null {
  return env.POOL_STATE ?? env.CODEX_TOKENS ?? null;
}

/**
 * KV enforces a 60-second floor on expirationTtl, but a provider may tell us to
 * back off for five. So the value carries the real expiry and the TTL only
 * garbage-collects the row — reads compare the timestamp, not the row's presence.
 */
export async function readCooldowns(env: PoolEnv, entries: PoolEntry[]): Promise<Set<string>> {
  const store = cooldownStore(env);
  if (!store || entries.length < 2) return new Set();
  const now = Math.floor(Date.now() / 1000);
  const cooled = new Set<string>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const value = await store.get(`cooldown:${entry.id}`);
        if (value && Number(value) > now) cooled.add(entry.id);
      } catch {
        // A cooldown read failure must never block a request; treat as healthy.
      }
    }),
  );
  return cooled;
}

export async function markCooldown(env: PoolEnv, entry: PoolEntry, seconds: number): Promise<void> {
  const store = cooldownStore(env);
  if (!store) return;
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  try {
    await store.put(`cooldown:${entry.id}`, String(expiresAt), { expirationTtl: Math.max(60, seconds) });
  } catch {
    // Losing a cooldown costs one wasted request, not correctness.
  }
}

function logPool(fields: { group: string; entry: string; stage: string; status: number; attempt: number; cooldown?: number }): void {
  console.error(JSON.stringify({ msg: "llm_pool", ...fields }));
}

/**
 * Try the pool best-first until something succeeds.
 *
 * `send` owns the wire format entirely — building the body, reading the response,
 * and folding a 200-with-error-envelope into a real status — so this stays
 * provider-agnostic and never needs to know which shape an entry speaks.
 */
export async function runWithPool(
  env: PoolEnv,
  options: { group: string; routingKey: string; maxAttempts?: number },
  send: (entry: PoolEntry) => Promise<PoolAttemptResult>,
): Promise<PoolOutcome> {
  const entries = parsePool(env, options.group);
  const cooled = await readCooldowns(env, entries);
  const healthy = entries.filter((entry) => !cooled.has(entry.id));
  // Everything cooling down: try anyway rather than fail without asking. A stale
  // cooldown is a guess; the upstream is the authority.
  const candidates = orderedCandidates(healthy.length ? healthy : entries, options.routingKey);
  const limit = Math.max(1, Math.min(options.maxAttempts ?? 3, candidates.length));

  let last: PoolOutcome | null = null;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const entry = candidates[attempt];
    let result: PoolAttemptResult;
    try {
      result = await send(entry);
    } catch (error) {
      // A malformed request is the caller's fault and every entry would reject
      // it identically, so it must not look like a transport failure.
      if (error instanceof ChatCompletionRequestError) throw error;
      // No status at all — DNS, TLS, or the tunnel is gone.
      result = { status: 503, raw: error instanceof Error ? error.message : "send failed" };
    }

    last = { ...result, entry, attempts: attempt + 1 };

    if (result.status >= 200 && result.status < 300) {
      if (attempt > 0) logPool({ group: options.group, entry: entry.id, stage: "recovered", status: result.status, attempt: attempt + 1 });
      return last;
    }
    // A request-shape error is not the endpoint's fault. Every other entry would
    // reject it identically, so surface it instead of burning the pool.
    if (!isRelayFailure(result.status)) return last;

    const seconds = cooldownSeconds(result.status, result.headers, result.raw);
    await markCooldown(env, entry, seconds);
    logPool({ group: options.group, entry: entry.id, stage: "cooled", status: result.status, attempt: attempt + 1, cooldown: seconds });
  }

  return last as PoolOutcome;
}

/** Resolve an entry to the URL and headers its wire format expects. */
export function directTarget(env: PoolEnv, entry: PoolEntry): { url: string; headers: Record<string, string> } {
  const path = entry.wire === "responses" ? "responses" : "chat/completions";
  return {
    url: `${entry.base}/${path}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env[entry.keyVar as string] as string}`,
    },
  };
}
