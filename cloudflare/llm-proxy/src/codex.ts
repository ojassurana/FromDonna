import {
  ChatCompletionRequestError,
  type ChatContentPart,
  type JsonObject,
  type NormalizedChatCompletionRequest,
  type NormalizedChatCompletionResponse,
  type ProviderAdapter,
  UpstreamError,
} from "./openai";

export type Env = {
  CODEX_RELAY_URL: string;
  RELAY_SHARED_SECRET: string;
  /** HMAC key shared with the Telegram gateway, never exposed to sandboxes. */
  LLM_CAPABILITY_SECRET: string;
};

/**
 * The Worker never owns Codex OAuth state. The trusted relay resolves Hermes's
 * active runtime credential for every request, keeping one token authority.
 */
export async function codexResponse(env: Env, body: Record<string, unknown>): Promise<Response> {
  return fetch(env.CODEX_RELAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Token": env.RELAY_SHARED_SECRET,
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(body),
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutType(part: ChatContentPart): JsonObject {
  const { type: _type, ...rest } = part;
  return rest;
}

/** Map OpenAI's typed content parts deliberately; never turn unknown parts into text. */
function toCodexContent(parts: ChatContentPart[], role: "assistant" | "input"): JsonObject[] {
  return parts.map((part, index) => {
    if (part.type === "text" && typeof part.text === "string") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    if (part.type === "image_url") {
      const image = part.image_url;
      if (typeof image === "string") return { type: "input_image", image_url: image };
      if (isObject(image) && typeof image.url === "string") {
        return { type: "input_image", image_url: image.url, ...(typeof image.detail === "string" ? { detail: image.detail } : {}) };
      }
      throw new ChatCompletionRequestError(`image_url content part ${index} requires image_url.url.`);
    }
    if (part.type === "input_audio" && isObject(part.input_audio)) {
      return { type: "input_audio", input_audio: part.input_audio };
    }
    if (part.type === "file") {
      const file = isObject(part.file) ? part.file : withoutType(part);
      if (typeof file.file_id === "string" || typeof file.file_data === "string") return { type: "input_file", ...file };
      throw new ChatCompletionRequestError(`file content part ${index} requires file_id or file_data.`);
    }
    throw new ChatCompletionRequestError(`Content part type '${part.type}' is not supported by the Codex adapter.`);
  });
}

function toolOutput(parts: ChatContentPart[]): string {
  // The Responses function_call_output schema accepted by Codex is a string.
  // Refuse rich tool output rather than silently flattening/dropping it.
  if (parts.some((part) => part.type !== "text" || typeof part.text !== "string")) {
    throw new ChatCompletionRequestError("The Codex adapter only supports text content in tool result messages.");
  }
  return parts.map((part) => part.text as string).join("");
}

function toCodexTools(tools: JsonObject[] | undefined): JsonObject[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool, index) => {
    if (tool.type !== "function" || !isObject(tool.function) || typeof tool.function.name !== "string") {
      throw new ChatCompletionRequestError(`tools[${index}] must be an OpenAI function tool.`);
    }
    const fn = tool.function;
    return {
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    };
  });
}

function toCodexToolChoice(toolChoice: unknown): unknown {
  if (!isObject(toolChoice)) return toolChoice;
  if (toolChoice.type === "function" && isObject(toolChoice.function) && typeof toolChoice.function.name === "string") {
    return { type: "function", name: toolChoice.function.name };
  }
  throw new ChatCompletionRequestError("tool_choice must be 'auto', 'none', 'required', or an OpenAI function tool choice.");
}

/** Codex is an adapter: only this module knows Responses API item shapes. */
export function toCodexResponsesRequest(request: NormalizedChatCompletionRequest): JsonObject {
  const input: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: toolOutput(message.content) });
      continue;
    }

    if (message.content.length) {
      input.push({
        role: message.role,
        content: toCodexContent(message.content, message.role === "assistant" ? "assistant" : "input"),
      });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }

  return {
    model: request.model,
    // The ChatGPT/Codex backend rejects persisted Responses objects.
    store: false,
    stream: true,
    input,
    ...(toCodexTools(request.tools) ? { tools: toCodexTools(request.tools) } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: toCodexToolChoice(request.toolChoice) } : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    // The Codex endpoint rejects max_output_tokens. Intentionally do not map
    // max_tokens/max_completion_tokens even though the normalized contract keeps them.
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

function responseTextParts(payload: JsonObject): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
        parts.push({ type: "text", text: content.text });
      }
    }
  }
  if (!parts.length && typeof payload.output_text === "string") parts.push({ type: "text", text: payload.output_text });
  return parts;
}

/** Convert a Codex Responses object to the provider-neutral completion result. */
export function fromCodexResponses(model: string, payload: JsonObject): NormalizedChatCompletionResponse {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const toolCalls = output.flatMap((item) => {
    if (!isObject(item) || item.type !== "function_call" || typeof item.name !== "string" || typeof item.arguments !== "string") return [];
    const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
    return id ? [{ id, type: "function" as const, function: { name: item.name, arguments: item.arguments } }] : [];
  });
  const usage = isObject(payload.usage) ? payload.usage : {};
  return {
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    content: responseTextParts(payload),
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : payload.status === "incomplete" ? "length" : "stop",
    usage: {
      ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
      ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    },
  };
}

/** Parse the internally streamed Codex Responses SSE into its terminal object. */
export function parseCodexResponsesSse(text: string): JsonObject {
  let completed: JsonObject | null = null;
  let textDelta = "";
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as JsonObject;
      if (event.type === "response.completed" && isObject(event.response)) completed = event.response;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") textDelta += event.delta;
    } catch { /* ignore malformed upstream SSE frames */ }
  }
  if (completed) {
    if (!responseTextParts(completed).length && textDelta) completed.output_text = textDelta;
    return completed;
  }
  return { id: `resp_${crypto.randomUUID()}`, status: "completed", output_text: textDelta };
}

export const codexAdapter: ProviderAdapter<Env> = {
  async complete(env, request) {
    const upstream = await codexResponse(env, toCodexResponsesRequest(request));
    const raw = await upstream.text();
    if (!upstream.ok) {
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { /* handled below */ }
      throw new UpstreamError(`Codex upstream returned HTTP ${upstream.status}.`, upstream.status, payload);
    }
    return fromCodexResponses(request.model, parseCodexResponsesSse(raw));
  },
};
