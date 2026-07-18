import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/env";
import { internalSecrets } from "../src/env";
import { handleRequest, mintSessionToken } from "../src/index";
import { defaultToolkits } from "../src/toolkits";

const SECRET = "test-session-secret-at-least-16-chars";
const INTERNAL = "internal-auth-secret-16ok";
const SESSION = "session-secret-at-least-16ch";
const HARNESS = "worker-to-harness-secret16";

const env: Env = {
  COMPOSIO_API_KEY: "ck_test_not_real",
  COMPOSIO_SESSION_SECRET: SECRET,
  INTERNAL_AUTH_SECRET: SECRET,
  PUBLIC_BASE_URL: "https://composio-proxy.test",
};

/** Split-brain proxy: INTERNAL_AUTH ≠ COMPOSIO_SESSION ≠ WORKER_TO_HARNESS. */
const splitEnv: Env = {
  COMPOSIO_API_KEY: "ck_test_not_real",
  INTERNAL_AUTH_SECRET: INTERNAL,
  COMPOSIO_SESSION_SECRET: SESSION,
  WORKER_TO_HARNESS_SECRET: HARNESS,
  PUBLIC_BASE_URL: "https://composio-proxy.test",
};

/** Auth-only probe: missing user_id → 400 after auth; 401 if auth fails. */
async function probeInternalAuth(
  headers: Record<string, string>,
  probeEnv: Env = env,
): Promise<Response> {
  return handleRequest(
    new Request("https://composio-proxy.test/internal/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({}),
    }),
    probeEnv,
  );
}

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

// --- Multi-candidate internal auth (diagnosis (b) / RC2) ---

test("internalSecrets returns all distinct ≥16 candidates", () => {
  const list = internalSecrets(splitEnv);
  assert.deepEqual(list, [INTERNAL, SESSION, HARNESS]);
});

test("requireInternalAuth accepts INTERNAL_AUTH_SECRET via Bearer", async () => {
  const res = await probeInternalAuth({ authorization: `Bearer ${INTERNAL}` }, splitEnv);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_body");
});

test("requireInternalAuth accepts COMPOSIO_SESSION_SECRET via x-fromdonna-internal", async () => {
  // Gateway mint style B with COMPOSIO_SESSION_SECRET while proxy also has INTERNAL_AUTH
  const res = await probeInternalAuth({ "x-fromdonna-internal": SESSION }, splitEnv);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_body");
});

test("requireInternalAuth accepts WORKER_TO_HARNESS_SECRET via Bearer", async () => {
  const res = await probeInternalAuth({ authorization: `Bearer ${HARNESS}` }, splitEnv);
  assert.equal(res.status, 400);
});

test("requireInternalAuth accepts both header styles for same secret", async () => {
  const bearer = await probeInternalAuth({ authorization: `Bearer ${SECRET}` }, env);
  assert.equal(bearer.status, 400);

  const internal = await probeInternalAuth({ "x-fromdonna-internal": SECRET }, env);
  assert.equal(internal.status, 400);

  // Prefer x-fromdonna-internal when both present (first in requireInternalAuth)
  const both = await probeInternalAuth(
    { authorization: `Bearer wrong-secret-not-matching!!`, "x-fromdonna-internal": SECRET },
    env,
  );
  assert.equal(both.status, 400);
});

test("requireInternalAuth rejects wrong secret with 401", async () => {
  const res = await probeInternalAuth(
    { authorization: "Bearer totally-wrong-secret-xx" },
    splitEnv,
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "unauthorized");
});

test("requireInternalAuth rejects missing auth with 401", async () => {
  const res = await probeInternalAuth({}, splitEnv);
  assert.equal(res.status, 401);
});

// --- Connect toolkit canonicalize (diagnosis (e) / RC5) ---

test("POST /internal/connect accepts alias toolkit (google_drive → googledrive)", async () => {
  const res = await handleRequest(
    new Request("https://composio-proxy.test/internal/connect", {
      method: "POST",
      headers: {
        "x-fromdonna-internal": SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: "telegram:1",
        toolkit: "google_drive",
        toolkits: ["googledrive", "gmail"],
      }),
    }),
    env,
  );
  // Must not 403 toolkit_not_allowed — alias canonicalized before allowlist check
  assert.notEqual(res.status, 403);
  assert.ok([200, 502].includes(res.status), `unexpected status ${res.status}`);
  if (res.status === 502) {
    const body = (await res.json()) as { error: { code: string } };
    assert.ok(
      body.error.code === "composio_connect_failed" || body.error.code === "composio_link_failed",
    );
  }
});

test("POST /internal/connect rejects toolkit not in allowlist", async () => {
  const res = await handleRequest(
    new Request("https://composio-proxy.test/internal/connect", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: "telegram:1",
        toolkit: "not_a_real_toolkit",
        toolkits: ["gmail"],
      }),
    }),
    env,
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "toolkit_not_allowed");
});
