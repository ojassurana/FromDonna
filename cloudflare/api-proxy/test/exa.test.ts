import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/env";
import {
  handleExaRequest,
  presentedCredential,
  upstreamPath,
  validStubAuth,
} from "../src/exa";

const env: Env = {
  EXA_API_KEY: "real-exa-secret-never-leak",
  API_STUB_TOKEN: "STUB",
};

test("upstreamPath allowlists search and contents only", () => {
  assert.equal(upstreamPath("/v1/exa/search"), "/search");
  assert.equal(upstreamPath("/v1/exa/contents"), "/contents");
  assert.equal(upstreamPath("/v1/exa/crawl"), null);
  assert.equal(upstreamPath("/v1/exa"), null);
  assert.equal(upstreamPath("/search"), null);
});

test("presentedCredential reads x-api-key and Bearer", () => {
  assert.equal(
    presentedCredential(new Request("https://x/v1/exa/search", { headers: { "x-api-key": "STUB" } })),
    "STUB",
  );
  assert.equal(
    presentedCredential(
      new Request("https://x/v1/exa/search", { headers: { authorization: "Bearer STUB" } }),
    ),
    "STUB",
  );
  assert.equal(presentedCredential(new Request("https://x/v1/exa/search")), null);
});

test("validStubAuth rejects missing or wrong stub", () => {
  assert.equal(validStubAuth(env, new Request("https://x")), false);
  assert.equal(
    validStubAuth(env, new Request("https://x", { headers: { "x-api-key": "WRONG" } })),
    false,
  );
  assert.equal(
    validStubAuth(env, new Request("https://x", { headers: { "x-api-key": "STUB" } })),
    true,
  );
});

test("handleExaRequest 401 without stub", async () => {
  const res = await handleExaRequest(
    new Request("https://api.example/v1/exa/search", {
      method: "POST",
      body: JSON.stringify({ query: "x" }),
    }),
    env,
    "/v1/exa/search",
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_stub_token");
});

test("handleExaRequest 404 for disallowed path", async () => {
  const res = await handleExaRequest(
    new Request("https://api.example/v1/exa/crawl", {
      method: "POST",
      headers: { "x-api-key": "STUB" },
      body: "{}",
    }),
    env,
    "/v1/exa/crawl",
  );
  assert.equal(res.status, 404);
});

test("proxy swaps stub for real key and never returns secret", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const res = await handleExaRequest(
    new Request("https://api.example/v1/exa/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "STUB" },
      body: JSON.stringify({ query: "Hermes agent", numResults: 2 }),
    }),
    env,
    "/v1/exa/search",
    fetchImpl,
  );

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].headers.get("x-api-key"), "real-exa-secret-never-leak");
  assert.notEqual(calls[0].headers.get("x-api-key"), "STUB");

  const text = await res.text();
  assert.equal(text.includes("real-exa-secret-never-leak"), false);
  assert.equal(text.includes("STUB"), false);
  const parsed = JSON.parse(text) as { results: unknown[] };
  assert.equal(parsed.results.length, 1);
});

test("503 when EXA_API_KEY missing", async () => {
  const res = await handleExaRequest(
    new Request("https://api.example/v1/exa/search", {
      method: "POST",
      headers: { "x-api-key": "STUB" },
      body: "{}",
    }),
    { EXA_API_KEY: "", API_STUB_TOKEN: "STUB" },
    "/v1/exa/search",
  );
  assert.equal(res.status, 503);
});
