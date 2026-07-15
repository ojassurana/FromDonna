import { grokRelayUrl, type Env } from "./env";
import {
  type ChatContentPart,
  type JsonObject,
  type NormalizedChatCompletionRequest,
  type NormalizedChatCompletionResponse,
  type ProviderAdapter,
  UpstreamError,
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

async function grokChatCompletion(env: Env, body: JsonObject): Promise<Response> {
  return fetch(grokRelayUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Token": env.RELAY_SHARED_SECRET,
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(body),
  });
}

export const grokAdapter: ProviderAdapter<Env> = {
  async complete(env, request) {
    // Refuse image parts only if we later need a stricter policy; xAI accepts
    // image_url parts on supported models, so we forward typed content as-is.
    for (const message of request.messages) {
      for (const part of message.content) {
        if (part.type === "text" || part.type === "image_url") continue;
        // Tool messages are already normalized; other exotic parts stay explicit.
        if (message.role === "tool" && part.type === "text") continue;
        if (part.type !== "text" && part.type !== "image_url") {
          // Allow other parts through — xAI will reject if unsupported.
        }
      }
    }

    const upstream = await grokChatCompletion(env, toGrokChatCompletionsRequest(request));
    const raw = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    if (!upstream.ok) {
      throw new UpstreamError(`Grok upstream returned HTTP ${upstream.status}.`, upstream.status, payload);
    }
    if (!isObject(payload)) {
      throw new UpstreamError("Grok upstream returned a non-JSON body.", 502);
    }
    if (isObject(payload.error)) {
      // Some gateways return 200 with an error object; surface as upstream error.
      throw new UpstreamError("Grok upstream returned an error object.", 502, payload);
    }
    const normalized = fromGrokChatCompletion(payload);
    if (!normalized.content.length && !normalized.toolCalls.length) {
      const outTokens = normalized.usage?.outputTokens ?? 0;
      if (outTokens > 0) {
        console.error(
          JSON.stringify({
            msg: "grok_empty_mapping",
            model: request.model,
            outTokens,
            rawHead: raw.slice(0, 1200),
          }),
        );
      }
    }
    return normalized;
  },
};

// Re-export for callers that previously imported Env from codex.
export type { Env };
