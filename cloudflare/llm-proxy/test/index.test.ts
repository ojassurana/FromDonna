import assert from "node:assert/strict";
import test from "node:test";
import { fromCodexResponses, codexSseErrorStatus, parseCodexResponsesSse, toCodexResponsesRequest } from "../src/codex";
import { grokRelayUrl } from "../src/env";
import { embeddedErrorStatus, isRelayFailure } from "../src/fallback";
import { fromGrokChatCompletion, toGrokChatCompletionsRequest } from "../src/grok";
import { isSupportedModel, providerForModel, SUPPORTED_MODELS } from "../src/models";
import {
  cooldownSeconds,
  directTarget,
  fnv1a32,
  orderedCandidates,
  parsePool,
  runWithPool,
  type PoolEntry,
  type PoolEnv,
} from "../src/pool";
import {
  ChatCompletionRequestError,
  normalizeChatCompletionRequest,
  toChatCompletion,
  toChatCompletionSse,
} from "../src/openai";

test("catalog advertises Codex and Grok models with correct providers", () => {
  assert.deepEqual(SUPPORTED_MODELS, [
    "gpt-5.6-terra",
    "grok-4.5",
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
  ]);
  assert.equal(isSupportedModel("gpt-5.6-terra"), true);
  assert.equal(providerForModel("gpt-5.6-terra"), "openai-codex");
  assert.equal(providerForModel("grok-4.5"), "xai-oauth");
  assert.equal(providerForModel("grok-4.3"), "xai-oauth");
  assert.equal(providerForModel("gpt-5.6-luna"), null);
  assert.equal(providerForModel("default"), null);
});

test("derives Grok relay URL from Codex responses path", () => {
  assert.equal(
    grokRelayUrl({
      CODEX_RELAY_URL: "https://example.ngrok-free.app/v1/responses",
      RELAY_SHARED_SECRET: "x",
      LLM_CAPABILITY_SECRET: "y",
    }),
    "https://example.ngrok-free.app/v1/chat/completions",
  );
  // Production named tunnel (cloudflared → host :9121), not session-bound ngrok.
  assert.equal(
    grokRelayUrl({
      CODEX_RELAY_URL: "https://codex-relay.ojassurana.com/v1/responses",
      RELAY_SHARED_SECRET: "x",
      LLM_CAPABILITY_SECRET: "y",
    }),
    "https://codex-relay.ojassurana.com/v1/chat/completions",
  );
  assert.equal(
    grokRelayUrl({
      CODEX_RELAY_URL: "https://example.ngrok-free.app/v1/responses",
      GROK_RELAY_URL: "https://explicit.example/v1/chat/completions",
      RELAY_SHARED_SECRET: "x",
      LLM_CAPABILITY_SECRET: "y",
    }),
    "https://explicit.example/v1/chat/completions",
  );
});

test("falls back only when the relay itself is the problem", () => {
  // Relay down / broken upstream.
  assert.equal(isRelayFailure(500), true);
  assert.equal(isRelayFailure(502), true);
  assert.equal(isRelayFailure(503), true);
  assert.equal(isRelayFailure(504), true);
  // OAuth plan out of quota or rate limited — the "runs out" case.
  assert.equal(isRelayFailure(429), true);
  // Relay rejected us, or its OAuth credential expired.
  assert.equal(isRelayFailure(401), true);
  assert.equal(isRelayFailure(403), true);
  assert.equal(isRelayFailure(408), true);

  // Bad request: the direct API would reject it identically, so do NOT spend
  // the API key. These must surface to the caller unchanged.
  assert.equal(isRelayFailure(400), false);
  assert.equal(isRelayFailure(404), false);
  assert.equal(isRelayFailure(422), false);
  // Success is obviously never a fallback trigger.
  assert.equal(isRelayFailure(200), false);
});

test("detects error envelopes hidden inside an HTTP 200 body", () => {
  // No envelope at all — a normal success body.
  assert.equal(embeddedErrorStatus('{"choices":[{"message":{"content":"hi"}}]}'), null);
  assert.equal(embeddedErrorStatus("not json"), null);
  assert.equal(embeddedErrorStatus(""), null);

  // An explicit numeric status wins over any wording.
  assert.equal(embeddedErrorStatus('{"error":{"code":429,"message":"slow down"}}'), 429);
  assert.equal(embeddedErrorStatus('{"error":{"status":503,"message":"upstream"}}'), 503);

  // Quota wording with no numeric code — the "runs out" case this exists for.
  assert.equal(embeddedErrorStatus('{"error":{"message":"You exceeded your current quota"}}'), 429);
  assert.equal(embeddedErrorStatus('{"error":{"type":"rate_limit_exceeded"}}'), 429);
  assert.equal(embeddedErrorStatus('{"error":{"message":"insufficient credit"}}'), 429);

  // Expired/rejected credential.
  assert.equal(embeddedErrorStatus('{"error":{"message":"Unauthorized"}}'), 401);
  assert.equal(embeddedErrorStatus('{"error":{"message":"invalid api key"}}'), 401);

  // Request-shape errors must map to 400 so the fallback does NOT fire and
  // spend the API key on a request the direct API would reject identically.
  assert.equal(embeddedErrorStatus('{"error":{"message":"Invalid request: bad tool schema"}}'), 400);
  assert.equal(embeddedErrorStatus('{"error":{"message":"The model does not exist"}}'), 400);
  assert.equal(isRelayFailure(embeddedErrorStatus('{"error":{"message":"malformed input"}}')!), false);

  // Unrecognized envelope: worth one retry, so a retryable status.
  assert.equal(embeddedErrorStatus('{"error":{"message":"something odd"}}'), 502);
});

test("detects Codex SSE failures delivered on an HTTP 200", () => {
  // A clean stream carries no failure.
  assert.equal(
    codexSseErrorStatus('data: {"type":"response.completed","response":{"output":[]}}\n\n'),
    null,
  );

  // Top-level error frame.
  assert.equal(
    codexSseErrorStatus('data: {"type":"error","error":{"message":"quota exceeded"}}\n\n'),
    429,
  );

  // Terminal failure carrying the error on the response object.
  assert.equal(
    codexSseErrorStatus(
      'data: {"type":"response.failed","response":{"error":{"code":401,"message":"expired"}}}\n\n',
    ),
    401,
  );

  // A failure with no recognizable envelope still reports a retryable status.
  assert.equal(codexSseErrorStatus('data: {"type":"response.failed","response":{}}\n\n'), 502);
});

const RELAY_ENV = {
  CODEX_RELAY_URL: "https://relay.example/v1/responses",
  RELAY_SHARED_SECRET: "x",
  LLM_CAPABILITY_SECRET: "y",
} satisfies PoolEnv;

test("with no LLM_POOL the pool reproduces the previous single-key fallback", () => {
  // Nothing configured: relay only, so a deployment that has not opted in
  // behaves exactly as it did before the pool existed.
  assert.deepEqual(parsePool(RELAY_ENV, "codex"), [
    { id: "codex-relay", group: "codex", kind: "relay", order: 1, weight: 1 },
  ]);

  // A key configured: relay first, then that one direct endpoint at order 2.
  const withKey = parsePool({ ...RELAY_ENV, OPENAI_API_KEY: "sk-test" }, "codex");
  assert.equal(withKey.length, 2);
  assert.equal(withKey[1].kind, "direct");
  assert.equal(withKey[1].order, 2);
  assert.equal(withKey[1].base, "https://api.openai.com/v1");
  assert.equal(withKey[1].wire, "responses");
  assert.equal(directTarget({ ...RELAY_ENV, OPENAI_API_KEY: "sk-test" }, withKey[1]).url, "https://api.openai.com/v1/responses");

  const grok = parsePool({ ...RELAY_ENV, XAI_API_KEY: "xai-test" }, "grok");
  assert.equal(grok[1].wire, "chat_completions");
  assert.equal(directTarget({ ...RELAY_ENV, XAI_API_KEY: "xai-test" }, grok[1]).url, "https://api.x.ai/v1/chat/completions");

  // The documented URL overrides still apply, now via the pool's base.
  const overridden = parsePool(
    { ...RELAY_ENV, OPENAI_API_KEY: "sk-test", OPENAI_RESPONSES_URL: "https://proxy.example/v1/responses" },
    "codex",
  );
  assert.equal(overridden[1].base, "https://proxy.example/v1");
  assert.equal(overridden[1].model, undefined);

  // The relay accepts aliases the public API rejects, so the fallback model id
  // must reach the direct entry.
  const aliased = parsePool({ ...RELAY_ENV, OPENAI_API_KEY: "sk-test", OPENAI_FALLBACK_MODEL: "gpt-5.6" }, "codex");
  assert.equal(aliased[1].model, "gpt-5.6");
});

test("credentials are referenced by name, never stored in pool config", () => {
  const entry: PoolEntry = {
    id: "oai-1", group: "codex", kind: "direct", order: 2, weight: 1,
    base: "https://api.openai.com/v1", wire: "responses", keyVar: "OAI_KEY_1",
  };
  const target = directTarget({ ...RELAY_ENV, OAI_KEY_1: "sk-secret" }, entry);
  assert.equal(target.headers.Authorization, "Bearer sk-secret");
  // The config itself carries only the name, so it stays reviewable in git.
  assert.equal(JSON.stringify(entry).includes("sk-secret"), false);
});

test("pool config keeps only usable entries in the requested group", () => {
  const env: PoolEnv = {
    ...RELAY_ENV,
    KEY_A: "a",
    LLM_POOL: JSON.stringify([
      { id: "codex-relay", group: "codex", kind: "relay", order: 1, weight: 1 },
      { id: "ok", group: "codex", kind: "direct", order: 2, weight: 3, base: "https://a.example/v1", keyVar: "KEY_A" },
      // Secret not provisioned — configuration drift, so skip it rather than
      // send an unauthenticated request that is guaranteed to fail.
      { id: "missing-secret", group: "codex", kind: "direct", order: 2, weight: 1, base: "https://b.example/v1", keyVar: "KEY_ABSENT" },
      // Nowhere to send: unusable.
      { id: "no-base", group: "codex", kind: "direct", order: 2, weight: 1, keyVar: "KEY_A" },
      // Duplicate id would share a cooldown key and mask the other's health.
      { id: "ok", group: "codex", kind: "direct", order: 3, weight: 1, base: "https://c.example/v1", keyVar: "KEY_A" },
      // Another group's endpoint must not answer a codex request.
      { id: "grok-1", group: "grok", kind: "direct", order: 2, weight: 1, base: "https://d.example/v1", keyVar: "KEY_A" },
    ]),
  };
  assert.deepEqual(parsePool(env, "codex").map((entry) => entry.id), ["codex-relay", "ok"]);
  assert.deepEqual(parsePool(env, "grok").map((entry) => entry.id), ["grok-1"]);

  // Trailing slashes must not produce a double slash in the final URL.
  const trimmed = parsePool(
    { ...RELAY_ENV, KEY_A: "a", LLM_POOL: JSON.stringify([{ id: "t", group: "codex", kind: "direct", base: "https://a.example/v1/", keyVar: "KEY_A" }]) },
    "codex",
  );
  assert.equal(directTarget({ ...RELAY_ENV, KEY_A: "a" }, trimmed[0]).url, "https://a.example/v1/chat/completions");

  // Malformed config must not take the proxy down.
  assert.deepEqual(parsePool({ ...RELAY_ENV, LLM_POOL: "{not json" }, "codex").map((e) => e.kind), ["relay"]);
  assert.deepEqual(parsePool({ ...RELAY_ENV, LLM_POOL: "[]" }, "codex").map((e) => e.kind), ["relay"]);
});

test("order tiers win outright over weight", () => {
  // The subscription-priced relay is order 1 with weight 1; a heavily-weighted
  // paid endpoint at order 2 must still never be tried first, or we would pay
  // per token for capacity the subscription already covers.
  const entries: PoolEntry[] = [
    { id: "paid", group: "codex", kind: "direct", order: 2, weight: 100, base: "https://a.example/v1", keyVar: "K" },
    { id: "relay", group: "codex", kind: "relay", order: 1, weight: 1 },
  ];
  for (const key of ["a", "b", "c", "zzz", "user_42"]) {
    assert.deepEqual(orderedCandidates(entries, key).map((entry) => entry.id), ["relay", "paid"]);
  }
});

test("one caller sticks to one endpoint while different callers spread by weight", () => {
  const tier = (id: string, weight: number): PoolEntry =>
    ({ id, group: "codex", kind: "direct", order: 2, weight, base: `https://${id}.example/v1`, keyVar: "K" });
  const entries = [tier("big", 8), tier("small-1", 1), tier("small-2", 1)];

  // Sticky: the same routing key always resolves to the same first choice, so a
  // multi-turn agent conversation does not change model mid-task.
  const first = orderedCandidates(entries, "caller-7")[0].id;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(orderedCandidates(entries, "caller-7")[0].id, first);
  }
  // Every entry still appears, in order, as the retry tail.
  assert.equal(orderedCandidates(entries, "caller-7").length, 3);

  // Spread: across many callers, traffic tracks weight (ideal 800/100/100).
  const counts: Record<string, number> = { big: 0, "small-1": 0, "small-2": 0 };
  for (let i = 0; i < 1000; i += 1) counts[orderedCandidates(entries, `user_${i}`)[0].id] += 1;
  assert.ok(counts.big > 700 && counts.big < 880, `big=${counts.big}`);
  assert.ok(counts["small-1"] > 40, `small-1=${counts["small-1"]}`);
  assert.ok(counts["small-2"] > 40, `small-2=${counts["small-2"]}`);

  // Stable across isolates and deploys: the routing decision must not change
  // just because the request landed in a different datacentre.
  assert.equal(fnv1a32("caller-7:2"), fnv1a32("caller-7:2"));
  assert.notEqual(fnv1a32("caller-7:1"), fnv1a32("caller-7:2"));
});

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

test("cooldown length comes from the provider instead of a guess", () => {
  // The provider already knows when the window resets; read it.
  assert.equal(cooldownSeconds(429, headers({ "retry-after-ms": "2500" })), 3);
  assert.equal(cooldownSeconds(429, headers({ "retry-after": "12" })), 12);
  assert.equal(cooldownSeconds(429, headers({ "x-ratelimit-reset-requests": "6s" })), 6);
  assert.equal(cooldownSeconds(429, headers({ "x-ratelimit-reset-requests": "1m30s" })), 90);
  assert.equal(cooldownSeconds(429, headers({ "x-ratelimit-reset-requests": "250ms" })), 1);
  // retry-after-ms is more precise, so it wins over the whole-second header.
  assert.equal(cooldownSeconds(429, headers({ "retry-after-ms": "1500", "retry-after": "60" })), 2);

  // No headers at all: fall back to something sane per status.
  assert.equal(cooldownSeconds(429), 30);
  assert.equal(cooldownSeconds(401), 300);
  assert.equal(cooldownSeconds(503), 15);

  // Both are HTTP 429 but they mean opposite things: a throttle clears in
  // seconds, an exhausted account never clears without a human. Retrying a dead
  // key every request would waste an attempt on every single request.
  assert.equal(cooldownSeconds(429, undefined, '{"error":{"code":"insufficient_quota"}}'), 900);
  assert.equal(cooldownSeconds(429, undefined, '{"error":{"code":"rate_limit_exceeded"}}'), 30);

  // Never trust an absurd value from upstream.
  assert.equal(cooldownSeconds(429, headers({ "retry-after": "999999" })), 900);
  assert.equal(cooldownSeconds(429, headers({ "retry-after": "0" })), 1);
  assert.equal(cooldownSeconds(429, headers({ "retry-after": "garbage" })), 30);
});

const poolOf = (...ids: string[]): PoolEnv => ({
  ...RELAY_ENV,
  KEY: "k",
  LLM_POOL: JSON.stringify(
    ids.map((id, index) => ({
      id,
      group: "codex",
      kind: "direct",
      // Distinct tiers make the attempt order deterministic for assertions.
      order: index + 1,
      weight: 1,
      base: `https://${id}.example/v1`,
      keyVar: "KEY",
    })),
  ),
});

test("a failing endpoint is retried on the next one, up to a bounded number of attempts", async () => {
  const tried: string[] = [];
  const outcome = await runWithPool(poolOf("a", "b", "c"), { group: "codex", routingKey: "u1" }, async (entry) => {
    tried.push(entry.id);
    // First endpoint is out of quota; the second one answers.
    return entry.id === "a" ? { status: 429, raw: "rate limited" } : { status: 200, raw: "ok" };
  });
  assert.deepEqual(tried, ["a", "b"]);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.entry.id, "b");
  assert.equal(outcome.attempts, 2);

  // All bad: stop at 3 distinct endpoints rather than walking a large pool.
  // Failed requests still count against a provider's quota.
  const all: string[] = [];
  const exhausted = await runWithPool(poolOf("a", "b", "c", "d", "e"), { group: "codex", routingKey: "u1" }, async (entry) => {
    all.push(entry.id);
    return { status: 503, raw: "down" };
  });
  assert.deepEqual(all, ["a", "b", "c"]);
  assert.equal(exhausted.status, 503);

  // A transport throw has no status at all — tunnel, DNS, or TLS — and must
  // still fall through to the next endpoint.
  const thrown: string[] = [];
  const recovered = await runWithPool(poolOf("a", "b"), { group: "codex", routingKey: "u1" }, async (entry) => {
    thrown.push(entry.id);
    if (entry.id === "a") throw new Error("tunnel closed");
    return { status: 200, raw: "ok" };
  });
  assert.deepEqual(thrown, ["a", "b"]);
  assert.equal(recovered.status, 200);
});

test("a bad request is returned immediately instead of burning the pool", async () => {
  // Every endpoint would reject a malformed request identically, so trying more
  // of them only spends quota and adds latency.
  const tried: string[] = [];
  const outcome = await runWithPool(poolOf("a", "b", "c"), { group: "codex", routingKey: "u1" }, async (entry) => {
    tried.push(entry.id);
    return { status: 400, raw: '{"error":{"message":"bad tool schema"}}' };
  });
  assert.deepEqual(tried, ["a"]);
  assert.equal(outcome.status, 400);
  assert.equal(outcome.attempts, 1);

  // A mapping error is the caller's fault too, and must not be disguised as a
  // transport failure by the retry loop.
  await assert.rejects(
    runWithPool(poolOf("a", "b"), { group: "codex", routingKey: "u1" }, async () => {
      throw new ChatCompletionRequestError("content part type 'video' is not supported.");
    }),
    ChatCompletionRequestError,
  );
});

test("normalizes multipart messages and tool calls without flattening them", () => {
  const request = normalizeChatCompletionRequest({
    model: "gpt-5.6-terra",
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect_image", arguments: "{\"detail\":\"high\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "image is a cat" },
    ],
    tools: [{ type: "function", function: { name: "inspect_image", parameters: { type: "object" } } }],
    tool_choice: "auto",
    stream: true,
  });

  assert.equal(request.stream, true);
  assert.equal(request.messages[1].toolCalls?.[0].function.name, "inspect_image");
  assert.equal(request.messages[2].toolCallId, "call_1");

  const codex = toCodexResponsesRequest(request);
  const input = codex.input as Array<Record<string, unknown>>;
  assert.equal((input[0].content as Array<Record<string, unknown>>)[1].type, "input_image");
  assert.equal(input[1].type, "function_call");
  assert.equal(input[2].type, "function_call_output");
  assert.equal((codex.tools as Array<Record<string, unknown>>)[0].name, "inspect_image");
});

test("maps Grok tool-call chat completions into the neutral contract", () => {
  const request = normalizeChatCompletionRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "Call ping" }],
    tools: [{ type: "function", function: { name: "ping", parameters: { type: "object" } } }],
    tool_choice: "required",
    max_completion_tokens: 20,
  });
  const body = toGrokChatCompletionsRequest(request);
  assert.equal(body.model, "grok-4.5");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 20);
  assert.equal((body.tools as Array<Record<string, unknown>>)[0].type, "function");

  const normalized = fromGrokChatCompletion({
    id: "chatcmpl_g",
    created: 1,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_g1", type: "function", function: { name: "ping", arguments: "{}" } }],
        },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  const output = toChatCompletion("grok-4.5", normalized) as {
    choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }>; content: string | null }; finish_reason: string }>;
  };
  assert.equal(output.choices[0].finish_reason, "tool_calls");
  assert.equal(output.choices[0].message.tool_calls[0].function.name, "ping");
  assert.equal(output.choices[0].message.content, null);
});

test("converts Codex function calls back to OpenAI chat-completion format", () => {
  const normalized = fromCodexResponses("gpt-5.6-terra", {
    id: "resp_1",
    status: "completed",
    output: [{ type: "function_call", call_id: "call_1", name: "skills_list", arguments: "{}" }],
    usage: { input_tokens: 2, output_tokens: 1 },
  });
  const output = toChatCompletion("gpt-5.6-terra", normalized) as {
    object: string;
    choices: Array<{ message: { content: string | null; tool_calls: Array<{ id: string }> }; finish_reason: string }>;
    usage: { total_tokens: number };
  };

  assert.equal(output.object, "chat.completion");
  assert.equal(output.choices[0].message.content, null);
  assert.equal(output.choices[0].message.tool_calls[0].id, "call_1");
  assert.equal(output.choices[0].finish_reason, "tool_calls");
  assert.equal(output.usage.total_tokens, 3);
});

test("uses text deltas when Codex terminal snapshot omits output", () => {
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"proxy-ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_done","status":"completed","output":[]}}\n\n';
  const normalized = fromCodexResponses("gpt-5.6-terra", parseCodexResponsesSse(sse));
  assert.deepEqual(normalized.content, [{ type: "text", text: "proxy-ok" }]);
});

test("extracts reasoning summary text when message content is missing", () => {
  const normalized = fromCodexResponses("gpt-5.6-terra", {
    id: "resp_reason",
    status: "completed",
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "I should answer briefly." }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 8 },
  });
  assert.deepEqual(normalized.content, [{ type: "text", text: "I should answer briefly." }]);
});

test("reconstructs function calls from SSE argument deltas when completed output is empty", () => {
  const sse = [
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","call_id":"call_1","name":"read_file","delta":"{\\"path\\":"}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"SOUL.md\\"}"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fc","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":20}}}',
  ].join("\n\n") + "\n\n";
  const normalized = fromCodexResponses("gpt-5.6-terra", parseCodexResponsesSse(sse));
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].function.name, "read_file");
  assert.match(normalized.toolCalls[0].function.arguments, /SOUL\.md/);
  assert.equal(normalized.finishReason, "tool_calls");
});

test("emits Chat Completions SSE including tool calls", () => {
  const sse = toChatCompletionSse("gpt-5.6-terra", {
    id: "resp_stream",
    content: [{ type: "text", text: "hello-stream" }],
    toolCalls: [{ id: "call_stream", type: "function", function: { name: "terminal", arguments: "{}" } }],
    finishReason: "tool_calls",
  });
  assert.match(sse, /hello-stream/);
  assert.match(sse, /tool_calls/);
  assert.match(sse, /chat\.completion\.chunk/);
  assert.match(sse, /data: \[DONE\]/);
});
