# LLM Proxy Worker

## Purpose

`cloudflare/llm-proxy/` is the inference door for FromDonna sandboxes. It exposes an OpenAI-compatible HTTP API while **provider credentials stay on the host relay / Hermes auth store**, never in E2B.

```text
sandbox Hermes
  Authorization: Bearer <capability>
  model: gpt-5.6-terra | grok-4.5 | …
       │
       ▼
LLM Proxy Worker  ──HTTPS + X-Relay-Token──►  host relay
                                              ├─ /v1/responses        → Codex / ChatGPT (openai-codex pool)
                                              └─ /v1/chat/completions → xAI Grok (xai-oauth)
```

Related: [telegram.md](./telegram.md) (how the gateway mints the capability per turn), [gateway.md](./gateway.md).

## Live deployment

| Piece | Value |
|-------|--------|
| Worker | `https://fromdonna-llm-proxy.code-df4.workers.dev` |
| Health | `GET /health` |
| Models | `GET /v1/models` |
| Completions | `POST /v1/chat/completions` |
| Catalog | `gpt-5.6-terra`, `grok-4.5`, `grok-4.3`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning` |
| Sandbox base_url | baked in template `config/hermes/config.yaml` → `…/v1` |

### Secrets (Worker — never commit)

| Secret | Purpose |
|--------|---------|
| `RELAY_SHARED_SECRET` | `X-Relay-Token` to the host relay |
| `LLM_CAPABILITY_SECRET` | HMAC for short-lived sandbox capabilities (shared with Telegram gateway) |
| `CODEX_ACCESS_TOKEN` / `CODEX_REFRESH_TOKEN` | Legacy; **live path uses host Hermes OAuth** for Codex and Grok |

### Vars

| Var | Purpose |
|-----|---------|
| `CODEX_RELAY_URL` | HTTPS URL of host relay Codex path (`…/v1/responses`) |
| `GROK_RELAY_URL` | Optional. Defaults to same host with path `/v1/chat/completions` |

---

## Current behavior

| Concern | Behavior |
|---------|----------|
| Auth | Bearer capability must be a valid HMAC (`sub` + `exp`) signed with `LLM_CAPABILITY_SECRET` |
| Model | Must be one of the catalog IDs above (explicit; no aliases / no `provider` field) |
| Routing | `gpt-*` → Codex adapter; `grok-*` catalog IDs → Grok adapter |
| Non-stream | Returns normal OpenAI `chat.completion` JSON |
| Stream | Proxy aggregates upstream, then returns a minimal OpenAI `text/event-stream` |
| Token caps | Accepted at the edge; Codex may not honor them upstream |
| Provider choice | Internal only; caller cannot pick provider |

### Security posture

Capability tokens are gateway-minted only. Do not put upstream OAuth or API keys in sandboxes.

---

## OAuth / relay model

### Codex

Codex rejects direct Worker egress (`403`). Live path:

1. LLM proxy POSTs Responses-shaped body to `CODEX_RELAY_URL`
2. Header `X-Relay-Token: RELAY_SHARED_SECRET`
3. Relay resolves Hermes **openai-codex pool** credential (pool-first) and calls Codex
4. 429s rotate the shared pool so gateway and proxy stay aligned

### Grok (xAI OAuth)

1. LLM proxy POSTs OpenAI chat-completions body to Grok relay path
2. Same `X-Relay-Token`
3. Relay calls `resolve_xai_oauth_runtime_credentials()` on the Hermes host and POSTs `https://api.x.ai/v1/chat/completions`
4. Single OAuth authority: Hermes `auth.json` `xai-oauth` (device-code), not Worker-copied tokens

**Ops caveat:** free ngrok URLs are session-bound. If the tunnel restarts, update `CODEX_RELAY_URL` and redeploy.

Relay: `cloudflare/llm-proxy/relay/codex_relay.py` (systemd: `fromdonna-codex-relay.service` + ngrok unit).

---

## How Telegram path uses this proxy

1. Gateway Worker mints HMAC capability per turn
2. Harness sets `OPENAI_API_KEY=<capability>` and `OPENAI_BASE_URL=<proxy>/v1` for that Hermes process
3. Hermes calls Chat Completions with an explicit catalog model
4. Proxy verifies capability + routes by model → host relay → provider

No Telegram, E2B, Codex, or xAI secrets are required inside the sandbox for inference.

---

## Local checks

```bash
cd cloudflare/llm-proxy
npm install
npm test
npm run check
```

## Deploy

```bash
cd cloudflare/llm-proxy
systemctl --user restart fromdonna-codex-relay.service
npx wrangler deploy
```

Smoke:

```bash
curl -sS https://fromdonna-llm-proxy.code-df4.workers.dev/health
curl -sS https://fromdonna-llm-proxy.code-df4.workers.dev/v1/models | jq .

# capability must be gateway-minted HMAC
curl -sS -X POST https://fromdonna-llm-proxy.code-df4.workers.dev/v1/chat/completions \
  -H 'authorization: Bearer ***' \
  -H 'content-type: application/json' \
  -d '{"model":"grok-4.5","messages":[{"role":"user","content":"Say only: ok"}]}'
```

Live logs:

```bash
npx wrangler tail fromdonna-llm-proxy --format pretty
```

## Adding providers later

Provider selection remains internal. Add a model→provider mapping and adapter; do not add a caller-controlled `provider` parameter. Future OAuth/API-key routes stay Worker/relay-side.
