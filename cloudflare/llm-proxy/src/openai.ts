export type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string | Array<{ type?: string; text?: string }>;
};

export type ChatCompletionRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
};

export function errorResponse(status: number, message: string, code: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code } },
    { status },
  );
}

function messageText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.text ?? "").join("");
}

export function toResponsesInput(messages: OpenAIMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: messageText(message.content) }],
  }));
}

export function responseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : ""))
    .filter((text): text is string => typeof text === "string")
    .join("");
}

export function parseResponsesSse(text: string): Record<string, unknown> {
  let completed: Record<string, unknown> | null = null;
  let textDelta = "";
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === "response.completed" && event.response && typeof event.response === "object") completed = event.response as Record<string, unknown>;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") textDelta += event.delta;
    } catch { /* ignore malformed SSE frames */ }
  }
  if (completed) {
    // Codex's terminal response snapshot can contain usage but an empty
    // `output` array; the text arrives only in preceding delta events.
    if (!responseText(completed) && textDelta) completed.output_text = textDelta;
    return completed;
  }
  return { id: `resp_${crypto.randomUUID()}`, status: "completed", output_text: textDelta };
}

export function toChatCompletion(model: string, payload: Record<string, unknown>): Record<string, unknown> {
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
  const inputTokens = Number((usage as { input_tokens?: number }).input_tokens ?? 0);
  const outputTokens = Number((usage as { output_tokens?: number }).output_tokens ?? 0);
  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: responseText(payload) }, finish_reason: payload.status === "incomplete" ? "length" : "stop" }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}
