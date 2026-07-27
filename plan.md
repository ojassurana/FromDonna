# Plan: Presence + process status (3 light-LLM lines) + Hermes final

## Product vibe

User should never sit in dead air. Chat feels alive with short Donna WIP lines, then one real answer.

| # | Kind | Who | What |
|---|------|-----|------|
| **1** | **Ack** | Light LLM (edge) | “On it.” / “Checking that email…” — commitment, from **chat context** |
| **2** | **Process (human)** | Light LLM wrapper | WIP from **runtime + last few msgs** — e.g. “Looking through your inbox…” |
| **3** | **Process (human)** | Light LLM wrapper | Later step, same style — e.g. “Opening that thread…” |
| **4** | **Final** | **Hermes official turn** | Real answer only — full agent + tools |

**Max 4 outbound assistant texts per user turn** (3 status + 1 final). Prefer fewer when the turn is fast (skip 2/3 if done early).

---

## Hermes mid-turn: OFF (required)

Hermes must **not** emit its own mid-turn chat (busy-ack, interim assistant, tool progress, TG streaming drafts). Those can mark `content_delivered` and **swallow the real final**.

**Also removed (2026-07-27):** FromDonna **thinking-dots** (`. → .. → ...` bubble via `fromdonna_ux` / adapter). Not Hermes config — it was a parallel Bot API animate path. Fully deleted from the template; do not reintroduce. Presence WIP is **gateway msgs 1–3 only** + typing indicator.

### Template config (already set — keep this)

`E2B-Template/config/hermes/config.yaml`:

| Key | Value | Why |
|-----|--------|-----|
| `display.busy_ack_enabled` | `false` | No Hermes “I’m busy” |
| `display.busy_steer_ack_enabled` | `false` | No steer busy tips |
| `display.interim_assistant_messages` | `false` | No mid-turn natural status from Hermes |
| `display.tool_progress` | `false` | No tool progress spam |
| `display.long_running_notifications` | `false` | No heartbeat bubbles |
| `display.platforms.telegram.*` | same offs | Messaging mirrors |
| `display.streaming` / TG streaming | `false` | No draft stream |

**Hermes = message 4 only** (final via Bot API proxy).  
**Gateway / product light LLM = messages 1–3.**

Do **not** re-enable Hermes interim/streaming for presence without a separate `content_delivered` fix.

---

## Message details

### 1) Ack (implemented on gateway)

- **When:** User text arrives; **bounded await before inject** so WIP lands before final.
- **Context:** Latest user message primary; weak older ring only.
- **Model:** Tiny call via **`LLM_PROXY` service binding** → llm-proxy `POST /v1/chat/completions` (not public workers.dev — CF 1042). Hard deadline ~1.2s.
- **Fallback:** Single bland `Working on that…` — **never** `One sec.` / `On it.` / `Got it.`
- **No scenario regex catalog** (Ojas hard rule).
- **Code:** `cloudflare/gateway/src/presence.ts` (deployed).

### 2–3) Process-based human lines (to build)

- **When:** Mid-turn runtime events (tool start, major step, long wait) — at most **two** such lines.
- **Light LLM wrapper** (same family as ack):
  - **System:** one Donna WIP line, ≤~8 words, human intent only, no tool/MCP/skill IDs, trailing `…` OK.
  - **User context:** last few chat msgs + **sanitized runtime snapshot** (e.g. `stage: checking_email`, not `COMPOSIO_…`).
- **Deadline + fallback:** If LLM slow → rule map from stage → canned human line.
- **Not** the full agent solving the task — only **narrating** the step.
- Prefer **editMessageText** on previous status when intent sharpens, if we want fewer bubbles; product default is **up to two distinct process messages** as specified.

**Runtime feed (required for 2–3):**

Hermes/harness must emit **non-user-facing** stage signals to the gateway (or gateway observes Bot API only if we add a status channel). Candidates:

1. Harness callback / internal event: `{ turn_id, stage, human_hint? }`  
2. Tool-name allowlist → stage label (`gmail.*` → `checking_email`)  
3. Never put raw tool dumps in the light-LLM prompt

### 4) Final (Hermes)

- Full turn, tools, Composio, etc.
- Single final answer (streaming off).
- Captured into presence ring as `assistant` for next-turn ack context.

---

## Architecture

```text
User message
    │
    ├─► Gateway: typing…
    ├─► [1] Light LLM ACK (chat context) ──► sendMessage
    │
    └─► Inject Hermes (mid-turn chat OFF)
            │
            ├─ runtime stage A ──► [2] Light LLM (chat + stage) ──► sendMessage
            ├─ runtime stage B ──► [3] Light LLM (chat + stage) ──► sendMessage
            │
            └─ Hermes final ──► [4] sendMessage via Bot API proxy
```

**Counter per turn:** max 3 pre-final product lines + 1 Hermes final.  
Skip 2/3 if final is ready. Race: if final beats ack, skip/delete orphan ack when possible.

---

## Light LLM request shape (all of 1–3)

Product proxy: **`POST /v1/chat/completions`** only (no `/v1/responses` on fromdonna-llm-proxy).

```http
POST https://fromdonna-llm-proxy.code-df4.workers.dev/v1/chat/completions
Authorization: Bearer <gateway-minted-capability>
Content-Type: application/json
```

```json
{
  "model": "grok-4.5",
  "temperature": 0.4,
  "max_tokens": 24,
  "stream": false,
  "messages": [
    {
      "role": "system",
      "content": "ONE short Donna WIP status line. Max 8 words. Human intent only. No tools/MCP/skills. No final answer. Trailing … OK."
    },
    {
      "role": "user",
      "content": "Recent chat:\nUser: …\nDonna: …\n\nRuntime (optional for msg 2–3):\nstage: checking_email\n\nWrite the single WIP status line now."
    }
  ]
}
```

Msg 1: chat only.  
Msg 2–3: chat + runtime stage block.

---

## “…” continues until final

- WIP lines may end with `…`
- Keep `sendChatAction(typing)` until final
- Final has no WIP ellipsis

---

## Implementation status

| Piece | Status |
|--------|--------|
| Hermes mid-turn OFF | **Done** (template config) |
| Msg 1 contextual ack + tiny LLM | **Done** (gateway + D1 ring) |
| Typing during inject | **Done** (gateway) |
| Msg 2–3 light LLM + runtime feed | **Done** (`fromdonna_presence` plugin → `POST /internal/presence/stage`) |
| Turn budget (max 2 process) | **Done** (`user_presence_turn`) |
| Docs | `documentation/gateway/presence.md` + telegram.md |

### Ops after code change

1. `cd cloudflare/gateway && npm test && npm run deploy`  
2. `npx wrangler d1 migrations apply fromdonna-routing --remote`  
3. `cd E2B-Template && npm run build:prod` (plugin + config bake)

---

## Risks

| Risk | Mitigation |
|------|------------|
| Hermes interim re-enabled | Keep config false; never use Hermes for 1–3 |
| Final swallowed | Status only via gateway Bot API |
| Spam on fast turns | Skip 2–3 if done; delete orphan ack if needed |
| Hallucinated process | Only call light LLM when a real stage event fired |
| 4 messages feels chatty | Cap 2 process lines; human short; typing fills gaps |

---

## Locked product rules

1. **Msg 1** = light LLM ack from chat context (rules/fallback backup).  
2. **Msg 2–3** = light LLM wrappers on **runtime + last few messages**.  
3. **Msg 4** = Hermes official final only.  
4. **Hermes mid-turn messages stay OFF.**  
5. Human intent only — no tool/system talk in 1–3.
