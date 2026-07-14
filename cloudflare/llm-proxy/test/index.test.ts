import assert from "node:assert/strict";
import test from "node:test";
import { fromCodexResponses, parseCodexResponsesSse, toCodexResponsesRequest } from "../src/codex";
import { isSupportedModel, providerForModel, SUPPORTED_MODELS } from "../src/models";
import {
  normalizeChatCompletionRequest,
  toChatCompletion,
  toChatCompletionSse,
} from "../src/openai";

test("only advertised model IDs route to Codex", () => {
  assert.deepEqual(SUPPORTED_MODELS, ["gpt-5.6-terra"]);
  assert.equal(isSupportedModel("gpt-5.6-terra"), true);
  assert.equal(providerForModel("gpt-5.6-terra"), "openai-codex");
  assert.equal(providerForModel("gpt-5.6-luna"), null);
  assert.equal(providerForModel("grok-4"), null);
  assert.equal(providerForModel("default"), null);
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
