# LLM Proxy Worker

## Purpose

`cloudflare/llm-proxy/` is the Worker-facing inference door for FromDonna sandboxes. It gives the sandbox an OpenAI-compatible endpoint while credentials remain in Cloudflare, not E2B.

```text
sandbox ── Bearer capability token + explicit model ──> LLM Proxy Worker ──> provider
```

The sandbox never chooses a provider and never receives an upstream credential.

## Current state

- Routes: `GET /v1/models` and `POST /v1/chat/completions`
- The catalog advertises exactly `gpt-5.6-terra`; requests require that explicit model ID (no default or aliases).
- The model routes internally to the ChatGPT/Codex OAuth provider.
- The Worker calls Codex Responses with its required upstream stream, aggregates it, and returns a normal non-streaming OpenAI chat-completions JSON response.
- Non-streaming only for callers. `stream: true` returns a clear OpenAI-shaped error. Client token caps are accepted at the OpenAI-compatible edge but not forwarded because ChatGPT's Codex endpoint rejects `max_output_tokens`.
- A `Bearer` capability token is **required syntactically**, but its contents are intentionally not verified or authorized yet.
- Codex OAuth starts from Worker secrets `CODEX_ACCESS_TOKEN` and `CODEX_REFRESH_TOKEN`. Mutable token state is kept in the bound `CODEX_TOKENS` KV namespace so rotated refresh tokens survive beyond one request.

### Current security posture

This is an integration-stage proxy, not a sandbox security boundary yet. Any caller holding any non-empty Bearer token can invoke an allowed `gpt-*` model. Do not give its URL to untrusted callers until capability verification ships.

## OAuth provisioning

The initial credential comes from the maintainer's existing Hermes `openai-codex` OAuth session and is copied only into Cloudflare Worker secrets:

- never commit either token
- never place either token in E2B or sandbox configuration
- never print either token in command output or logs
- the local Hermes credential remains unchanged

The Worker reads a cached/rotated pair from KV, falls back to the secret pair once, and stores a successful refresh result back in KV.

### Live verification status

- Codex rejects direct Worker egress with `403`, so the Worker forwards only the request and a relay-auth secret over HTTPS to a private relay running on the Hermes host. The relay resolves Hermes's active `openai-codex` runtime credential **for every request** and performs the Codex call from the allowed host egress.
- This is intentionally a single OAuth authority: the Worker never reads, stores, refreshes, or forwards Codex OAuth tokens. When Hermes refreshes or changes its active credential, the next proxy request uses that exact live Hermes credential.
- The relay is currently published through an ngrok endpoint. The end-to-end route reaches Codex (it returned Codex's `429 The usage limit has been reached`, rather than the former Worker-egress `403`).
- The current ngrok free endpoint is session-bound. Before production use, reserve a stable relay domain or automate relay-URL rotation and Worker redeploy on relay restart.

## Planned: capability-token detector

The next security step is a capability-token detector/verifier at the Worker boundary.

It will:

1. verify token signature, issuer, expiry, and audience;
2. bind the request to the authenticated user and sandbox;
3. authorize the `llm` connector and the exact requested model or model policy;
4. reject replayed/revoked tokens where applicable;
5. emit safe audit metadata (user, sandbox, model, provider, timing), without storing prompt content by default.

The public API will not change: callers still send an explicit model and `Authorization: Bearer <capability-token>`. Only the Worker begins enforcing the token.

## Adding providers later

Provider selection remains internal. Add a model-to-provider mapping and a provider adapter; do not add a caller-controlled `provider` parameter. Future OAuth/API-key credential routes remain Worker-side.

## Local checks

```bash
cd cloudflare/llm-proxy
npm install
npm test
npm run check
```

## Deployment prerequisites

1. Create a Cloudflare KV namespace and replace `REPLACE_WITH_CREATED_KV_NAMESPACE_ID` in `wrangler.toml`.
2. Provision `CODEX_ACCESS_TOKEN` and `CODEX_REFRESH_TOKEN` from the existing local Hermes Codex OAuth store through `wrangler secret put` without printing them.
3. Deploy with Wrangler using the FromDonna Cloudflare account.
4. Confirm `GET /health`, then make a real `POST /v1/chat/completions` request with an explicit GPT model and a non-empty temporary Bearer token.
