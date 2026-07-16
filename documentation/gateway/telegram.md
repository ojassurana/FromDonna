# Telegram gateway

## Scope

Telegram-specific adapter on the **shared Cloudflare Worker** (see [gateway.md](./gateway.md)).

All users share **one Telegram bot** (`@fromdonna_bot`). The bot token lives **only on the Worker**, never in E2B / Hermes sandboxes.

**Auth detail (Worker ↔ sandbox, Bot API proxy, threat model):** [telegram-auth.md](./telegram-auth.md).

Source: `cloudflare/gateway/`

---

## Live deployment (FromDonna)

| Piece | Value |
|-------|--------|
| Gateway Worker | `https://fromdonna-telegram-gateway.code-df4.workers.dev` |
| Webhook | `POST /telegram/webhook` |
| Health | `GET /health` |
| D1 database | `fromdonna-routing` (`FROMDONNA_ROUTING` binding) |
| D1 table | `user_agents` (gateway-neutral) |
| E2B template | `fromdonna-hermes` |
| Sandbox domain default | `e2b.dev` |
| Harness port | `8788` |
| LLM path | Sandbox → `fromdonna-llm-proxy` with per-turn capability only |

### Worker secrets (never commit)

| Secret | Purpose |
|--------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token; outbound `sendMessage` only from Worker |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram `secret_token`; checked via `X-Telegram-Bot-Api-Secret-Token` |
| `E2B_API_KEY` | Create / connect / resume sandboxes |
| `WORKER_TO_HARNESS_SECRET` | Worker → harness auth; injected into process via `/bootstrap` |

### Worker vars (`wrangler.toml`)

| Var | Value |
|-----|--------|
| `E2B_TEMPLATE` | `fromdonna-hermes` |
| `HARNESS_PORT` | `8788` |
| `E2B_SANDBOX_DOMAIN` | `e2b.dev` |

### Worker bindings

| Binding | Resource |
|---------|----------|
| `FROMDONNA_ROUTING` | D1 `fromdonna-routing` |
| `USER_STATE` | R2 `fromdonna-user-state` (runtime checkpoints) |

Also: `LLM_CAPABILITY_SECRET` (HMAC for short-lived proxy tokens).

---

## User experience

From the user side: **DM the bot → get a private Hermes**. No setup, no “pick a sandbox,” no extra friction.

1. User texts `@fromdonna_bot`
2. Worker looks up their `(gateway, gateway_user_id)` identity in D1
3. **No row / failed** → create E2B runtime, `/health`, `/bootstrap`, **R2 restore if any**, mark `ready`
4. **Ready** → connect/resume → inject update into **official Hermes Telegram gateway** in the sandbox
5. Hermes replies via **Worker Bot API proxy** (sandbox never holds the real bot token)
6. After the agent session finishes → sandbox **stages** a checkpoint; Worker **pulls** it to R2 (Architecture B)

Concurrent first messages: only one request wins the D1 insert claim; others see `provisioning` and are asked to retry shortly. Failed provisions self-heal on the next message. Dead/broken runtimes use `replaceRuntime` (new box + restore + kill old).

---

## End-to-end flow

```
User DMs @fromdonna_bot
  → Telegram servers
  → POST /telegram/webhook (secret header verified)
  → Worker ACKs Telegram immediately (ctx.waitUntil)
  → D1 lookup (gateway, gateway_user_id)
       ├─ missing / failed → claim → E2B create → /health → /bootstrap
       │                      → R2 restore (if any) → status=ready
       └─ ready             → E2B connect (resume + TTL) → re-bootstrap if needed
  → POST /telegram/update  (Bearer + x-llm-capability)
  → Official Hermes TelegramAdapter.process_update
  → Outbound Telegram via Worker /telegram-bot-api/* proxy
  → (async) stage checkpoint → Worker harvest → R2
```

### What the Worker injects

Raw Telegram `Update` JSON to:

`POST https://8788-{runtimeId}.{domain}/telegram/update`

Headers:

- `Authorization: Bearer <WORKER_TO_HARNESS_SECRET>`
- `x-llm-capability: <HMAC capability>` — short-lived; not a real provider key

Bootstrap also sends `userId`, `workerUrl`, and `telegramProxy` (proxy token + Bot API base URLs). See [telegram-auth.md](./telegram-auth.md).

### What never enters the sandbox

- Real Telegram bot token
- Codex / OAuth tokens
- Relay shared secret
- E2B API key
- Long-lived R2 credentials

---

## D1 schema

Migrations: `cloudflare/gateway/migrations/`

```sql
-- user_agents: gateway-neutral user → runtime routing
user_id TEXT PRIMARY KEY                -- stable product identity, e.g. telegram:1063008785
gateway TEXT NOT NULL                   -- telegram | whatsapp | discord | ...
gateway_user_id TEXT NOT NULL           -- identity native to that gateway
gateway_conversation_id TEXT NOT NULL   -- current delivery/conversation target
runtime_provider TEXT NOT NULL           -- currently e2b
runtime_id TEXT NOT NULL                 -- currently the E2B sandbox id
runtime_domain TEXT                      -- runtime host domain, e.g. e2b.dev
status TEXT NOT NULL                    -- provisioning | ready | failed
UNIQUE (gateway, gateway_user_id)
provisioning_started_at TEXT
created_at / updated_at
```

| Status | Meaning |
|--------|---------|
| `provisioning` | Claim row inserted; E2B create in progress (or concurrent loser) |
| `ready` | Sandbox id stored; harness bootstrapped |
| `failed` | Create/bootstrap failed; next message attempts recovery |

---

## Sandbox harness contract

Source: `E2B-Template/harness/server.py`  
Warm-started on port **8788** in the template.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | none | Liveness; `auth_ready`, `telegram_proxy_ready`, `gateway_running` |
| `POST` | `/bootstrap` | body secret | Inject harness secret + Telegram proxy config + identity |
| `POST` | `/telegram/update` | Bearer + `x-llm-capability` | Inject raw Telegram Update into official Hermes gateway |
| `GET` | `/internal/checkpoint/export` | Bearer | Worker pulls staged runtime checkpoint |
| `POST` | `/internal/restore` | Bearer | Worker pushes R2 checkpoint after create/replace |
| `POST` | `/turn` | Bearer + capability | Legacy path (not the primary Telegram flow) |

### Why `/bootstrap` exists

Template warm-start freezes the uvicorn process env at **image build** time. Create-time `envVars` are visible to new shells but **not** to the already-running harness. The Worker therefore:

1. Creates the sandbox (may still pass `envVars` for future processes)
2. Waits for `/health`
3. `POST /bootstrap` with secret + telegramProxy + userId/workerUrl
4. **Restores R2 checkpoint** if present (`POST /internal/restore`)
5. Marks the D1 row `ready`

Best-effort re-bootstrap runs before later turns (idempotent if the same secret).

### Runtime checkpoint (Architecture B)

See [../deployment/memorymanagement.md](../deployment/memorymanagement.md).

```text
After Hermes session finishes → stage tar on sandbox disk
Worker harvest (separate waitUntil):
  → GET /internal/checkpoint/export  and/or  E2B envd file read
  → R2 users/{userId}/checkpoint.tar.gz + manifests/latest.json
Also: pull at start of next message; pull before replace/kill when possible
```

Sandbox → Worker **POST** of the tar is **not** the live path (Cloudflare **1010** from E2B to `workers.dev`).

Worker endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/internal/checkpoint` | Optional push (ops/tests; not relied on from E2B) |
| `GET` | `/internal/checkpoint/status?userId=` | Ops: exists / size / manifest |

---

## E2B lifecycle (Worker)

On create:

- `autoPause: true`
- `autoResume: { enabled: true }`
- `timeout: 3600` (seconds) — E2B max continuous TTL; each connect extends
- `secure: true`
- `allow_internet_access: true`
- metadata: `fromdonna_user_id`

Before each inject:

- `POST /sandboxes/{id}/connect` with `{ timeout: 3600 }` to resume if paused and extend TTL
- Host URL shape: `https://{HARNESS_PORT}-{sandboxId}.{domain}/…`  
  (E2B may omit `domain` in create response; Worker defaults to `e2b.dev`)

If connect is **404** or inject/bootstrap stays broken → **`replaceRuntime`**: new sandbox from template, restore R2, kill old id.

---

## Implementation notes

| Topic | Behavior |
|-------|----------|
| Webhook ACK | Telegram is ACKed with `{ ok: true }` immediately; provision + inject + harvest in `waitUntil` |
| Message types | Text, callbacks, media updates allowed (webhook `allowed_updates`); official Hermes handles UX |
| Outbound | Sandbox Hermes via Bot API proxy — Worker does not re-render agent text on the happy path |
| Errors | User gets a short “try again” message; details go to Worker logs only |
| Free Workers plan | No custom `cpu_ms`; long turns depend on network wait + platform limits |

---

## Ops

### Deploy gateway

```bash
cd cloudflare/gateway
# Cloudflare auth (email + global key, or CLOUDFLARE_API_TOKEN)
npx wrangler d1 migrations apply fromdonna-routing --remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put E2B_API_KEY
npx wrangler secret put WORKER_TO_HARNESS_SECRET
npx wrangler deploy
```

### Point Telegram webhook

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{
    \"url\": \"https://fromdonna-telegram-gateway.code-df4.workers.dev/telegram/webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\", \"edited_message\", \"callback_query\", \"inline_query\", \"chosen_inline_result\", \"my_chat_member\", \"chat_member\", \"chat_join_request\", \"message_reaction\", \"message_reaction_count\"],
    \"drop_pending_updates\": false
  }"
```

Or (uses Worker secrets, no token in shell):

```bash
SECRET="$WORKER_TO_HARNESS_SECRET"
curl -sS -X POST "https://fromdonna-telegram-gateway.code-df4.workers.dev/admin/rebind-webhook" \
  -H "authorization: Bearer ${SECRET}"
```

**Critical:** `allowed_updates` must include `callback_query` or inline keyboard button presses never reach the Worker.

### Live logs

```bash
cd cloudflare/gateway
npx wrangler tail fromdonna-telegram-gateway --format pretty
```

Success path is mostly quiet (errors use `console.error`). Pair with LLM proxy tail if diagnosing model path:

```bash
cd cloudflare/llm-proxy
npx wrangler tail fromdonna-llm-proxy --format pretty
```

### Status checks

```bash
# Gateway
curl -sS https://fromdonna-telegram-gateway.code-df4.workers.dev/health

# Webhook
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"

# D1 rows
cd cloudflare/gateway
npx wrangler d1 execute fromdonna-routing --remote --command \
  "SELECT gateway, gateway_user_id, status, runtime_provider, runtime_id, updated_at FROM user_agents ORDER BY updated_at DESC LIMIT 10;"

# Harness for a known sandbox
curl -sS "https://8788-<sandboxId>.e2b.dev/health"
```

---

## Why one bot works for many users

Telegram already scopes traffic by `chat_id` / user id.  
Multi-tenant = **gateway-neutral routing table** on the Worker (`gateway identity → user → runtime`), not multiple bots.

## What does *not* run in the sandbox

- `hermes gateway` with `TELEGRAM_BOT_TOKEN`
- Direct calls to `api.telegram.org` using the product bot token
- Shared Hermes process that holds the token for all users

Hermes in E2B is **agent-only**: tools + LLM loop for **one** user.

## Relation to gateway-agnostic design

Telegram is **one adapter**. Same Worker can own WhatsApp and future channels ([gateway.md](./gateway.md)).  
After the Telegram adapter normalizes the update, the path is identical: **user → sandbox → reply → channel send**.
