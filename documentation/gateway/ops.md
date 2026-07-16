# Gateway ops runbook

Operational reference for the live Telegram → D1 → E2B Hermes → LLM proxy path.

See also: [telegram.md](./telegram.md), [gateway.md](./gateway.md), [llm-proxy-worker.md](./llm-proxy-worker.md), [../deployment/e2b-template.md](../deployment/e2b-template.md), [../deployment/memorymanagement.md](../deployment/memorymanagement.md).

---

## Architecture (as deployed)

```text
@fromdonna_bot
    │
    ▼
fromdonna-telegram-gateway  (Cloudflare Worker)
    │  secrets: TELEGRAM_*, E2B_API_KEY, WORKER_TO_HARNESS_SECRET, LLM_CAPABILITY_SECRET
    │  D1: fromdonna-routing.user_agents
    │  R2: USER_STATE → fromdonna-user-state (runtime checkpoints)
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
                         Official Hermes Telegram gateway in sandbox
                              │
                              ├─ outbound Bot API via Worker /telegram-bot-api/*
                              ├─ LLM via fromdonna-llm-proxy (capability only)
                              └─ after session: stage checkpoint → Worker pull → R2
```

---

## Service checklist

| Service | URL / location | Quick check |
|---------|----------------|-------------|
| Telegram gateway | `https://fromdonna-telegram-gateway.code-df4.workers.dev` | `GET /health` |
| LLM proxy | `https://fromdonna-llm-proxy.code-df4.workers.dev` | `GET /health` + chat completion |
| Telegram webhook | Bot API `getWebhookInfo` | URL matches gateway; `last_error` null |
| D1 | `fromdonna-routing` | `SELECT … FROM user_agents` |
| R2 checkpoints | `fromdonna-user-state` | manifest `users/{userId}/manifests/latest.json` |
| E2B template | alias `fromdonna-hermes` | `npm run build:prod` / smoke |
| Per-user harness | `https://8788-{id}.e2b.dev/health` | `auth_ready` + `telegram_proxy_ready` after bootstrap |

---

## Status script (copy/paste)

```bash
# Auth for wrangler (example: global API key from hermes env)
set -a
source <(grep -E '^(CLOUDFLARE_EMAIL|CLOUDFLARE_GLOBAL_API_KEY)=' ~/.hermes/.env)
set +a
export CLOUDFLARE_API_KEY="$CLOUDFLARE_GLOBAL_API_KEY"
export CLOUDFLARE_ACCOUNT_ID="df4acced87263715777b0c2068d03b22"

echo "gateway:" && curl -sS https://fromdonna-telegram-gateway.code-df4.workers.dev/health
echo "llm:" && curl -sS https://fromdonna-llm-proxy.code-df4.workers.dev/health

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
npx wrangler tail fromdonna-telegram-gateway --format pretty

# LLM proxy (inference / relay failures)
cd ~/FromDonna/cloudflare/llm-proxy
npx wrangler tail fromdonna-llm-proxy --format pretty
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
```

Never commit secrets. Prefer `wrangler secret put` / env injection; do not paste into docs or git.

---

## Rebuild template after harness/config changes

```bash
cd ~/FromDonna/E2B-Template
# E2B_API_KEY in .env
npm run build:prod
```

New users get the new image immediately. Existing sandboxes keep the old filesystem/process until recreated (see [e2b-template.md](../deployment/e2b-template.md) upgrade workflow).

---

## Deploy matrix

| Component | Command |
|-----------|---------|
| Gateway Worker | `cd cloudflare/gateway && npx wrangler deploy` |
| D1 migrations | `npx wrangler d1 migrations apply fromdonna-routing --remote` |
| LLM proxy | `cd cloudflare/llm-proxy && npx wrangler deploy` |
| E2B template | `cd E2B-Template && npm run build:prod` |
| Telegram webhook | Bot API `setWebhook` (see [telegram.md](./telegram.md)) |

---

## Checkpoint ops (Architecture B)

After agent use, the sandbox **stages** a filtered tar; the Worker **pulls** to R2 (not sandbox→Worker POST — CF 1010). On create/replace, Worker **restores**.

```bash
# Status (needs WORKER_TO_HARNESS_SECRET)
curl -sS -H "Authorization: Bearer $WORKER_TO_HARNESS_SECRET" \
  "https://fromdonna-telegram-gateway.code-df4.workers.dev/internal/checkpoint/status?userId=telegram:<id>"

# Or wrangler
npx wrangler r2 object get \
  "fromdonna-user-state/users/telegram:<id>/manifests/latest.json" \
  --file /tmp/man.json --remote && cat /tmp/man.json
```

Details: [../deployment/memorymanagement.md](../deployment/memorymanagement.md).

---

## Change log (implementation snapshot)

1. **Gateway Worker** — D1 routing, provision/replaceRuntime, E2B create/connect, bootstrap, inject `/telegram/update`, Bot API proxy, R2 checkpoint harvest/restore
2. **Harness** — official Hermes Telegram gateway; `/health`, `/bootstrap`, `/telegram/update`, `/internal/checkpoint/export`, `/internal/restore`
3. **E2B template** — `fromdonna-hermes` warm harness on 8788; checkpoint packer; agent-only config → llm-proxy
4. **LLM proxy** — capability tokens; credentials stay off sandbox
5. **Secrets model** — no Telegram/Codex/R2 long-lived keys in sandboxes
6. **Runtime persistence** — Architecture B stage + Worker pull to R2; verified on live traffic
