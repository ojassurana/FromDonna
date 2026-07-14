export type JsonObject = Record<string, unknown>;

/** OpenAI Chat Completions content parts, kept structured through the proxy. */
export type ChatContentPart = JsonObject & { type: string };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};

export type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: JsonObject[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
};

/** Provider-neutral request passed to an upstream adapter. */
export type NormalizedChatMessage = {
  role: OpenAIMessage["role"];
  content: ChatContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: OpenAIToolCall[];
};

export type NormalizedChatCompletionRequest = {
  model: string;
  messages: NormalizedChatMessage[];
  tools?: JsonObject[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  maxTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  stream?: boolean;
};

export type NormalizedToolCall = OpenAIToolCall;

/** Provider-neutral result returned by an upstream adapter. */
export type NormalizedChatCompletionResponse = {
  id?: string;
  created?: number;
  content: ChatContentPart[];
  toolCalls: NormalizedToolCall[];
  finishReason: "stop" | "length" | "tool_calls";
  usage?: { inputTokens?: number; outputTokens?: number };
};

export interface ProviderAdapter<Env> {
  complete(env: Env, request: NormalizedChatCompletionRequest): Promise<NormalizedChatCompletionResponse>;
}

export class ChatCompletionRequestError extends Error {}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(status: number, message: string, code: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code } },
    { status },
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContent(content: OpenAIMessage["content"], role: OpenAIMessage["role"], index: number): ChatContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === undefined || content === null) {
    if (role === "assistant") return [];
    throw new ChatCompletionRequestError(`messages[${index}].content is required for ${role} messages.`);
  }
  if (!Array.isArray(content)) throw new ChatCompletionRequestError(`messages[${index}].content must be a string or content-part array.`);
  return content.map((part, partIndex) => {
    if (!isObject(part) || typeof part.type !== "string" || !part.type) {
      throw new ChatCompletionRequestError(`messages[${index}].content[${partIndex}] must be an object with a type.`);
    }
    // Copy the complete typed part. Adapters must either map it deliberately or
    // reject it; this bridge never degrades non-text content to an empty string.
    return { ...part, type: part.type };
  });
}

function normalizeToolCalls(value: unknown, index: number): OpenAIToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ChatCompletionRequestError(`messages[${index}].tool_calls must be an array.`);
  return value.map((call, callIndex) => {
    if (!isObject(call) || typeof call.id !== "string" || call.type !== "function" || !isObject(call.function)
      || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") {
      throw new ChatCompletionRequestError(`messages[${index}].tool_calls[${callIndex}] must be an OpenAI function tool call.`);
    }
    return {
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    };
  });
}

/** Validate and normalize public OpenAI input without binding it to any provider. */
export function normalizeChatCompletionRequest(input: unknown): NormalizedChatCompletionRequest {
  if (!isObject(input)) throw new ChatCompletionRequestError("Request body must be a JSON object.");
  if (typeof input.model !== "string" || !input.model) throw new ChatCompletionRequestError("'model' is required.");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new ChatCompletionRequestError("'messages' must be a non-empty array.");
  }

  const messages = input.messages.map((message, index) => {
    if (!isObject(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role))) {
      throw new ChatCompletionRequestError(`messages[${index}].role is invalid.`);
    }
    const role = message.role as OpenAIMessage["role"];
    const toolCalls = normalizeToolCalls(message.tool_calls, index);
    if (role === "tool" && typeof message.tool_call_id !== "string") {
      throw new ChatCompletionRequestError(`messages[${index}].tool_call_id is required for tool messages.`);
    }
    return {
      role,
      content: normalizeContent(message.content as OpenAIMessage["content"], role, index),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
      ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
  });

  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.some((tool) => !isObject(tool)))) {
    throw new ChatCompletionRequestError("'tools' must be an array of objects.");
  }
  if (input.parallel_tool_calls !== undefined && typeof input.parallel_tool_calls !== "boolean") {
    throw new ChatCompletionRequestError("'parallel_tool_calls' must be a boolean.");
  }

  return {
    model: input.model,
    messages,
    ...(Array.isArray(input.tools) ? { tools: input.tools as JsonObject[] } : {}),
    ...(input.tool_choice !== undefined ? { toolChoice: input.tool_choice } : {}),
    ...(typeof input.parallel_tool_calls === "boolean" ? { parallelToolCalls: input.parallel_tool_calls } : {}),
    ...(typeof input.max_tokens === "number" ? { maxTokens: input.max_tokens } : {}),
    ...(typeof input.max_completion_tokens === "number" ? { maxCompletionTokens: input.max_completion_tokens } : {}),
    ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
    ...(typeof input.stream === "boolean" ? { stream: input.stream } : {}),
  };
}

function contentText(content: ChatContentPart[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export function toChatCompletion(model: string, response: NormalizedChatCompletionResponse): JsonObject {
  const inputTokens = Number(response.usage?.inputTokens ?? 0);
  const outputTokens = Number(response.usage?.outputTokens ?? 0);
  const text = contentText(response.content);
  const message: JsonObject = {
    role: "assistant",
    // The Chat Completions response schema represents assistant text as a
    // string/null (rather than an array), so only its explicit text parts are
    // rendered here. Other content was never discarded on the request path.
    content: text || null,
  };
  if (response.toolCalls.length) message.tool_calls = response.toolCalls;
  return {
    id: response.id ?? `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: response.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: response.finishReason }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

/** Convert an already-complete normalized result into OpenAI Chat Completion SSE. */
export function toChatCompletionSse(model: string, response: NormalizedChatCompletionResponse): string {
  const completion = toChatCompletion(model, response);
  const id = completion.id as string;
  const created = completion.created as number;
  const base = { id, object: "chat.completion.chunk", created, model };
  const frames: JsonObject[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }];
  const text = contentText(response.content);
  if (text) frames.push({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  response.toolCalls.forEach((call, index) => {
    frames.push({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, id: call.id, type: "function", function: call.function }] },
        finish_reason: null,
      }],
    });
  });
  frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: response.finishReason }] });
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}
