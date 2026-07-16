# Gateway ops runbook

Operational reference for the live Telegram → D1 → E2B Hermes → LLM proxy path.

See also: [telegram.md](./telegram.md), [gateway.md](./gateway.md), [llm-proxy-worker.md](./llm-proxy-worker.md), [../deployment/e2b-template.md](../deployment/e2b-template.md), [../deployment/memorymanagement.md](../deployment/memorymanagement.md), [../tooling/composio.md](../tooling/composio.md), [../tooling/general.md](../tooling/general.md).

---

## Architecture (as deployed)

```text
@fromdonna_bot
    │
    ▼
fromdonna-gateway  (Cloudflare Worker)
    │  secrets: TELEGRAM_*, E2B_API_KEY, WORKER_TO_HARNESS_SECRET, LLM_CAPABILITY_SECRET
    │  D1: fromdonna-routing.user_agents
    │  R2: USER_STATE → fromdonna-user-state (runtime checkpoints)
    │  (no EXA_API_KEY — that lives on api-proxy)
    │
    ├─ provision ──► E2B Sandbox.create(fromdonna-hermes)
    │                   │
    │                   ├─ GET  /health
    │                   ├─ POST /bootstrap  (secret + telegramProxy + userId)
    │                   └─ POST /internal/restore  (R2 checkpoint if any)
    │
    └─ inject ──────► POST https://8788-{sandboxId}.e2b.dev/telegram/update
                         Authorization: Bearer <harness secret>
                         x-llm-capability: <HMAC capability>
                              │
                              ▼
                         Official Hermes Telegram runtime in sandbox
                              │
                              ├─ outbound Bot API via gateway /telegram-bot-api/*
                              ├─ LLM via fromdonna-llm-proxy (real capability)
                              ├─ web_search via fromdonna-api-proxy (Exa, stub auth)
                              └─ after session: stage checkpoint → Worker pull → R2
```

---

## Service checklist

| Service | URL / location | Quick check |
|---------|----------------|-------------|
| Gateway Worker | `https://fromdonna-gateway.code-df4.workers.dev` | `GET /health` |
| LLM proxy | `https://fromdonna-llm-proxy.code-df4.workers.dev` | `GET /health` + chat completion |
| API proxy | `https://fromdonna-api-proxy.code-df4.workers.dev` | `GET /health` + Exa search (stub) |
| Telegram webhook | Bot API `getWebhookInfo` | URL matches gateway; `last_error` null |
| D1 | `fromdonna-routing` | `SELECT … FROM user_agents` |
| R2 checkpoints | `fromdonna-user-state` | manifest `users/{userId}/manifests/latest.json` |
| E2B template | alias `fromdonna-hermes` | `npm run build:prod` / smoke |
| Per-user harness | `https://8788-{id}.e2b.dev/health` | `auth_ready` + `telegram_proxy_ready` after bootstrap |

**Per-user resource model (D1 routing + E2B live runtime + R2 checkpoint):** see [../deployment/memorymanagement.md](../deployment/memorymanagement.md#three-per-user-resources).

---

## Status script (copy/paste)

```bash
# Auth for wrangler (example: global API key from hermes env)
set -a
source <(grep -E '^(CLOUDFLARE_EMAIL|CLOUDFLARE_GLOBAL_API_KEY)=' ~/.hermes/.env)
set +a
export CLOUDFLARE_API_KEY="$CLOUDFLARE_GLOBAL_API_KEY"
export CLOUDFLARE_ACCOUNT_ID="df4acced87263715777b0c2068d03b22"

echo "gateway:" && curl -sS https://fromdonna-gateway.code-df4.workers.dev/health
echo "llm:" && curl -sS https://fromdonna-llm-proxy.code-df4.workers.dev/health
echo "api:" && curl -sS https://fromdonna-api-proxy.code-df4.workers.dev/health

# Webhook (requires TELEGRAM_BOT_TOKEN in env)
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r.get("url"), r.get("last_error_message"), "pending", r.get("pending_update_count"))'

cd ~/FromDonna/cloudflare/gateway
npx wrangler d1 execute fromdonna-routing --remote --command \
  "SELECT gateway, gateway_user_id, status, runtime_provider, runtime_id, updated_at FROM user_agents ORDER BY updated_at DESC LIMIT 10;"
```

---

## Live logs

```bash
# Gateway (webhook + provision errors)
cd ~/FromDonna/cloudflare/gateway
npx wrangler tail fromdonna-gateway --format pretty

# LLM proxy (inference / relay failures)
cd ~/FromDonna/cloudflare/llm-proxy
npx wrangler tail fromdonna-llm-proxy --format pretty

# API proxy (Exa / HTTP connectors)
cd ~/FromDonna/cloudflare/api-proxy
npx wrangler tail fromdonna-api-proxy --format pretty
```

Note: the success path is quiet; `console.error` surfaces failures (harness HTTP errors, E2B create failures, etc.).

---

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Bot silent; webhook `last_error` set | Worker 5xx / timeout / wrong secret | `wrangler tail` gateway; re-check `TELEGRAM_WEBHOOK_SECRET` vs `setWebhook` |
| “Setting up… send again” loops | Stuck `provisioning` or slow E2B | Inspect D1 status; check E2B API / template |
| User forever broken after first fail | Old code without recovery | Current gateway re-provisions on `failed`; clear or wait for next message |
| Harness 401 unauthorized | Missing `/bootstrap` or wrong secret | Confirm provision path; re-bootstrap; ensure template has bootstrap endpoint |
| Harness 401 missing_llm_capability | Gateway not sending header | Deploy current gateway (`x-llm-capability`) |
| Hermes text is proxy stream error | Old LLM proxy rejecting `stream:true` | Deploy current llm-proxy (SSE shim) |
| All LLM calls fail | Relay/ngrok down or URL stale | Restart relay + ngrok; update `CODEX_RELAY_URL`; redeploy llm-proxy |
| Sandbox unreachable after idle | Paused without resume | Gateway `connect` + `autoResume`; manual `connect` if needed |

---

## Rotate secrets

Full Telegram Worker↔sandbox auth model: [telegram-auth.md](./telegram-auth.md).

```bash
cd ~/FromDonna/cloudflare/gateway

# Bot token (e.g. after BotFather revoke)
printf '%s' 'NEW_BOT_TOKEN' | npx wrangler secret put TELEGRAM_BOT_TOKEN
# then setWebhook again with TELEGRAM_WEBHOOK_SECRET

# Webhook secret (must match setWebhook secret_token)
printf '%s' 'NEW_WEBHOOK_SECRET' | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Harness shared secret (existing sandboxes need re-bootstrap on next turn or re-provision).
# Leak of this secret = treat Telegram bridge as compromised until rotated + sandboxes recreated.
printf '%s' 'NEW_HARNESS_SECRET' | npx wrangler secret put WORKER_TO_HARNESS_SECRET

# Composio session HMAC — must match on gateway AND composio-proxy.
# Rotating invalidates all Hermes MCP capability Bearers (users re-mint on next bootstrap).
printf '%s' 'NEW_COMPOSIO_SESSION_SECRET' | npx wrangler secret put COMPOSIO_SESSION_SECRET
# then: cd ../composio-proxy && same secret put COMPOSIO_SESSION_SECRET && npx wrangler deploy
```

Never commit secrets. Prefer `wrangler secret put` / env injection; do not paste into docs or git.

---

## Rebuild template after harness/config changes

Required after harness changes that affect sandbox behavior (Telegram proxy, **Composio MCP apply**, Exa env, SOUL, etc.).

```bash
cd ~/FromDonna/E2B-Template
# E2B_API_KEY in .env
npm run build:prod   # alias fromdonna-hermes
```

New users get the new image immediately. Existing sandboxes keep the old filesystem/process until recreated (see [e2b-template.md](../deployment/e2b-template.md) upgrade workflow). Composio OAuth connections in Composio’s vault are unchanged by a template rebuild.

---

## Deploy matrix

| Component | Command |
|-----------|---------|
| Gateway Worker | `cd cloudflare/gateway && npx wrangler deploy` |
| D1 migrations | `npx wrangler d1 migrations apply fromdonna-routing --remote` |
| LLM proxy | `cd cloudflare/llm-proxy && npx wrangler deploy` |
| API proxy | `cd cloudflare/api-proxy && npx wrangler secret put <VENDOR>_API_KEY && npx wrangler deploy` |
| Composio proxy | `cd cloudflare/composio-proxy && npx wrangler secret put COMPOSIO_API_KEY && npx wrangler secret put COMPOSIO_SESSION_SECRET && npx wrangler deploy` |
| E2B template | `cd E2B-Template && npm run build:prod` |
| Telegram webhook | Bot API `setWebhook` (see [telegram.md](./telegram.md)) |

- Adding a new product **HTTP API**: [../tooling/api-proxy-worker.md](../tooling/api-proxy-worker.md) (not gateway secrets).  
- **OAuth apps (Gmail etc.)**: [../tooling/composio.md](../tooling/composio.md) — key only on composio-proxy; rebuild template after harness changes.

---

## Checkpoint ops (Architecture B)

After agent use, the sandbox **stages** a filtered tar; the Worker **pulls** to R2 (not sandbox→Worker POST — CF 1010). On create/replace, Worker **restores**.

```bash
# Status (needs WORKER_TO_HARNESS_SECRET)
curl -sS -H "Authorization: Bearer $WORKER_TO_HARNESS_SECRET" \
  "https://fromdonna-gateway.code-df4.workers.dev/internal/checkpoint/status?userId=telegram:<id>"

# Or wrangler
npx wrangler r2 object get \
  "fromdonna-user-state/users/telegram:<id>/manifests/latest.json" \
  --file /tmp/man.json --remote && cat /tmp/man.json
```

Details: [../deployment/memorymanagement.md](../deployment/memorymanagement.md).

---

## Change log (implementation snapshot)

1. **Gateway Worker** — D1 routing, provision/replaceRuntime, E2B create/connect, bootstrap (incl. Composio mint), inject `/telegram/update`, Bot API proxy, R2 checkpoint harvest/restore
2. **Harness** — official Hermes Telegram runtime; `/health`, `/bootstrap` (+ `composioMcp`), `/telegram/update`, checkpoint export/restore
3. **E2B template** — `fromdonna-hermes` warm harness on 8788; checkpoint packer; agent-only config → llm-proxy; **web.backend: exa** via api-proxy; Composio MCP via composio-proxy
4. **API proxy** — `fromdonna-api-proxy`; Exa reverse proxy; real `EXA_API_KEY` only here; sandbox uses STUB + `EXA_BASE_URL`
5. **Composio proxy** — `fromdonna-composio-proxy`; `COMPOSIO_API_KEY` + session HMAC; Hermes MCP capability Bearer; sticky sessions in D1
6. **LLM proxy** — capability tokens; credentials stay off sandbox
7. **Secrets model** — no Telegram/Codex/Composio product key / user OAuth in sandboxes
8. **Runtime persistence** — Architecture B stage + Worker pull to R2; verified on live traffic
