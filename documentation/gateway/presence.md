# Presence messages (edge light LLM + Hermes final)

Product chat presence while the agent works. **Hermes mid-turn chat stays off**; only the **final** answer comes from Hermes. Status lines 1–3 are owned by the **gateway** (and a small Hermes plugin that only *reports* live tool starts).

**No scenario hardcoding.** Ack and process copy come from a **tiny general LLM** on the latest user text (+ live tool signal for 2–3). There is no Gmail/Pi/install regex catalog.

**No thinking-dots.** The old FromDonna `.` → `..` → `...` bubble (`fromdonna_ux` / adapter animate path) is **fully removed** (2026-07-27). Users may still see Telegram **typing…** (edge + adapter) and gateway presence WIP lines — never the animated dots message.

See also: [telegram.md](./telegram.md) § Presence.

---

## Message model (max 4 including final)

| # | Kind | Owner | Trigger | Copy source |
|---|------|--------|---------|-------------|
| **1** | Ack | Gateway | User text + **structural gate ON** | Tiny LLM via **`LLM_PROXY` binding** (~1.2s deadline) |
| **2** | Process | Gateway | First tool stage from sandbox | Claim-first fallback + short LLM polish |
| **3** | Process | Gateway | Later different stage | Same |
| **4** | Final | **Hermes** | Agent turn complete | Full agent + tools |

Skip 2–3 when no tools fire, turn ends early, or budget exhausted.  
**Skip 1** when structural gate says simple (hi / thanks / echo / very short ack).

What the user should **not** see mid-turn:

- Hermes busy-ack / interim / tool_progress / streaming drafts  
- FromDonna thinking-dots (`.…`) — **deleted from template**  
- Fake process lines without a real tool start  

What they **may** see:

- Telegram typing indicator  
- Gateway msg 1–3 WIP (LLM-written or bland process fallback)  
- Hermes final only as the real answer  

---

## Structural gate (when msg 1 runs)

Edge-only — **not** a Hermes tool. `shouldSendPresenceAck` / `resolvePresenceGate`.

| Decision | Examples |
|----------|----------|
| **Skip** | `hi`, `thanks`, `ok`, pure `echo …`, “reply with exactly…” |
| **ON** | Real questions/requests (length / `?` / substantive text) |
| **default_on** | Medium ambiguous → optional micro yes/no LLM; timeout → **ON** |

No app/intent product lists. On skip: reset turn + ring user text; no WIP bubble.

---

## LLM-first copy (no scenario rules)

### Msg 1
1. Race tiny LLM (`PRESENCE_ACK_SYSTEM_PROMPT`, latest-first user block)  
2. Reject banned fillers: `One sec.` / `On it.` / `Got it.`  
3. Strip `GATE_*` test tokens from model output  
4. Else single bland fallback: **`Working on that…`** (never hashed One sec pool)

### Msg 2–3 (claim-first — 2026-07-27)

**Problem fixed:** Old path ran process LLM (~900ms) *then* claimed a D1 slot. Hermes final often hit Bot API proxy first → `markPresenceTurnFinal` (`process_count=999`) → claim lost → user only saw ack → final.

**Shipped path:**

1. Plugin `fromdonna_presence` on `pre_tool_call` POSTs `{ userId, chatId, toolName }` → `/internal/presence/stage`  
2. Gateway auth + route/chat match  
3. **`claimPresenceProcessSlot` immediately** (epoch + stage + budget)  
4. **Send bland process line ASAP** (`Still working…` / rare alternates if duplicate) via real bot token  
5. Short process LLM (~280ms) **polishes via `editMessageText`** when better  
6. Tool name is **internal stage id only** (dedup/budget) — never user slogans  

If Hermes never calls tools → no fake process lines (correct).

Env for plugin (refreshed every inject):

| Env | Source |
|-----|--------|
| `FROMDONNA_WORKER_URL` | Inject header `x-fromdonna-worker-url` or telegram base origin |
| `WORKER_TO_HARNESS_SECRET` | Bootstrap / create |
| `FROMDONNA_USER_ID` | Inject header |
| `FROMDONNA_CHAT_ID` | Inject header |

### Critical: `LLM_PROXY` service binding

Worker→public `*.workers.dev` fetch = Cloudflare **1042**. Presence tiny-LLM **must** use:

```toml
[[services]]
binding = "LLM_PROXY"
service = "fromdonna-llm-proxy"
```

`callPresenceTinyLlm({ fetcher: env.LLM_PROXY, … })`. Without this, LLM always fails → bland fallback.

### Ack order

Gateway **awaits** bounded `sendPresenceAck` (~1.4s race) **before** sandbox inject so the final cannot beat the WIP line; leftover continues in `waitUntil`.

### Final lock

Hermes final via Bot API proxy → `markPresenceTurnFinal` blocks late process claims. Claim-first means the process bubble usually already landed.

---

## Hermes mid-turn OFF

Template `E2B-Template/config/hermes/config.yaml`:

- `busy_ack_enabled: false`
- `interim_assistant_messages: false`
- `tool_progress: false` (+ Telegram mirrors)
- `streaming: false` / `streaming.enabled: false`
- `plugins.enabled` includes `fromdonna_presence`

Do not re-enable Hermes interim/streaming for presence without fixing `content_delivered` final-drop risk.

### Thinking-dots — removed

| Was | Now |
|-----|-----|
| `E2B-Template/hermes/plugins/platforms/telegram/fromdonna_ux.py` | **Deleted** |
| Adapter `_fromdonna_start_thinking_dots` / animate / draft `.…` | **Deleted** |
| `FROMDONNA_THINKING_DOTS` env / `extra.thinking_dots` | **No-op / gone** |
| Tests `test_fromdonna_telegram_ux.py` | **Deleted** |

Commit: `0047fef` + template rebuild `fromdonna-hermes`. Optional stock **👀/👍 reactions** may still run if reactions enabled — unrelated to dots.

---

## Components

| Piece | Path |
|--------|------|
| Presence + gate | `cloudflare/gateway/src/presence.ts` |
| Webhook + stage + ack order | `cloudflare/gateway/src/index.ts` |
| `LLM_PROXY` binding | `cloudflare/gateway/wrangler.toml` |
| Stage plugin | `E2B-Template/extensions/plugins/fromdonna_presence/` |
| Inject env refresh | `E2B-Template/harness/server.py` `/telegram/update` |
| ~~Thinking-dots~~ | **Removed** |

---

## Ops

```bash
cd cloudflare/gateway && npm test && npx wrangler deploy
# Template after adapter/plugin/config change:
cd ../../E2B-Template && bash scripts/deploy-template.sh --prod --skip-install
```

Tail skips: `wrangler tail fromdonna-gateway` → `presence process source=` or `presence process skipped reason=`.

Constants: `PRESENCE_ACK_SYSTEM_PROMPT`, `PRESENCE_PROCESS_SYSTEM_PROMPT`, `PRESENCE_ACK_FALLBACK`, `PRESENCE_PROCESS_FALLBACK`.  
Re-read `presence.ts` for exact prompt text (docs can lag).
