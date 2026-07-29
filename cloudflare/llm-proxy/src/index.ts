import type { Env } from "./env";
import { adapterForModel, SUPPORTED_MODELS } from "./models";
import {
  ChatCompletionRequestError,
  errorResponse,
  normalizeChatCompletionRequest,
  toChatCompletion,
  toChatCompletionSse,
  UpstreamError,
} from "./openai";

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Validate the gateway's short-lived HMAC capability before spending relay
 * credentials, and return its subject. The subject doubles as the pool routing
 * key: it is already authenticated and stable per caller, so no new plumbing is
 * needed to keep one caller pinned to one upstream endpoint.
 */
async function capabilitySubject(env: Env, authorization: string | null): Promise<string | null> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return null;
  const [payloadPart, signaturePart] = token.split(".");
  const payload = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!payload || !signature || payload.byteLength > 1024 || signature.byteLength !== 32) return null;
  let parsed: { sub?: unknown; exp?: unknown };
  try { parsed = JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof parsed.sub !== "string" || !parsed.sub || typeof parsed.exp !== "number" || !Number.isInteger(parsed.exp) || parsed.exp < now || parsed.exp > now + 16 * 60) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LLM_CAPABILITY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return (await crypto.subtle.verify("HMAC", key, signature, payload)) ? parsed.sub : null;
}

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

  // Only the gateway Worker can mint this short-lived HMAC capability.
  const subject = await capabilitySubject(env, request.headers.get("Authorization"));
  if (!subject) {
    return errorResponse(401, "A valid capability token is required.", "invalid_capability_token");
  }

  let input: ReturnType<typeof normalizeChatCompletionRequest>;
  try {
    input = normalizeChatCompletionRequest(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request body must be JSON.";
    return errorResponse(400, message, error instanceof ChatCompletionRequestError ? "invalid_request" : "invalid_json");
  }

  const adapter = adapterForModel(input.model);
  if (!adapter) return errorResponse(404, `The model '${input.model}' is not available.`, "model_not_found");

  try {
    const result = await adapter.complete(env, input, { key: subject });
    if (input.stream) {
      return new Response(toChatCompletionSse(input.model, result), {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    return Response.json(toChatCompletion(input.model, result));
  } catch (error) {
    if (error instanceof ChatCompletionRequestError) return errorResponse(400, error.message, "invalid_request");
    if (error instanceof UpstreamError && error.payload !== undefined) return Response.json(error.payload, { status: error.status });
    const message = error instanceof Error ? error.message : "Upstream request failed.";
    return errorResponse(502, message, "upstream_error");
  }
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
