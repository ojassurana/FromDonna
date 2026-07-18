/**
 * Composio mint must prefer the COMPOSIO_PROXY service binding.
 * Public workers.dev fetch from a Worker returns CF error 1042.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getLastComposioMintError,
  mintComposioMcpAccess,
  type ComposioEnv,
} from "./composio";

function mockD1Empty(): D1Database {
  const first = vi.fn().mockResolvedValue(null);
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare } as unknown as D1Database;
}

describe("mintComposioMcpAccess", () => {
  it("uses COMPOSIO_PROXY service binding (not public workers.dev fetch)", async () => {
    const fetchCalls: string[] = [];
    const bindingFetch = vi.fn(async (req: Request) => {
      fetchCalls.push(new URL(req.url).pathname);
      return Response.json({
        ok: true,
        mcp_url: "https://fromdonna-composio-proxy.code-df4.workers.dev/mcp",
        mcp_token: "tok_test_abc",
        toolkits: ["gmail"],
        user_id: "telegram:1",
        composio_session_id: "trs_test",
        composio_mcp_url: "https://backend.composio.dev/tool_router/trs_test/mcp",
        reused_composio_session: false,
      });
    });

    const env: ComposioEnv = {
      FROMDONNA_ROUTING: mockD1Empty(),
      WORKER_TO_HARNESS_SECRET: "harness-secret-at-least-16",
      COMPOSIO_SESSION_SECRET: "session-secret-at-least-16",
      COMPOSIO_PROXY_URL: "https://fromdonna-composio-proxy.code-df4.workers.dev",
      COMPOSIO_PROXY: { fetch: bindingFetch } as unknown as Fetcher,
    };

    const globalFetch = vi.spyOn(globalThis, "fetch");

    const access = await mintComposioMcpAccess(env, "telegram:1", "rt1");
    expect(access).not.toBeNull();
    expect(access?.mcp_token).toBe("tok_test_abc");
    expect(access?.composio_session_id).toBe("trs_test");
    expect(bindingFetch).toHaveBeenCalled();
    expect(fetchCalls).toContain("/internal/session");
    // Must not fall back to public workers.dev (CF 1042)
    expect(globalFetch).not.toHaveBeenCalled();
    expect(getLastComposioMintError()).toBe("");

    globalFetch.mockRestore();
  });

  it("records mint HTTP 401 detail when binding returns unauthorized", async () => {
    const bindingFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized.", code: "unauthorized" } }), {
        status: 401,
      }),
    );
    const env: ComposioEnv = {
      FROMDONNA_ROUTING: mockD1Empty(),
      WORKER_TO_HARNESS_SECRET: "harness-secret-at-least-16",
      COMPOSIO_SESSION_SECRET: "session-secret-at-least-16",
      COMPOSIO_PROXY: { fetch: bindingFetch } as unknown as Fetcher,
    };
    const access = await mintComposioMcpAccess(env, "telegram:2", "rt2");
    expect(access).toBeNull();
    expect(getLastComposioMintError()).toMatch(/401/);
  });
});
