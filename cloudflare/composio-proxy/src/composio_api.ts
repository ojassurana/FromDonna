/**
 * Thin fetch client for Composio Tool Router REST (no SDK required on Workers).
 * https://backend.composio.dev/api/v3/tool_router/session
 */

export const COMPOSIO_API_BASE = "https://backend.composio.dev";

export type ComposioSessionResult = {
  session_id: string;
  mcp: { type: string; url: string; headers?: Record<string, string> };
  tool_router_tools?: string[];
  config?: { user_id?: string; toolkits?: unknown };
};

export type ComposioLinkResult = {
  redirect_url?: string;
  redirectUrl?: string;
  connection_request?: { redirect_url?: string };
  [key: string]: unknown;
};

function apiKeyHeader(apiKey: string): HeadersInit {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function createToolRouterSession(
  apiKey: string,
  userId: string,
  toolkits: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ComposioSessionResult> {
  const res = await fetchImpl(`${COMPOSIO_API_BASE}/api/v3/tool_router/session`, {
    method: "POST",
    headers: apiKeyHeader(apiKey),
    body: JSON.stringify({
      user_id: userId,
      toolkits: { enable: toolkits },
      // Prefer not to give sandboxes a remote bash by default
      sandbox: { enable: false },
      // Keep manage-connections so Hermes can surface OAuth login URLs
      manage_connections: { enable: true },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`composio session create HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as ComposioSessionResult;
  if (!data.session_id || !data.mcp?.url) {
    throw new Error("composio session create: missing session_id or mcp.url");
  }
  return data;
}

export async function createToolkitLink(
  apiKey: string,
  sessionId: string,
  toolkit: string,
  callbackUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ComposioLinkResult> {
  const res = await fetchImpl(
    `${COMPOSIO_API_BASE}/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/link`,
    {
      method: "POST",
      headers: apiKeyHeader(apiKey),
      body: JSON.stringify({
        toolkit,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`composio link HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as ComposioLinkResult;
}

export function extractRedirectUrl(link: ComposioLinkResult): string | null {
  return (
    link.redirect_url ||
    link.redirectUrl ||
    link.connection_request?.redirect_url ||
    (typeof link["redirect_uri"] === "string" ? link["redirect_uri"] : null) ||
    null
  );
}

/** Reverse-proxy an MCP HTTP request to Composio's hosted session MCP URL. */
export async function proxyToComposioMcp(
  request: Request,
  composioMcpUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const inbound = new URL(request.url);
  const targetBase = new URL(composioMcpUrl);
  // Preserve path suffix after /mcp if client hits /mcp/...
  const suffix = inbound.pathname.replace(/^\/mcp\/?/, "") || "";
  const target = new URL(targetBase.href);
  if (suffix) {
    target.pathname = target.pathname.replace(/\/?$/, "/") + suffix;
  }
  target.search = inbound.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("authorization"); // our token must not go upstream
  // Composio may accept x-api-key; also keep any session-specific headers if URL embeds auth
  headers.set("x-api-key", apiKey);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error duplex required for streaming body in some runtimes
    init.duplex = "half";
  }

  return fetchImpl(target.href, init);
}
