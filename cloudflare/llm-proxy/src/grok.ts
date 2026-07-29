/**
 * Grok mapping layer: request/response translation between the neutral contract
 * and the OpenAI-compatible Chat Completions shape.
 *
 * Nothing here is xAI-specific by design — this is the shape most providers
 * speak, so the same two functions serve every Chat Completions endpoint in the
 * pool. Transport and credential choice live in pool.ts / adapter.ts.
 */

import type { Env } from "./env";
import {
  type ChatContentPart,
  type JsonObject,
  type NormalizedChatCompletionRequest,
  type NormalizedChatCompletionResponse,
} from "./openai";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map normalized messages back into standard OpenAI Chat Completions shape. */
export function toGrokChatCompletionsRequest(request: NormalizedChatCompletionRequest): JsonObject {
  const messages = request.messages.map((message) => {
    const content =
      message.content.length === 0
        ? null
        : message.content.length === 1 && message.content[0].type === "text" && typeof message.content[0].text === "string"
          ? (message.content[0].text as string)
          : message.content;

    const out: JsonObject = { role: message.role, content };
    if (message.name) out.name = message.name;
    if (message.toolCallId) out.tool_call_id = message.toolCallId;
    if (message.toolCalls?.length) out.tool_calls = message.toolCalls;
    return out;
  });

  const body: JsonObject = {
    model: request.model,
    messages,
    // Always non-stream upstream; the public edge re-emits SSE if Hermes asked.
    stream: false,
  };
  if (request.tools) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const maxTokens = request.maxCompletionTokens ?? request.maxTokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return body;
}

function contentPartsFromAssistant(content: unknown): ChatContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is JsonObject => isObject(part) && typeof part.type === "string")
      .map((part) => ({ ...part, type: part.type as string }));
  }
  return [];
}

function toolCallsFromAssistant(value: unknown): NormalizedChatCompletionResponse["toolCalls"] {
  if (!Array.isArray(value)) return [];
  const calls: NormalizedChatCompletionResponse["toolCalls"] = [];
  for (const call of value) {
    if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== "string") continue;
    const id = typeof call.id === "string" && call.id ? call.id : `call_${calls.length + 1}`;
    let args = call.function.arguments;
    if (typeof args !== "string") {
      try {
        args = JSON.stringify(args ?? {});
      } catch {
        args = "{}";
      }
    }
    calls.push({
      id,
      type: "function",
      function: { name: call.function.name, arguments: args as string },
    });
  }
  return calls;
}

/** Convert an xAI/OpenAI chat.completion object into the neutral result. */
export function fromGrokChatCompletion(payload: JsonObject): NormalizedChatCompletionResponse {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(first.message) ? first.message : {};
  const toolCalls = toolCallsFromAssistant(message.tool_calls);
  let content = contentPartsFromAssistant(message.content);

  // Some Grok builds put useful text only in reasoning_content when content is empty.
  if (!content.length && typeof message.reasoning_content === "string" && message.reasoning_content.trim() && !toolCalls.length) {
    content = [{ type: "text", text: message.reasoning_content }];
  }

  const finish =
    first.finish_reason === "tool_calls" || toolCalls.length
      ? "tool_calls"
      : first.finish_reason === "length"
        ? "length"
        : "stop";

  const usage = isObject(payload.usage) ? payload.usage : {};
  return {
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    ...(typeof payload.created === "number" ? { created: payload.created } : {}),
    content,
    toolCalls,
    finishReason: finish,
    usage: {
      ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
    },
  };
}

// Re-export for callers that previously imported Env from codex.
export type { Env };
