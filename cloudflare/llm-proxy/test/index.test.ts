import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedModel, providerForModel, SUPPORTED_MODELS } from "../src/models";
import { parseResponsesSse, responseText, toChatCompletion, toResponsesInput } from "../src/openai";

test("only advertised model IDs route to Codex", () => {
  assert.deepEqual(SUPPORTED_MODELS, ["gpt-5.6-terra"]);
  assert.equal(isSupportedModel("gpt-5.6-terra"), true);
  assert.equal(providerForModel("gpt-5.6-terra"), "openai-codex");
  assert.equal(providerForModel("gpt-5.6-luna"), null);
  assert.equal(providerForModel("grok-4"), null);
  assert.equal(providerForModel("default"), null);
});

test("converts chat messages into Responses input", () => {
  assert.deepEqual(toResponsesInput([{ role: "user", content: "hello" }]), [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
});

test("converts a Responses payload to OpenAI chat-completion format", () => {
  const payload = { id: "resp_1", status: "completed", output: [{ content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 2, output_tokens: 1 } };
  assert.equal(responseText(payload), "hi");
  const output = toChatCompletion("gpt-5.6-terra", payload) as { object: string; choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
  assert.equal(output.object, "chat.completion");
  assert.equal(output.choices[0].message.content, "hi");
  assert.equal(output.usage.total_tokens, 3);
});

test("uses delta text when Codex's terminal snapshot omits output", () => {
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"proxy-ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_done","status":"completed","output":[]}}\n\n';
  assert.equal(responseText(parseResponsesSse(sse)), "proxy-ok");
});

test("uses the completed Responses event from SSE", () => {
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_done","status":"completed","output_text":"complete"}}\n\n';
  const payload = parseResponsesSse(sse);
  assert.equal(payload.id, "resp_done");
  assert.equal(responseText(payload), "complete");
});
