# Gateway ops runbook

Operational reference for the live Telegram → D1 → E2B Hermes → LLM proxy path.

See also: [telegram.md](./telegram.md), [gateway.md](./gateway.md), [llm-proxy-worker.md](./llm-proxy-worker.md), [../deployment/e2b-template.md](../deployment/e2b-template.md).

---

## Architecture (as deployed)

```text
@fromdonna_bot
    │
    ▼
fromdonna-telegram-gateway  (Cloudflare Worker)
    │  secrets: TELEGRAM_*, E2B_API_KEY, WORKER_TO_HARNESS_SECRET
    │  D1: fromdonna-routing.user_agents (gateway-neutral)
    │
    ├─ provision ──► E2B Sandbox.create(fromdonna-hermes)
    │                   │
    │                   ├─ GET  /health
    │                   └─ POST /bootstrap  (harness auth)
    │
    └─ turn ────────► POST https://8788-{sandboxId}.e2b.dev/turn
                         Authorization: Bearer <harness secret>
                         x-llm-capability: <nonce>
                              │
                              ▼
                         Hermes oneshot (OPENAI_API_KEY=capability)
                              │
                              ▼
                         fromdonna-llm-proxy
                              │
                              ▼
                         Codex relay (host + ngrok) → model
```

---

## Service checklist

| Service | URL / location | Quick check |
|---------|----------------|-------------|
| Telegram gateway | `https://fromdonna-telegram-gateway.code-df4.workers.dev` | `GET /health` |
| LLM proxy | `https://fromdonna-llm-proxy.code-df4.workers.dev` | `GET /health` + chat completion |
| Telegram webhook | Bot API `getWebhookInfo` | URL matches gateway; `last_error` null |
| D1 | `fromdonna-routing` | `SELECT … FROM user_agents` |
| E2B template | alias `fromdonna-hermes` | `npm run smoke` in `E2B-Template` |
| Per-user harness | `https://8788-{id}.e2b.dev/health` | `auth_ready: true` after bootstrap |
| Codex relay | `CODEX_RELAY_URL` in llm-proxy `wrangler.toml` | process up; proxy completion works |

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

```bash
cd ~/FromDonna/cloudflare/gateway

# Bot token (e.g. after BotFather revoke)
printf '%s' 'NEW_BOT_TOKEN' | npx wrangler secret put TELEGRAM_BOT_TOKEN
# then setWebhook again with TELEGRAM_WEBHOOK_SECRET

# Webhook secret (must match setWebhook secret_token)
printf '%s' 'NEW_WEBHOOK_SECRET' | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Harness shared secret (existing sandboxes need re-bootstrap on next turn or re-provision)
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

## Change log (implementation snapshot)

Documented as of the FromDonna Telegram routing ship:

1. **Gateway Worker** — D1 routing, atomic provision claim, failed recovery, E2B create/connect, harness bootstrap, capability header, Telegram webhook with `waitUntil`
2. **Harness** — `/health`, `/bootstrap`, `/turn`; Hermes oneshot via LLM proxy only
3. **E2B template** — `fromdonna-hermes` warm harness on 8788; agent-only config pointing at llm-proxy
4. **LLM proxy** — accepts Hermes `stream:true` via aggregated OpenAI SSE response; credentials stay on relay path
5. **Secrets model** — no Telegram/Codex secrets in sandboxes; capability + harness secret only
