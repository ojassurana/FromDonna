# Presence messages (edge light LLM + Hermes final)

Product chat presence while the agent works. **Hermes mid-turn chat stays off**; only the **final** answer comes from Hermes. Status lines 1–3 are owned by the **gateway** (and a small Hermes plugin that only *reports* stages).

See also: [telegram.md](./telegram.md) § Presence, [plan.md](../../plan.md).

---

## Message model (max 4 including final)

| # | Kind | Owner | Trigger | Model |
|---|------|--------|---------|--------|
| **1** | Ack | Gateway | User text arrives | Light LLM + last ~10 msgs (rules/fallback) |
| **2** | Process | Gateway | First tool stage from sandbox | Light LLM + chat + sanitized stage |
| **3** | Process | Gateway | Later different stage | Same |
| **4** | Final | **Hermes** | Agent turn complete | Full agent + tools |

Skip 2–3 when the turn finishes early or budget is exhausted.

---

## Hermes mid-turn OFF

Template `E2B-Template/config/hermes/config.yaml`:

- `busy_ack_enabled: false`
- `interim_assistant_messages: false`
- `tool_progress: false` (+ Telegram mirrors)
- `streaming: false`

Do not re-enable these for presence without fixing `content_delivered` final-drop risk.

---

## Components

| Piece | Path |
|--------|------|
| Presence logic | `cloudflare/gateway/src/presence.ts` |
| Webhook + stage API | `cloudflare/gateway/src/index.ts` |
| D1 ring | `user_presence_ring` (migration 0008) |
| D1 turn budget | `user_presence_turn` (migration 0009) |
| Stage reporter plugin | `E2B-Template/extensions/plugins/fromdonna_presence/` |
| Plugin enable | `config/hermes/plugins.enabled` → `fromdonna_presence` |

---

## Flow

```text
User DM
  → Gateway: typing + [1] ack (light LLM / rules)
  → Inject Hermes (quiet mid-turn)
       → tool start → plugin POST /internal/presence/stage
            → Gateway budget check → [2] or [3] light LLM → sendMessage
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

Response: `{ ok, text?, source?, stage?, skipped? }`  
Skips: `disabled`, `max_process_lines`, `same_stage`, `min_interval`.

### Plugin env (sandbox)

Set on bootstrap / telegram proxy apply:

| Env | Purpose |
|-----|---------|
| `FROMDONNA_WORKER_URL` | Gateway public URL |
| `WORKER_TO_HARNESS_SECRET` | Bearer for stage POST |
| `FROMDONNA_USER_ID` | e.g. `telegram:…` |
| `FROMDONNA_CHAT_ID` | Telegram chat id |

---

## Light LLM request (msgs 1–3)

Product proxy: **`POST /v1/chat/completions`** only.

```http
POST https://fromdonna-llm-proxy.code-df4.workers.dev/v1/chat/completions
Authorization: Bearer <gateway-minted-capability>
Content-Type: application/json
```

### Msg 1 (ack)

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
      "content": "Recent chat (oldest → newest):\nUser: …\nDonna: …\nUser: <current>\n\nWrite the single WIP status line now."
    }
  ]
}
```

Constants: `PRESENCE_ACK_SYSTEM_PROMPT` in `presence.ts`. Deadline ~400ms → rules → fallback pool.

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
      "content": "Recent chat: …\nRuntime stage: checking_email\nStage hint: Checking that email…\nPrevious status line: On it.\n\nWrite the single WIP status line now…"
    }
  ]
}
```

Tool names are mapped to stages (`stageFromToolName`) before the model sees them. Deadline ~500ms → stage rule line.

---

## Budget & voice

| Rule | Value |
|------|--------|
| Max process lines after ack | 2 |
| Min interval between process lines | 2.5s |
| Same stage twice | skipped |
| Voice | Human intent only; no tool/MCP/skill IDs |
| Disable all presence | `PRESENCE_ACK_ENABLED=0` on gateway |

---

## Ops

```bash
# D1 migrations (presence tables)
cd cloudflare/gateway
npx wrangler d1 migrations apply fromdonna-routing --remote

# Deploy gateway
npm run deploy

# Template after plugin/config change
cd ../../E2B-Template && npm run build:prod
```

Tests: `cd cloudflare/gateway && npm test` (includes `presence.test.ts`).
