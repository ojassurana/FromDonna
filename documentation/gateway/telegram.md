# Telegram gateway

## Scope

Telegram-specific adapter on the **shared Cloudflare Worker** (see `gateway.md`).

All users share **one Telegram bot**. The bot token lives **only on the Worker**, never in E2B / Hermes sandboxes.

## Flow

```
User DMs / messages @bot
  → Telegram servers
  → Worker webhook (full Update)
  → Resolve telegram user/chat → userId → sandboxId
  → POST normalized payload to that user’s Hermes (E2B)
  → Hermes reply
  → Worker Bot API sendMessage (or media) to same chat
```

1. **In:** Worker receives Telegram `Update` on the webhook.
2. **Map:** `from.id` / `chat.id` → internal user and that user’s sandbox.
3. **Forward:** Worker sends a **clean payload** into Hermes in that sandbox (HTTPS + capability auth). Not the raw bot token. Prefer a minimal normalized message (text, ids, media refs), not dumping secrets.
4. **Out:** Hermes returns reply content; Worker calls Telegram Bot API with the **Worker-held** token.

## Why one bot works for many users

Telegram already scopes traffic by `chat_id` / user id.  
Multi-tenant = **routing table** on the Worker (`telegram identity → user → sandbox`), not multiple bots.

## What does *not* run in the sandbox

- `hermes gateway` with `TELEGRAM_BOT_TOKEN`
- Direct calls to `api.telegram.org` using the product bot token
- Shared Hermes process that holds the token for all users

Hermes in E2B is **agent-only**: tools + LLM loop for **one** user.

## Worker responsibilities (Telegram)

- Store / use `TELEGRAM_BOT_TOKEN`
- Set and serve webhook
- Parse supported update types (text, voice, etc. as product requires)
- Optional: STT / media upload before agent turn
- Outbound: `sendMessage`, media, drafts/edits if used
- Never put the bot token in sandbox env or payload

## Sandbox responsibilities (Telegram)

- Accept Worker-forwarded turn
- Run Hermes for that user
- Return reply to Worker
- No knowledge of the bot token required

## Relation to gateway-agnostic design

Telegram is **one adapter**. Same Worker also owns WhatsApp and future channels (`gateway.md`).  
After the Telegram adapter normalizes the update, the path is identical: **user → sandbox → reply → channel send**.
