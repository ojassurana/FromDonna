import assert from "node:assert/strict";
import test from "node:test";
import { mintSessionToken, verifySessionToken, bearerToken } from "../src/session_token";
import { defaultToolkits, resolveToolkits, DEFAULT_COMPOSIO_TOOLKITS } from "../src/toolkits";

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
