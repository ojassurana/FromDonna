/**
 * Pool-backed adapter.
 *
 * Before this, each model was bound to one adapter which was bound to one
 * transport, so "which provider serves this request" was a compile-time fact.
 * That cannot scale past one credential: capacity comes from having several
 * independent endpoints to choose from (see pool.ts).
 *
 * So the wire format moves from the adapter to the *pool entry*. One request may
 * be built as a Responses call for the OAuth relay and, on the retry, as a Chat
 * Completions call for a different provider — because both directions already
 * map through the same provider-neutral contract in openai.ts. That is what
 * makes the proxy genuinely model-agnostic: adding a provider is a config edit,
 * not a code change.
 *
 * A `group` is a set of endpoints considered interchangeable for a request.
 * Grouping is deliberate rather than global: a caller asking for a Codex model
 * should not be silently answered by a Grok endpoint unless someone configured
 * that on purpose.
 */

import {
  codexSseErrorStatus,
  fromCodexResponses,
  parseCodexResponsesSse,
  toCodexResponsesRequest,
} from "./codex";
import { grokRelayUrl, type Env } from "./env";
import { embeddedErrorStatus } from "./fallback";
import { fromGrokChatCompletion, toGrokChatCompletionsRequest } from "./grok";
import {
  type JsonObject,
  type NormalizedChatCompletionRequest,
  type NormalizedChatCompletionResponse,
  type ProviderAdapter,
  UpstreamError,
} from "./openai";
import { directTarget, runWithPool, type PoolEntry, type PoolEnv, type WireFormat } from "./pool";

/** Wire format assumed for a group's entries when an entry doesn't state one. */
const GROUP_WIRE: Record<string, WireFormat> = {
  codex: "responses",
  grok: "chat_completions",
};

function wireFor(entry: PoolEntry, group: string): WireFormat {
  return entry.wire ?? GROUP_WIRE[group] ?? "chat_completions";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Env is a closed type for editor safety, but the pool resolves credentials by
 * *name* (`env[entry.keyVar]`) so a new provider needs no type change. One cast,
 * in one place, is the price of that.
 */
function asPoolEnv(env: Env): PoolEnv {
  return env as unknown as PoolEnv;
}

/**
 * The Worker never owns OAuth state: the trusted host relay resolves the active
 * credential per request. Only the path differs between the two wire formats.
 */
function relayTarget(env: Env, wire: WireFormat): { url: string; headers: Record<string, string> } {
  return {
    url: wire === "responses" ? env.CODEX_RELAY_URL : grokRelayUrl(env),
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Token": env.RELAY_SHARED_SECRET,
      "ngrok-skip-browser-warning": "true",
    },
  };
}

/**
 * Build the upstream body in the shape this entry speaks. An entry may override
 * the model id because the relay accepts internal aliases (`gpt-5.6-terra`) that
 * a public API rejects.
 */
function buildBody(wire: WireFormat, request: NormalizedChatCompletionRequest, model?: string): JsonObject {
  const scoped = model && model !== request.model ? { ...request, model } : request;
  return wire === "responses" ? toCodexResponsesRequest(scoped) : toGrokChatCompletionsRequest(scoped);
}

/**
 * Never hand the agent a successful empty completion when the upstream clearly
 * spent tokens — that turns a mapping gap into an invisible "model said nothing"
 * loop. Log enough to identify the shape we failed to read.
 */
function logEmptyMapping(entry: string, model: string, outTokens: number, raw: string, extra?: JsonObject): void {
  console.error(JSON.stringify({ msg: "llm_empty_mapping", entry, model, outTokens, rawHead: raw.slice(0, 1200), ...extra }));
}

/** Read the upstream body in the shape this entry speaks. */
function readBody(wire: WireFormat, model: string, entry: string, raw: string): NormalizedChatCompletionResponse {
  if (wire === "responses") {
    const parsed = parseCodexResponsesSse(raw);
    const normalized = fromCodexResponses(model, parsed);
    if (!normalized.content.length && !normalized.toolCalls.length) {
      const usage = isObject(parsed.usage) ? parsed.usage : {};
      const outTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      if (outTokens > 0 || raw.includes("function_call") || raw.includes("output_text")) {
        logEmptyMapping(entry, model, outTokens, raw, {
          parsedOutputTypes: Array.isArray(parsed.output)
            ? (parsed.output as unknown[]).map((item) => (isObject(item) ? item.type : typeof item))
            : [],
        });
      }
    }
    return normalized;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new UpstreamError(`Upstream '${entry}' returned a non-JSON body.`, 502);
  }
  if (!isObject(payload)) throw new UpstreamError(`Upstream '${entry}' returned a non-object body.`, 502);
  const normalized = fromGrokChatCompletion(payload);
  const outTokens = normalized.usage?.outputTokens ?? 0;
  if (!normalized.content.length && !normalized.toolCalls.length && outTokens > 0) {
    logEmptyMapping(entry, model, outTokens, raw);
  }
  return normalized;
}

/**
 * One adapter per interchangeable group. All five catalog models flow through
 * here, so this is the single place where routing, retry, and cooldown apply.
 */
export function poolAdapter(group: string): ProviderAdapter<Env> {
  return {
    async complete(env, request, routing) {
      const poolEnv = asPoolEnv(env);
      const outcome = await runWithPool(
        poolEnv,
        // Falling back to the model id keeps selection deterministic even for a
        // caller with no routing context; it just pins less narrowly.
        { group, routingKey: routing?.key ?? request.model },
        async (entry) => {
          const wire = wireFor(entry, group);
          const body = buildBody(wire, request, entry.model);
          const target = entry.kind === "relay" ? relayTarget(env, wire) : directTarget(poolEnv, entry);
          const upstream = await fetch(target.url, {
            method: "POST",
            headers: target.headers,
            body: JSON.stringify(body),
          });
          const raw = await upstream.text();

          // Some relays report failure in the body of an HTTP 200. Fold that
          // into a real status here, or a quota error would look like success
          // and the pool would never route around it.
          let status = upstream.status;
          if (status >= 200 && status < 300) {
            const embedded = wire === "responses" ? codexSseErrorStatus(raw) : embeddedErrorStatus(raw);
            if (embedded !== null) status = embedded;
          }
          return { status, raw, headers: upstream.headers };
        },
      );

      if (outcome.status < 200 || outcome.status >= 300) {
        let payload: unknown;
        try {
          payload = JSON.parse(outcome.raw);
        } catch {
          /* upstream sent no JSON envelope; the status alone is the signal */
        }
        throw new UpstreamError(
          `Upstream '${outcome.entry.id}' returned HTTP ${outcome.status} after ${outcome.attempts} attempt(s).`,
          outcome.status,
          payload,
        );
      }

      return readBody(wireFor(outcome.entry, group), request.model, outcome.entry.id, outcome.raw);
    },
  };
}

export const codexAdapter = poolAdapter("codex");
export const grokAdapter = poolAdapter("grok");
