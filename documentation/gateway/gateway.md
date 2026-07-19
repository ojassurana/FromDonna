# Gateway (agnostic)

## Role

One **Cloudflare Worker** is the **gateway king** at the edge.

It owns every messaging channel’s **network boundary** (Telegram webhook today; WhatsApp later): channel secrets, routing, E2B lifecycle, and reverse proxies (Bot API, LLM capability mint, Composio mint via service binding).

It does **not** own the agent brain, prompts, tools, or slash-command UX. Those live in the per-user E2B sandbox (official Hermes + harness).

**Live Telegram implementation:** [telegram.md](./telegram.md) · auth [telegram-auth.md](./telegram-auth.md) · source `cloudflare/gateway/`  
**LLM door for sandboxes:** [llm-proxy-worker.md](./llm-proxy-worker.md) · source `cloudflare/llm-proxy/`  
**API connectors door:** [../tooling/api-proxy-worker.md](../tooling/api-proxy-worker.md) · source `cloudflare/api-proxy/`  
**OAuth apps door:** [../tooling/composio.md](../tooling/composio.md) · source `cloudflare/composio-proxy/`

The gateway holds **channel** secrets (bot tokens, etc.) and shared session HMACs (e.g. `COMPOSIO_SESSION_SECRET`). It does **not** hold product API keys such as Exa or `COMPOSIO_API_KEY` — those live on **api-proxy** / **composio-proxy** only.

## Core idea (shipped product rule)

```text
User (any app)
  → Channel network (Telegram / …)
  → Worker (webhook verify + D1 route + E2B lifecycle + secret doors)
  → User’s E2B sandbox (official Hermes channel adapter + agent)
  → Worker reverse proxies (Bot API / LLM / API / Composio as needed)
  → Same channel network
  → User
```

| Rule | Meaning |
|------|---------|
| **Worker = wire only** | Webhook in, Bot API proxy out, D1 routing, E2B create/connect, mint capabilities, R2 checkpoint harvest/restore |
| **Sandbox = full Hermes brain** | Official channel adapter (Telegram today), `~/.hermes`, tools, sessions — not a dumb `{text}` reply RPC |
| **Real channel tokens stay on Worker** | Sandbox gets a **proxy token** + custom base URL, never `TELEGRAM_BOT_TOKEN` |
| **Many users, one bot** | Identity is platform user/chat id + D1 row, not “who holds the token” |
| **One user → one primary sandbox** | Create/resume on demand; pause when idle (E2B autoPause + autoResume) |

**Three per-user resources** (D1 row + E2B sandbox + R2 prefix): [../deployment/memorymanagement.md#three-per-user-resources](../deployment/memorymanagement.md#three-per-user-resources).

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Channel network edge | Worker | Verify webhook, ACK fast, hold real bot/token secrets |
| Identity & routing | Worker + D1 | Map channel identity → `userId` → `runtime_id` / status |
| Provision | Worker + E2B API | Create sandbox, `/health`, `/bootstrap` (auth + proxies + Composio), **R2 restore** |
| Agent + official channel adapter | E2B (per user) | Hermes `GatewayRunner` / `TelegramAdapter`, tools, memory; **proxy** channel credentials only |
| Outbound channel | Sandbox → Worker Bot API proxy | Hermes sends via Worker; Worker swaps in real token |
| Checkpoint | Worker + R2 | Harvest staged tar after use; restore on create/replace |
| Inference | LLM proxy Worker | OpenAI-compatible edge; real credentials stay off sandbox |
| API connectors | API proxy Worker | Exa (etc.); product HTTP keys off sandbox and off gateway |
| OAuth apps | Composio proxy Worker | MCP door; gateway mints capability via **service binding** (not public `workers.dev` fetch) |

## What the Worker injects (Telegram today)

**Not** a flat internal chat DTO and **not** a Worker-owned “agent returns `{ text }` then Worker `sendMessage`” loop.

Live path:

1. Telegram `Update` JSON (raw) → Worker webhook  
2. Worker → sandbox `POST /telegram/update` (Bearer harness secret + short-lived `x-llm-capability`)  
3. Official Hermes **TelegramAdapter** processes the update in-sandbox  
4. Outbound Bot API calls leave the sandbox toward the Worker **`/telegram-bot-api/*`** proxy (per-user HMAC proxy token)  
5. Worker attaches the real bot token and talks to Telegram  

Bootstrap also sends `userId`, `workerUrl`, and `telegramProxy` (proxy token + Bot API base URLs). See [telegram-auth.md](./telegram-auth.md) and [telegram.md](./telegram.md).

Auth to the sandbox control plane:

- `Authorization: Bearer <WORKER_TO_HARNESS_SECRET>` (Worker ↔ harness)
- `x-llm-capability: <short-lived nonce>` (Worker-minted; Hermes uses as API key against the LLM proxy only)

**No** bot tokens, LLM provider keys, Exa keys, or `COMPOSIO_API_KEY` in inject/bootstrap bodies.

## Secrets rule

| Secret | Where |
| --- | --- |
| Telegram bot token, WhatsApp tokens, etc. | Gateway Worker only |
| E2B API key | Gateway Worker only |
| `WORKER_TO_HARNESS_SECRET` | Gateway Worker; injected to harness process via `/bootstrap` |
| `COMPOSIO_SESSION_SECRET` | Gateway **and** composio-proxy (shared HMAC + internal mint auth) |
| Codex / OAuth / relay auth | LLM proxy + host relay only |
| `COMPOSIO_API_KEY` | composio-proxy only |
| `EXA_API_KEY` | api-proxy only |
| What sandbox gets | Harness shared secret + Telegram **proxy** config + per-turn LLM capability + Composio MCP **capability Bearer** (process env) + public proxy URLs |

Treat every sandbox as hostile: model + shell can read env and files.

```
┌──────────────┐     real bot token        ┌────────────────────┐
│  Telegram /  │◄─────────────────────────►│  Gateway Worker    │
│  WhatsApp    │     Bot API proxy ◄───────│  + D1 + R2         │
└──────────────┘                           └─────────┬──────────┘
                                                     │ create / connect
                                                     │ POST /bootstrap (+ restore)
                                                     │ POST /telegram/update (raw)
                                                     │ harvest checkpoint → R2
                                           ┌─────────▼──────────┐
                                           │  Per-user E2B      │
                                           │  harness + Hermes  │
                                           │  official TG gw    │
                                           └─────────┬──────────┘
                                                     │ capability / stub / MCP Bearer
                        ┌────────────────────────────┼────────────────────────────┐
                        ▼                            ▼                            ▼
                 LLM proxy Worker            API proxy Worker            composio-proxy
```

## Multi-channel

Same Worker, multiple adapters:

- `/telegram/webhook` — **implemented** (see [telegram.md](./telegram.md))
- `/whatsapp/webhook` — future (same philosophy: Worker owns Meta webhook + Graph token; sandbox gets proxy + inject)
- Future: more routes, same **edge secrets + routing + sandbox official adapter** pattern

Agent core reasoning does **not** branch on “Telegram vs WhatsApp” — only Worker edge adapters and in-sandbox channel adapters do.

## Routing table (D1)

One durable `user_agents` row per gateway identity (Telegram today):

- gateway identity: `gateway` + `gateway_user_id` + `gateway_conversation_id`
- status: `provisioning` | `ready` | `failed`
- runtime: `runtime_provider` + `runtime_id` + `runtime_domain` (currently E2B)
- stable internal `user_id` (e.g. `telegram:<id>`)

Atomic first-message claim prevents double-create. Failed rows re-provision on the next inbound message.

**Composio policy:** provision + `replaceRuntime` **hard-require** harness `composio_mcp_ready: true`; per-message re-bootstrap is soft-fail. See [../tooling/composio.md](../tooling/composio.md).

## Non-goals for this Worker

- Running Hermes itself / owning prompts and memory
- Holding the only copy of long-lived agent brain on the Worker (live brain is E2B; durable copy is R2)
- Putting the **real** channel token into sandboxes so Hermes binds `api.telegram.org` directly
- Re-rendering or inventing agent replies on the happy path (sandbox sends via proxy)
- Owning Codex OAuth (that’s LLM proxy + relay)
- Holding Exa / `COMPOSIO_API_KEY`

## Summary

**Worker = channel network edge + routing + sandbox lifecycle + reverse proxies + R2 checkpoint harvest/restore.**  
**Sandbox = per-user Hermes brain + official channel adapter + HTTP harness (stages checkpoints; never holds long-lived R2 or product API keys).**  
**LLM / API / Composio proxies = secret doors; credentials never long-lived in E2B.**  
**Architecture is gateway-agnostic at the agent boundary;** only edge + in-sandbox adapters are channel-specific.
