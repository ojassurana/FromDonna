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

---

## Protocol: adding another API connector

Use this whenever you add a **plain HTTP API** (product key, no OAuth-in-sandbox). Same pattern as Exa. Do **not** put the key on the gateway Worker or in E2B.

### Rules (always)

1. **Real key** → `cloudflare/api-proxy` only (`wrangler secret put …`).
2. **Sandbox** gets a **placeholder** (today: `STUB`) + public base URL to api-proxy.
3. Prefer **official SDK / HTTP shape** the agent already expects; reverse-proxy by rewriting auth headers (and optional `base_url` if the SDK supports it).
4. **Gateway** stays channel/D1/E2B only — no product API keys.
5. **Never commit** real API keys.
6. After template-facing changes: **rebuild E2B template** so new users pick them up.

### Checklist

| Step | Where | What |
|------|--------|------|
| 1. Route + proxy | `cloudflare/api-proxy/src/` | Add `/v1/<vendor>/…` (allowlist paths). Stub auth → inject real secret → upstream. |
| 2. Env type | `cloudflare/api-proxy/src/env.ts` | New secret field on `Env`. |
| 3. Tests | `cloudflare/api-proxy/test/` | 401 without stub; path allowlist; secret never returned; mock upstream. |
| 4. Secret + deploy | ops | `npx wrangler secret put <VENDOR>_API_KEY` then `npx wrangler deploy` |
| 5. Sandbox wiring | `E2B-Template/` | Placeholder env + base URL (template `setEnvs` and/or harness bootstrap). Prefer SDK `base_url` if available. |
| 6. Agent config | Hermes config / tools | Enable the tool or backend (e.g. `web.backend: exa`). Install SDK deps in `template.ts` if needed. |
| 7. Docs | this file + `general.md` | List routes, secret name, sandbox env. Update `ops.md` health/tail if useful. |
| 8. Template rebuild | `E2B-Template` | `npm run build:prod` (alias `fromdonna-hermes`) |

### Path convention

```text
https://fromdonna-api-proxy…/v1/<vendor>/<upstream-path>
```

Examples:

| Vendor | Sandbox base | Proxy paths | Upstream |
|--------|--------------|-------------|----------|
| Exa (live) | `{API_PROXY}/v1/exa` | `/search`, `/contents` | `https://api.exa.ai` |
| Next API | `{API_PROXY}/v1/<name>` | vendor-specific allowlist | vendor host |

### Auth (today vs later)

| Today (MVP) | Later |
|-------------|--------|
| `x-api-key: STUB` (or Bearer STUB) | Short-lived HMAC capability (gateway-minted, api-proxy-verified), same family as LLM proxy |

Leave a `// TODO: real capability` when adding routes; do not invent a third auth model.

### What not to do

- Put product API keys on **gateway** or **llm-proxy**
- Bake real keys into **E2B template** / `config.yaml` / create `envVars`
- Auto-failover across paid providers without an explicit product decision
- Skip template rebuild when sandbox env/config/deps changed

### Reference implementation

**Exa** — `cloudflare/api-proxy/src/exa.ts`, Hermes patch `E2B-Template/hermes/plugins/web/exa/provider.py` (`EXA_BASE_URL`), template env + `web.backend: exa`, harness `_apply_exa_proxy_env`.
