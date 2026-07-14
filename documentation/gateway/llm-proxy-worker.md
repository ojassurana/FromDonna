# LLM Proxy Worker

## Purpose

`cloudflare/llm-proxy/` is the inference door for FromDonna sandboxes. It exposes an OpenAI-compatible HTTP API while **provider credentials stay in Cloudflare / the host relay**, never in E2B.

```text
sandbox Hermes
  Authorization: Bearer <capability>
  model: gpt-5.6-terra
       │
       ▼
LLM Proxy Worker  ──HTTPS + X-Relay-Token──►  Codex relay (host)  ──►  Codex / ChatGPT
```

Related: [telegram.md](./telegram.md) (how the gateway mints the capability per turn), [gateway.md](./gateway.md).

## Live deployment

| Piece | Value |
|-------|--------|
| Worker | `https://fromdonna-llm-proxy.code-df4.workers.dev` |
| Health | `GET /health` |
| Models | `GET /v1/models` |
| Completions | `POST /v1/chat/completions` |
| Catalog model | `gpt-5.6-terra` only (explicit; no aliases) |
| Sandbox base_url | baked in template `config/hermes/config.yaml` → `…/v1` |

### Secrets (Worker — never commit)

| Secret | Purpose |
|--------|---------|
| `RELAY_SHARED_SECRET` | `X-Relay-Token` to the Codex relay |
| `CODEX_ACCESS_TOKEN` / `CODEX_REFRESH_TOKEN` | Present on Worker historically; **live path uses the host relay’s Hermes credential** (see below) |

### Vars

| Var | Purpose |
|-----|---------|
| `CODEX_RELAY_URL` | HTTPS endpoint of the private Codex relay (currently ngrok-published) |

---

## Current behavior

| Concern | Behavior |
|---------|----------|
| Auth | `Authorization: Bearer …` required and non-empty; **contents not verified yet** |
| Model | Must be exactly `gpt-5.6-terra` |
| Non-stream | Returns normal OpenAI `chat.completion` JSON |
| Stream | Hermes often sends `stream: true`. Proxy still aggregates Codex server-side, then returns a **minimal OpenAI `text/event-stream`** (one content chunk + finish + `[DONE]`) so clients work without real token streaming |
| Token caps | Accepted at the edge; not always forwarded (Codex Responses rejects some fields) |
| Provider choice | Internal only; caller cannot pick provider |

### Security posture

Integration-stage proxy, not a hard multi-tenant security boundary yet. Any non-empty Bearer can call the allowed model. Do not expose the URL beyond sandboxes that receive Worker-minted capabilities until the capability verifier ships.

Planned verifier will: signature/expiry/audience, bind user + sandbox, authorize model policy, reject replay — without changing the public request shape.

---

## OAuth / relay model

Codex rejects direct Worker egress (`403`). Live path:

1. LLM proxy POSTs the Responses-shaped body to `CODEX_RELAY_URL`
2. Header `X-Relay-Token: RELAY_SHARED_SECRET`
3. Relay (`cloudflare/llm-proxy/relay/codex_relay.py`) resolves the host Hermes `openai-codex` runtime credential **per request** and calls Codex from allowed egress
4. Single OAuth authority stays on the Hermes host; Worker does not refresh or forward OAuth tokens on this path

**Ops caveat:** free ngrok URLs are session-bound. If the tunnel restarts, update `CODEX_RELAY_URL` and redeploy the LLM proxy (or use a stable domain).

Relay processes observed as local `codex_relay.py` + `ngrok http 9121` (systemd unit files exist under `relay/` but may not be enabled).

---

## How Telegram path uses this proxy

1. Gateway Worker mints `x-llm-capability` per turn (opaque nonce, not a provider key)
2. Harness sets `OPENAI_API_KEY=<capability>` and `OPENAI_BASE_URL=<proxy>/v1` only for that Hermes child process
3. Hermes oneshot uses provider `custom` + model `gpt-5.6-terra`
4. Proxy validates Bearer presence + model, calls relay, returns completion (JSON or SSE)

No Telegram, E2B, or Codex secrets are required inside the sandbox for inference.

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
npx wrangler secret put RELAY_SHARED_SECRET
# optional / legacy token secrets if still used by other paths
npx wrangler deploy
```

Smoke:

```bash
curl -sS https://fromdonna-llm-proxy.code-df4.workers.dev/health

curl -sS -X POST https://fromdonna-llm-proxy.code-df4.workers.dev/v1/chat/completions \
  -H 'authorization: Bearer smoke-test' \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.6-terra","messages":[{"role":"user","content":"Say only: ok"}]}'
```

Live logs:

```bash
npx wrangler tail fromdonna-llm-proxy --format pretty
```

## Adding providers later

Provider selection remains internal. Add a model→provider mapping and adapter; do not add a caller-controlled `provider` parameter. Future OAuth/API-key routes stay Worker-side.
