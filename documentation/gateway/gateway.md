# Gateway (agnostic)

## Role

One **Cloudflare Worker** is the **gateway king**.

It owns every messaging channel (Telegram, WhatsApp, future adapters).  
It is the only edge that holds channel secrets (bot tokens, WhatsApp credentials, etc.).  
It is the only component that talks to those networks.

**E2B sandboxes never talk to Telegram/WhatsApp.**  
They never receive channel tokens. They only run the per-user agent (Hermes).

**Live Telegram implementation:** [telegram.md](./telegram.md) · source `cloudflare/gateway/`  
**LLM door for sandboxes:** [llm-proxy-worker.md](./llm-proxy-worker.md) · source `cloudflare/llm-proxy/`

## Core idea

```
User (any app)
  → Channel network (Telegram / WhatsApp / …)
  → Worker (channel adapter + auth + routing)
  → User’s E2B sandbox (Hermes agent only)
  → Worker
  → Same channel network
  → User
```

- **Many users, one bot/number per channel** is fine — identity is `platform user/chat id`, not “who holds the token.”
- **One user → one sandbox → one Hermes process** (create/resume on demand; pause when idle via E2B autoPause + autoResume).
- **Durable routing state lives outside the sandbox** (Worker + D1). Sandbox = compute for that user.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Channel adapter | Worker routes per platform | Verify webhook, parse native update, send native replies |
| Normalize | Worker | Map any channel → one internal message shape |
| Identity & routing | Worker + D1 | Map channel identity → `userId` → `sandboxId` / status |
| Provision | Worker + E2B API | Create sandbox, wait for harness, bootstrap auth |
| Agent runtime | E2B (per user) | Harness + Hermes loop + tools; no channel secrets |
| Inference | LLM proxy Worker | OpenAI-compatible edge; real credentials stay off sandbox |
| Outbound | Worker | Agent reply → correct channel API |

## Internal message shape (channel-agnostic)

Adapters strip platform quirks and pass a **flat, minimal** payload into the sandbox:

| Field | Example |
|-------|---------|
| `userId` | `telegram:1063008785` |
| `gateway` | `telegram` \| `whatsapp` \| … |
| `gatewayChatId` | platform chat id |
| `gatewayMessageId` | platform message id |
| `text` | user text (v1) |

**No** bot tokens, LLM provider keys, or other product secrets in the body.

Auth to the sandbox is separate:

- `Authorization: Bearer <WORKER_TO_HARNESS_SECRET>` (Worker↔harness)
- `x-llm-capability: <short-lived nonce>` (Worker-minted; Hermes uses as `OPENAI_API_KEY` against the proxy only)

Sandbox Hermes answers with `{ "text": "..." }` (media later). Worker maps that back to the channel send API.

## Secrets rule

| Secret | Where |
| --- | --- |
| Telegram bot token, WhatsApp tokens, etc. | Gateway Worker only |
| E2B API key | Gateway Worker only |
| Codex / OAuth / relay auth | LLM proxy + host relay only |
| What sandbox gets | Harness shared secret (via `/bootstrap`) + per-turn **capability** + public proxy URL |

Treat every sandbox as hostile: model + shell can read env and files.

```
┌──────────────┐     channel secrets      ┌────────────────────┐
│  Telegram /  │◄────────────────────────►│  Gateway Worker    │
│  WhatsApp    │                          │  + D1 routing      │
└──────────────┘                          └─────────┬──────────┘
                                                    │ create / connect
                                                    │ POST /bootstrap
                                                    │ POST /turn + capability
                                          ┌─────────▼──────────┐
                                          │  Per-user E2B      │
                                          │  harness + Hermes  │
                                          └─────────┬──────────┘
                                                    │ Bearer capability only
                                          ┌─────────▼──────────┐
                                          │  LLM proxy Worker  │
                                          │  → Codex relay     │
                                          └────────────────────┘
```

## Multi-channel

Same Worker, multiple adapters:

- `/telegram/webhook` — **implemented** (see [telegram.md](./telegram.md))
- `/whatsapp/webhook` — future
- Future: more routes, same normalize → route → sandbox → outbound path

Agent code path does **not** branch on “Telegram vs WhatsApp” for core reasoning — only the Worker adapters do.

## Routing table (D1)

One durable row per messaging identity (Telegram today):

- status: `provisioning` | `ready` | `failed`
- `e2b_sandbox_id` + domain
- internal `user_id` (e.g. `telegram:<id>`)

Atomic first-message claim prevents double-create. Failed rows re-provision on the next inbound message.

## Non-goals for this Worker

- Running Hermes itself
- Holding long-lived per-user agent process state (that’s E2B + durable stores)
- Putting channel tokens into sandboxes so Hermes “native gateway” can bind them
- Owning Codex OAuth (that’s LLM proxy + relay)

## Summary

**Worker = all gateway I/O + routing + sandbox lifecycle.**  
**Sandbox = per-user Hermes brain + HTTP harness.**  
**LLM proxy = inference door; credentials never in E2B.**  
**Architecture is gateway-agnostic at the agent boundary;** only adapters are channel-specific.
