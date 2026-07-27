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
| **2** | Process | Gateway | First tool stage from sandbox | Tiny LLM + latest user + live signal |
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
- Gateway msg 1–3 WIP (LLM-written)  
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

### Msg 2–3
1. Plugin posts `{ userId, chatId, toolName }` on `pre_tool_call`  
2. Gateway uses tool name only as **internal stage id** (dedup/budget) — not user slogans  
3. Tiny LLM writes human line from **latest user ask + “tool activity started”**  
4. Fallback: **`Still working…`** if LLM misses  

If Hermes never calls tools → no fake process lines (correct).

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
| ~~Thinking-dots~~ | **Removed** |

---

## Ops

```bash
cd cloudflare/gateway && npm test && npx wrangler deploy
# Template after adapter/plugin/config change:
cd ../../E2B-Template && bash scripts/deploy-template.sh --prod --skip-install
```

Constants: `PRESENCE_ACK_SYSTEM_PROMPT`, `PRESENCE_PROCESS_SYSTEM_PROMPT`, `PRESENCE_ACK_FALLBACK`.  
Re-read `presence.ts` for exact prompt text (docs can lag).
