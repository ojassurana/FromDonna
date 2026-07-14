import { codexResponse, type Env } from "./codex";
import { providerForModel, SUPPORTED_MODELS } from "./models";
import {
  errorResponse,
  parseResponsesSse,
  toChatCompletion,
  toChatCompletionSse,
  toResponsesInput,
  type ChatCompletionRequest,
} from "./openai";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
  if (request.method === "GET" && url.pathname === "/v1/models") {
    return Response.json({
      object: "list",
      data: SUPPORTED_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "fromdonna" })),
    });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return errorResponse(404, "Not found.", "not_found");

  // Intentional temporary contract: require a capability-token-shaped bearer
  // credential now, but do not verify or authorize it until the detector ships.
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    return errorResponse(401, "A capability token is required.", "missing_capability_token");
  }

  let input: ChatCompletionRequest;
  try { input = await request.json() as ChatCompletionRequest; } catch { return errorResponse(400, "Request body must be JSON.", "invalid_json"); }
  if (!input.model) return errorResponse(400, "'model' is required.", "model_required");
  if (!Array.isArray(input.messages) || input.messages.length === 0) return errorResponse(400, "'messages' must be a non-empty array.", "messages_required");
  if (!providerForModel(input.model)) return errorResponse(404, `The model '${input.model}' is not available.`, "model_not_found");

  try {
    const upstream = await codexResponse(env, {
      model: input.model,
      // The ChatGPT/Codex backend rejects persisted Responses objects.
      store: false,
      stream: true,
      input: toResponsesInput(input.messages),
      // ChatGPT's Codex Responses endpoint rejects the public Responses API's
      // max_output_tokens field.  Accept OpenAI-compatible client caps at the
      // edge, but do not forward an unsupported parameter upstream.
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      try { return Response.json(JSON.parse(raw), { status: upstream.status }); }
      catch { return errorResponse(502, `Codex upstream returned HTTP ${upstream.status}.`, "upstream_error"); }
    }
    const payload = parseResponsesSse(raw);
    // Hermes oneshot requests stream=true; return OpenAI-compatible SSE while
    // still aggregating Codex server-side (no provider credentials in sandboxes).
    if (input.stream) {
      return new Response(toChatCompletionSse(input.model, payload), {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    return Response.json(toChatCompletion(input.model, payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex upstream request failed.";
    return errorResponse(502, message, "upstream_error");
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
