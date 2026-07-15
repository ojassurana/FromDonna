import type { Env } from "./env";
import {
  ChatCompletionRequestError,
  type ChatContentPart,
  type JsonObject,
  type NormalizedChatCompletionRequest,
  type NormalizedChatCompletionResponse,
  type ProviderAdapter,
  UpstreamError,
} from "./openai";

export type { Env };

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
  const pushText = (text: unknown) => {
    if (typeof text === "string" && text.trim()) parts.push({ type: "text", text });
  };

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isObject(item)) continue;

    // Standard assistant message item.
    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isObject(content)) continue;
        if ((content.type === "output_text" || content.type === "text" || content.type === "summary_text") && typeof content.text === "string") {
          pushText(content.text);
        }
      }
    }

    // Reasoning-only models may emit summary text without a message item.
    if (item.type === "reasoning") {
      if (typeof item.content === "string") pushText(item.content);
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (isObject(part) && typeof part.text === "string") pushText(part.text);
        }
      }
    }

    // Some backends put plain text on the item itself.
    if (typeof item.text === "string") pushText(item.text);
  }

  if (!parts.length && typeof payload.output_text === "string") pushText(payload.output_text);
  return parts;
}

function extractToolCalls(payload: JsonObject): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const item of output) {
    if (!isObject(item)) continue;
    const type = typeof item.type === "string" ? item.type : "";
    // OpenAI Responses: function_call; some builds use custom_tool_call.
    if (type !== "function_call" && type !== "custom_tool_call") continue;
    const name = typeof item.name === "string" ? item.name : typeof item.tool_name === "string" ? item.tool_name : null;
    if (!name) continue;
    const id =
      (typeof item.call_id === "string" && item.call_id) ||
      (typeof item.id === "string" && item.id) ||
      `call_${calls.length + 1}`;
    let args = item.arguments;
    if (args == null && isObject(item.input)) args = item.input;
    if (typeof args !== "string") {
      try {
        args = JSON.stringify(args ?? {});
      } catch {
        args = "{}";
      }
    }
    calls.push({ id, type: "function", function: { name, arguments: args as string } });
  }
  return calls;
}

/** Convert a Codex Responses object to the provider-neutral completion result. */
export function fromCodexResponses(model: string, payload: JsonObject): NormalizedChatCompletionResponse {
  const toolCalls = extractToolCalls(payload);
  const content = responseTextParts(payload);
  const usage = isObject(payload.usage) ? payload.usage : {};
  return {
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
    content,
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
  const outputItems: JsonObject[] = [];
  const functionArgs = new Map<string, { name?: string; arguments: string; call_id?: string }>();

  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as JsonObject;
      const type = typeof event.type === "string" ? event.type : "";

      if (type === "response.completed" && isObject(event.response)) completed = event.response;
      if (type === "response.output_text.delta" && typeof event.delta === "string") textDelta += event.delta;
      // Alternate text delta event names used by some Responses backends.
      if ((type === "response.content_part.delta" || type === "response.text.delta") && typeof event.delta === "string") {
        textDelta += event.delta;
      }
      if (type === "response.output_item.done" && isObject(event.item)) {
        outputItems.push(event.item);
      }
      if (type === "response.function_call_arguments.delta") {
        const itemId = typeof event.item_id === "string" ? event.item_id : typeof event.output_index === "number" ? `idx_${event.output_index}` : "fn";
        const prev = functionArgs.get(itemId) || { arguments: "" };
        if (typeof event.delta === "string") prev.arguments += event.delta;
        if (typeof event.name === "string") prev.name = event.name;
        if (typeof event.call_id === "string") prev.call_id = event.call_id;
        functionArgs.set(itemId, prev);
      }
      if (type === "response.function_call_arguments.done") {
        const itemId = typeof event.item_id === "string" ? event.item_id : typeof event.output_index === "number" ? `idx_${event.output_index}` : "fn";
        const prev = functionArgs.get(itemId) || { arguments: "" };
        if (typeof event.arguments === "string") prev.arguments = event.arguments;
        if (typeof event.name === "string") prev.name = event.name;
        if (typeof event.call_id === "string") prev.call_id = event.call_id;
        functionArgs.set(itemId, prev);
      }
    } catch {
      /* ignore malformed upstream SSE frames */
    }
  }

  // Prefer the terminal snapshot; enrich it when the snapshot is sparse.
  if (completed) {
    if (!responseTextParts(completed).length && textDelta) completed.output_text = textDelta;
    const existing = Array.isArray(completed.output) ? (completed.output as unknown[]) : [];
    if (!existing.length && outputItems.length) completed.output = outputItems;
    if (!extractToolCalls(completed).length && functionArgs.size) {
      const synthesized = Array.from(functionArgs.entries()).map(([itemId, fn], i) => ({
        type: "function_call",
        id: itemId,
        call_id: fn.call_id || itemId || `call_${i + 1}`,
        name: fn.name || "unknown_tool",
        arguments: fn.arguments || "{}",
      }));
      completed.output = [...(Array.isArray(completed.output) ? (completed.output as unknown[]) : []), ...synthesized];
    }
    return completed;
  }

  const synthesizedOutput: JsonObject[] = [...outputItems];
  for (const [itemId, fn] of functionArgs.entries()) {
    synthesizedOutput.push({
      type: "function_call",
      id: itemId,
      call_id: fn.call_id || itemId,
      name: fn.name || "unknown_tool",
      arguments: fn.arguments || "{}",
    });
  }
  return {
    id: `resp_${crypto.randomUUID()}`,
    status: "completed",
    ...(textDelta ? { output_text: textDelta } : {}),
    ...(synthesizedOutput.length ? { output: synthesizedOutput } : {}),
  };
}

export const codexAdapter: ProviderAdapter<Env> = {
  async complete(env, request) {
    const upstream = await codexResponse(env, toCodexResponsesRequest(request));
    const raw = await upstream.text();
    if (!upstream.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        /* handled below */
      }
      throw new UpstreamError(`Codex upstream returned HTTP ${upstream.status}.`, upstream.status, payload);
    }
    const parsed = parseCodexResponsesSse(raw);
    const normalized = fromCodexResponses(request.model, parsed);
    // Never hand Hermes a successful empty completion when the upstream spent
    // tokens — keep a minimal diagnostic so the agent can recover instead of
    // thrashing "empty content" retries.
    if (!normalized.content.length && !normalized.toolCalls.length) {
      const usage = isObject(parsed.usage) ? parsed.usage : {};
      const outTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      if (outTokens > 0 || raw.includes("function_call") || raw.includes("output_text")) {
        console.error(
          JSON.stringify({
            msg: "codex_empty_mapping",
            model: request.model,
            outTokens,
            rawHead: raw.slice(0, 1500),
            parsedOutputTypes: Array.isArray(parsed.output)
              ? (parsed.output as unknown[]).map((item) => (isObject(item) ? item.type : typeof item))
              : [],
          }),
        );
      }
    }
    return normalized;
  },
};
