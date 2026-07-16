import assert from "node:assert/strict";
import test from "node:test";
import {
  mintSessionToken,
  verifySessionToken,
  refreshSessionToken,
  needsRefresh,
  bearerToken,
} from "../src/session_token";
import { defaultToolkits, resolveToolkits, DEFAULT_COMPOSIO_TOOLKITS } from "../src/toolkits";
import { DEFAULT_SESSION_TTL_SECONDS, sessionTtlSeconds } from "../src/env";

const SECRET = "test-session-secret-at-least-16-chars";

test("defaultToolkits matches product allowlist length", () => {
  assert.equal(defaultToolkits().length, 16);
  assert.ok(defaultToolkits().includes("gmail"));
  assert.ok(defaultToolkits().includes("dropbox_sign"));
  assert.equal(DEFAULT_COMPOSIO_TOOLKITS.length, 16);
});

test("resolveToolkits never expands beyond default allowlist", () => {
  assert.deepEqual(resolveToolkits(null), defaultToolkits());
  assert.deepEqual(resolveToolkits([]), defaultToolkits());
  assert.deepEqual(resolveToolkits(["gmail", "github"]), ["gmail", "github"]);
  assert.deepEqual(resolveToolkits(["gmail", "slack", "not_real"]), ["gmail"]);
  // empty after filter → fall back to full default
  assert.deepEqual(resolveToolkits(["slack", "zoom"]), defaultToolkits());
});

test("mint and verify session token", async () => {
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:123",
    toolkits: ["gmail", "github"],
    runtime_id: "sbx_abc",
    composio_session_id: "trs_test",
    composio_mcp_url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
    ttlSeconds: 600,
  });
  assert.ok(token.includes("."));
  const claims = await verifySessionToken(SECRET, token);
  assert.ok(claims);
  assert.equal(claims!.user_id, "telegram:123");
  assert.deepEqual(claims!.toolkits, ["gmail", "github"]);
  assert.equal(claims!.composio_session_id, "trs_test");
  assert.ok(claims!.exp > Math.floor(Date.now() / 1000));
});

test("verify rejects wrong secret and expired token", async () => {
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:1",
    toolkits: ["gmail"],
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  assert.equal(await verifySessionToken(SECRET, token), null);
  assert.equal(await verifySessionToken("other-secret-16chars!", token), null);
});

test("verify rejects tampered payload", async () => {
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:1",
    toolkits: ["gmail"],
    ttlSeconds: 600,
  });
  const [body, sig] = token.split(".");
  const tampered = `${body!.slice(0, -2)}xx.${sig}`;
  assert.equal(await verifySessionToken(SECRET, tampered), null);
});

test("bearerToken parses Authorization header", () => {
  assert.equal(
    bearerToken(new Request("https://x/mcp", { headers: { authorization: "Bearer abc.def" } })),
    "abc.def",
  );
  assert.equal(bearerToken(new Request("https://x/mcp")), null);
});

test("production default TTL is at least 30 days", () => {
  assert.ok(DEFAULT_SESSION_TTL_SECONDS >= 30 * 24 * 3600);
  assert.equal(sessionTtlSeconds({} as never), DEFAULT_SESSION_TTL_SECONDS);
  assert.equal(sessionTtlSeconds({ SESSION_TTL_SECONDS: "2592000" } as never), 2592000);
  // Floor 1h
  assert.equal(sessionTtlSeconds({ SESSION_TTL_SECONDS: "30" } as never), 3600);
});

test("refreshSessionToken extends exp with same user claims", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:42",
    toolkits: ["gmail", "github"],
    composio_session_id: "trs_sticky",
    composio_mcp_url: "https://backend.composio.dev/tool_router/trs_sticky/mcp",
    exp: now + 60,
  });
  const prior = await verifySessionToken(SECRET, token, now);
  assert.ok(prior);
  const refreshed = await refreshSessionToken(SECRET, prior!, 30 * 24 * 3600, now);
  const next = await verifySessionToken(SECRET, refreshed, now);
  assert.ok(next);
  assert.equal(next!.user_id, "telegram:42");
  assert.deepEqual(next!.toolkits, ["gmail", "github"]);
  assert.equal(next!.composio_session_id, "trs_sticky");
  assert.ok(next!.exp >= now + 30 * 24 * 3600 - 5);
  assert.ok(next!.exp > prior!.exp);
});

test("verify allows grace window for refresh of expired token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await mintSessionToken(SECRET, {
    user_id: "telegram:7",
    toolkits: ["gmail"],
    exp: now - 100,
  });
  assert.equal(await verifySessionToken(SECRET, token, now), null);
  const grace = await verifySessionToken(SECRET, token, now, 3600);
  assert.ok(grace);
  assert.equal(grace!.user_id, "telegram:7");
});

test("needsRefresh detects near-expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(needsRefresh({ user_id: "u", toolkits: [], exp: now + 60 }, 3600, now), true);
  assert.equal(needsRefresh({ user_id: "u", toolkits: [], exp: now + 48 * 3600 }, 3600, now), false);
});
