import assert from "node:assert/strict";
import test from "node:test";
import { fromCodexResponses, codexSseErrorStatus, parseCodexResponsesSse, toCodexResponsesRequest } from "../src/codex";
import { grokRelayUrl, openaiResponsesUrl, xaiChatCompletionsUrl } from "../src/env";
import { embeddedErrorStatus, isRelayFailure } from "../src/fallback";
import { fromGrokChatCompletion, toGrokChatCompletionsRequest } from "../src/grok";
import { isSupportedModel, providerForModel, SUPPORTED_MODELS } from "../src/models";
import {
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

test("direct-API fallback URLs default to the public providers and stay overridable", () => {
  const base = { CODEX_RELAY_URL: "https://relay.example/v1/responses", RELAY_SHARED_SECRET: "x", LLM_CAPABILITY_SECRET: "y" };
  assert.equal(openaiResponsesUrl(base), "https://api.openai.com/v1/responses");
  assert.equal(xaiChatCompletionsUrl(base), "https://api.x.ai/v1/chat/completions");
  assert.equal(
    openaiResponsesUrl({ ...base, OPENAI_RESPONSES_URL: "https://proxy.example/v1/responses" }),
    "https://proxy.example/v1/responses",
  );
  assert.equal(
    xaiChatCompletionsUrl({ ...base, XAI_CHAT_COMPLETIONS_URL: "https://proxy.example/v1/chat/completions" }),
    "https://proxy.example/v1/chat/completions",
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
