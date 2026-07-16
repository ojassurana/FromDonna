/**
 * FromDonna API connectors Worker (fromdonna-api-proxy).
 *
 * Holds plain HTTP API secrets (Exa first) and reverse-proxies sandbox traffic.
 * Does not own channels (gateway) or model inference (llm-proxy).
 */

import type { Env } from "./env";
import { handleExaRequest } from "./exa";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "fromdonna-api-proxy",
      connectors: ["exa"],
      auth: "stub", // TODO: real capability HMAC
    });
  }

  if (url.pathname === "/v1/exa" || url.pathname.startsWith("/v1/exa/")) {
    return handleExaRequest(request, env, url.pathname);
  }

  return json({ error: { message: "Not found.", code: "not_found" } }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("api-proxy error:", error instanceof Error ? error.message : error);
      return json({ error: { message: "Internal error.", code: "internal_error" } }, 500);
    }
  },
};
