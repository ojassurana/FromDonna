# API Proxy Worker

## Purpose

`cloudflare/api-proxy/` is the **dedicated door for plain HTTP API connectors** (Exa first). Product API keys stay on this Worker; E2B sandboxes never receive them.

```text
sandbox Hermes (exa-py)
  EXA_API_KEY=STUB
  EXA_BASE_URL=https://fromdonna-api-proxy…/v1/exa
       │
       ▼
API Proxy Worker  ──x-api-key: real secret──►  https://api.exa.ai
  POST /v1/exa/search
  POST /v1/exa/contents
```

Related: [general.md](./general.md) (connector buckets), [../gateway/llm-proxy-worker.md](../gateway/llm-proxy-worker.md) (inference door), [../gateway/gateway.md](../gateway/gateway.md) (channels + E2B).

**Rule:** API connector secrets do **not** live on the gateway Worker or in sandboxes.

## Live deployment

| Piece | Value |
|-------|--------|
| Worker | `https://fromdonna-api-proxy.code-df4.workers.dev` |
| Health | `GET /health` |
| Exa search | `POST /v1/exa/search` |
| Exa contents | `POST /v1/exa/contents` |
| Upstream | `https://api.exa.ai` |

### Secrets (Worker — never commit)

| Secret | Purpose |
|--------|---------|
| `EXA_API_KEY` | Real Exa cloud key; injected only on upstream requests |

```bash
cd cloudflare/api-proxy
npx wrangler secret put EXA_API_KEY
npx wrangler deploy
```

### Vars

| Var | Purpose |
|-----|---------|
| `API_STUB_TOKEN` | Expected sandbox credential (default `STUB`) until real capability HMAC |

## Sandbox contract

| Env | Value |
|-----|--------|
| `EXA_API_KEY` | `STUB` (placeholder only) |
| `EXA_BASE_URL` | `{API_PROXY}/v1/exa` |
| `FROMDONNA_API_PROXY_URL` | Public api-proxy base (no secrets) |
| Hermes `web.backend` | `exa` (baked in template) |

Hermes uses the official Exa SDK (`exa-py`) with `base_url` override (FromDonna patch in `plugins/web/exa/provider.py`).

## Auth (current)

**Stub MVP:** request must present `x-api-key: STUB` (or `Authorization: Bearer STUB`). Wrong/missing → `401`.

**TODO:** short-lived HMAC capability (gateway-minted, api-proxy-verified), same family as LLM capability — not wired yet.

## Routes

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/health` | Liveness + connector list |
| `POST` | `/v1/exa/search` | Proxy → `api.exa.ai/search` |
| `POST` | `/v1/exa/contents` | Proxy → `api.exa.ai/contents` |
| other | `*` | `404` |

## Smoke

```bash
API_PROXY=https://fromdonna-api-proxy.code-df4.workers.dev
curl -sS "$API_PROXY/health"
curl -sS -X POST "$API_PROXY/v1/exa/search" \
  -H 'content-type: application/json' \
  -H 'x-api-key: STUB' \
  -d '{"query":"Hermes agent","numResults":2,"contents":{"highlights":true}}'
```

## Threat model

| In sandbox | On api-proxy |
|------------|--------------|
| Stub token + public base URL | Real `EXA_API_KEY` |
| Can call only what proxy allows | Can spend Exa credits |

Do not put `EXA_API_KEY` in the E2B template, gateway secrets, or git.
