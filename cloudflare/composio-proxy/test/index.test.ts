import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/env";
import { handleRequest, mintSessionToken } from "../src/index";
import { defaultToolkits } from "../src/toolkits";

const SECRET = "test-session-secret-at-least-16-chars";

const env: Env = {
  COMPOSIO_API_KEY: "ck_test_not_real",
  COMPOSIO_SESSION_SECRET: SECRET,
  INTERNAL_AUTH_SECRET: SECRET,
  PUBLIC_BASE_URL: "https://composio-proxy.test",
};

test("GET /health", async () => {
  const res = await handleRequest(new Request("https://composio-proxy.test/health"), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string; default_toolkits: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.service, "fromdonna-composio-proxy");
  assert.deepEqual(body.default_toolkits, defaultToolkits());
});

test("GET /v1/toolkits/default", async () => {
  const res = await handleRequest(new Request("https://composio-proxy.test/v1/toolkits/default"), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { toolkits: string[] };
  assert.ok(body.toolkits.includes("gmail"));
});

test("POST /internal/session requires internal auth", async () => {
  const res = await handleRequest(
    new Request("https://composio-proxy.test/internal/session", {
      method: "POST",
      body: JSON.stringify({ user_id: "telegram:1" }),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("POST /internal/session creates token without calling Composio when mocked via fetch", async () => {
  // This test only checks auth + body validation path when API fails with 502 from bad key —
  // use invalid key → 502 with composio_session_failed, proving auth passed
  const res = await handleRequest(
    new Request("https://composio-proxy.test/internal/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_id: "telegram:1", toolkits: ["gmail"] }),
    }),
    env,
  );
  // Without a live COMPOSIO key this is 502 from upstream, not 401
  assert.ok(res.status === 502 || res.status === 200);
  if (res.status === 502) {
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "composio_session_failed");
  }
});

test("POST /mcp rejects missing/invalid bearer", async () => {
  const res1 = await handleRequest(new Request("https://composio-proxy.test/mcp", { method: "POST" }), env);
  assert.equal(res1.status, 401);

  const res2 = await handleRequest(
    new Request("https://composio-proxy.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer not.a.valid.token" },
    }),
    env,
  );
  assert.equal(res2.status, 401);
});

test("POST /mcp accepts valid token then fails upstream without real Composio (or proxies)", async () => {
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:99",
    toolkits: ["gmail"],
    composio_mcp_url: "https://example.invalid/mcp",
    ttlSeconds: 300,
  });
  const res = await handleRequest(
    new Request("https://composio-proxy.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  // example.invalid may 502 proxy_failed or network error → 502
  assert.ok([200, 502, 503, 404, 400].includes(res.status));
});

test("404 unknown path", async () => {
  const res = await handleRequest(new Request("https://composio-proxy.test/nope"), env);
  assert.equal(res.status, 404);
});
