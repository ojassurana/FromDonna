# Presence messages (edge light LLM + Hermes final)

Product chat presence while the agent works. **Hermes mid-turn chat stays off**; only the **final** answer comes from Hermes. Status lines 1–3 are owned by the **gateway** (and a small Hermes plugin that only *reports* stages).

See also: [telegram.md](./telegram.md) § Presence, [plan.md](../../plan.md).  
Explainer (plan UX): `https://chitti-explainers.pages.dev/fromdonna-presence-gate-and-ack/`

---

## Message model (max 4 including final)

| # | Kind | Owner | Trigger | Model |
|---|------|--------|---------|--------|
| **1** | Ack | Gateway | User text + **hybrid gate ON** | Light LLM + latest-msg rules |
| **2** | Process | Gateway | First tool stage from sandbox | Light LLM + chat + sanitized stage |
| **3** | Process | Gateway | Later different stage | Same |
| **4** | Final | **Hermes** | Agent turn complete | Full agent + tools |

Skip 2–3 when the turn finishes early or budget is exhausted.  
**Skip 1** when the hybrid gate says the turn is simple (hi / thanks / echo / short ack).

---

## Hybrid gate (when msg 1 runs)

Edge-only — **not** a Hermes tool. `shouldSendPresenceAck` / `resolvePresenceGate` in `presence.ts`.

| Decision | Examples |
|----------|----------|
| **Skip** | `hi`, `thanks`, `ok`, `yes`, pure `echo …`, “reply with exactly…” |
| **Force ON** | gmail/email/calendar/drive/github, check/find/draft/… |
| **default_on** | medium ambiguous text → optional micro yes/no LLM (~180ms); timeout → **skip** |

On skip: still reset turn budget + append user to ring; **no** WIP bubble. Typing + Hermes final only.

---

## Hermes mid-turn OFF

Template `E2B-Template/config/hermes/config.yaml`:

- `busy_ack_enabled: false`
- `interim_assistant_messages: false`
- `tool_progress: false` (+ Telegram mirrors)
- `streaming: false`

Thinking-dots (`.…`) are separate FromDonna UX (fast pipelined edits). Do not re-enable Hermes interim/streaming without fixing `content_delivered` risk.

---

## Components

| Piece | Path |
|--------|------|
| Presence logic + gate | `cloudflare/gateway/src/presence.ts` |
| Webhook + stage API | `cloudflare/gateway/src/index.ts` |
| D1 ring | `user_presence_ring` (migration 0008) |
| D1 turn budget | `user_presence_turn` (migration 0009) |
| Stage reporter plugin | `E2B-Template/extensions/plugins/fromdonna_presence/` |
| Plugin enable | `config.yaml` `plugins.enabled` → `fromdonna_presence` |

---

## Flow

```text
User DM
  → Gateway: typing
  → Hybrid gate
       → SKIP → inject Hermes → [4] final only
       → ON   → [1] ack (rules + tiny LLM, concrete copy)
  → Inject Hermes (quiet mid-turn)
       → tool start → plugin POST /internal/presence/stage
            → Gateway claim budget → [2] or [3] → sendMessage
       → Hermes final → Bot API proxy → [4]
```

### Stage endpoint

```http
POST /internal/presence/stage
Authorization: Bearer <WORKER_TO_HARNESS_SECRET>
Content-Type: application/json

{
  "userId": "telegram:123",
  "chatId": "123",
  "toolName": "COMPOSIO_GMAIL_FETCH_EMAILS"
}
```

Authz: body `chatId` must match D1 `gateway_conversation_id` for `userId`.  
Response: `{ ok, text?, source?, stage?, skipped? }`  
Skips: `disabled`, `max_process_lines`, `same_stage`, `min_interval`, `stale_turn`, `duplicate_status`, `chat_mismatch`.

### Plugin env (sandbox)

| Env | Purpose |
|-----|---------|
| `FROMDONNA_WORKER_URL` | Gateway public URL |
| `WORKER_TO_HARNESS_SECRET` | Bearer for stage POST |
| `FROMDONNA_USER_ID` | e.g. `telegram:…` |
| `FROMDONNA_CHAT_ID` | Telegram chat id (refreshed on warm inject headers) |

---

## Light LLM request (msgs 1–3)

Product proxy: **`POST /v1/chat/completions`** only.

```http
POST https://fromdonna-llm-proxy.code-df4.workers.dev/v1/chat/completions
Authorization: Bearer <gateway_capability>
Content-Type: application/json
```

### Msg 1 (ack) — latest-first

Constants: `PRESENCE_ACK_SYSTEM_PROMPT` in `presence.ts`.

```json
{
  "model": "grok-4.5",
  "temperature": 0.4,
  "max_tokens": 24,
  "stream": false,
  "messages": [
    { "role": "system", "content": "<PRESENCE_ACK_SYSTEM_PROMPT>" },
    {
      "role": "user",
      "content": "Latest user message:\n…\n\nOptional weak context (older…):\n…\n\nWrite the single WIP status line now."
    }
  ]
}
```

**Resolve ladder:** race tiny LLM (~380ms) ↔ **latest-message-only** intent rules → prefer **concrete** lines (e.g. `Opening Gmail…`) over sticky generics → fallback pool.

Intent rules no longer scan the full ring (avoids “Looking that up…” poison). Affirmation follow-ups (`yes`) may reuse the **prior user** line’s intent only.

### Msg 2–3 (process)

```json
{
  "model": "grok-4.5",
  "temperature": 0.4,
  "max_tokens": 24,
  "stream": false,
  "messages": [
    { "role": "system", "content": "<PRESENCE_PROCESS_SYSTEM_PROMPT>" },
    {
      "role": "user",
      "content": "Recent chat: …\nRuntime stage: checking_email\nStage hint: Opening Gmail…\nPrevious status line: …\n\nWrite the single WIP status line now…"
    }
  ]
}
```

Tool names → `stageFromToolName` before the model. Deadline ~500ms. Dedupes vs last status. Atomic D1 **claim** per turn epoch.

---

## Budget & voice

| Rule | Value |
|------|--------|
| Max process lines after ack | 2 |
| Min interval between **process** lines | 2.5s (ack does **not** stamp interval) |
| Same stage twice | skipped |
| After Hermes final | process blocked (`markPresenceTurnFinal`) |
| Voice | Human intent; concrete app/object when clear |
| Disable all presence | `PRESENCE_ACK_ENABLED=0` on gateway |

---

## Ops

```bash
cd cloudflare/gateway
npx wrangler d1 migrations apply fromdonna-routing --remote   # if needed
npm test
npx wrangler deploy

# Template only if plugin/harness/hermes fork changed
cd ../../E2B-Template && bash scripts/deploy-template.sh --prod --skip-install
```

Tests: `cd cloudflare/gateway && npm test` (includes gate + ack cases in `presence.test.ts`).
