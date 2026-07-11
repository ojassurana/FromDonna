# Gateway (agnostic)

## Role

One **Cloudflare Worker** is the **gateway king**.

It owns every messaging channel (Telegram, WhatsApp, future adapters).  
It is the only edge that holds channel secrets (bot tokens, WhatsApp credentials, etc.).  
It is the only component that talks to those networks.

**E2B sandboxes never talk to Telegram/WhatsApp.**  
They never receive channel tokens. They only run the per-user agent (Hermes).

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
- **One user → one sandbox → one Hermes process** (create/resume on demand; pause/kill when idle).
- **Durable state lives outside the sandbox** (Worker/D1/R2/etc.). Sandbox = compute for that user.

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Channel adapter | Worker routes per platform | Verify webhook, parse native update, send native replies |
| Normalize | Worker | Map any channel → one internal message shape |
| Identity & routing | Worker | Map channel identity → `userId` → `sandboxId` |
| Agent runtime | E2B (per user) | Hermes loop + tools; no channel secrets |
| Outbound | Worker | Agent reply → correct channel API |

## Internal message shape (channel-agnostic)

Adapters strip platform quirks and pass a **flat, minimal** payload into the sandbox, e.g.:

- Stable user id (`userId` / `donnaUserId`-style)
- Channel tag (`gateway`: `telegram` | `whatsapp` | …)
- Channel chat/user ids (`gatewayChatId`, `gatewayMessageId`, …)
- Text / media / reply context as needed
- **No** bot tokens, LLM keys, or other secrets

Sandbox Hermes answers with text/media (or structured reply).  
Worker maps that back to the right channel’s send API.

## Secrets rule

| Secret | Where |
| --- | --- |
| Telegram bot token, WhatsApp tokens, etc. | Worker only |
| LLM / search / other API keys | Worker (or proxies), never raw in sandbox env if exfiltable |
| What sandbox gets | Short-lived **capability token** + proxied tool/LLM endpoints |

Treat every sandbox as hostile: model + shell can read env and files.

## Multi-channel

Same Worker, multiple adapters:

- `/telegram/webhook` (or equivalent)
- `/whatsapp/webhook` (or equivalent)
- Future: more routes, same normalize → route → sandbox → outbound path

Agent code path does **not** branch on “Telegram vs WhatsApp” for core reasoning — only the Worker adapters do.

## Non-goals for this Worker

- Running Hermes itself
- Holding long-lived per-user agent process state (that’s E2B + durable stores)
- Putting channel tokens into sandboxes so Hermes “native gateway” can bind them

## Summary

**Worker = all gateway I/O + routing.**  
**Sandbox = per-user Hermes brain.**  
**Architecture is gateway-agnostic at the agent boundary;** only adapters are channel-specific.
