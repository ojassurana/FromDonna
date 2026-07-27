# Presence messages (edge light LLM + Hermes final)

Product chat presence while the agent works. **Hermes mid-turn chat stays off**; only the **final** answer comes from Hermes. Status lines 1–3 are owned by the **gateway** (and a small Hermes plugin that only *reports* live tool starts).

**No scenario hardcoding.** Ack and process copy come from a **tiny general LLM** on the latest user text (+ live tool signal for 2–3). There is no Gmail/Pi/install regex catalog.

See also: [telegram.md](./telegram.md) § Presence.

---

## Message model (max 4 including final)

| # | Kind | Owner | Trigger | Copy source |
|---|------|--------|---------|-------------|
| **1** | Ack | Gateway | User text + **structural gate ON** | Tiny LLM (deadline ~650ms) |
| **2** | Process | Gateway | First tool stage from sandbox | Tiny LLM + latest user + live signal |
| **3** | Process | Gateway | Later different stage | Same |
| **4** | Final | **Hermes** | Agent turn complete | Full agent + tools |

Skip 2–3 when no tools fire, turn ends early, or budget exhausted.  
**Skip 1** when structural gate says simple (hi / thanks / echo / very short ack).

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
2. Reject banned fillers: `One sec.` / `On it.` / `Got it.` / …  
3. Else single bland fallback: **`Working on that…`** (never hashed One sec pool)

### Msg 2–3
1. Plugin posts `{ userId, chatId, toolName }` on `pre_tool_call`  
2. Gateway uses tool name only as **internal stage id** (dedup/budget)  
3. Tiny LLM writes human line from **latest user ask + “tool activity started”**  
4. Fallback: **`Still working…`** if LLM misses  

If Hermes never calls tools → no fake process lines (correct).

---

## Hermes mid-turn OFF

Template `E2B-Template/config/hermes/config.yaml`: mid-turn busy/interim/tool_progress/streaming off.  
Thinking-dots are separate UX.

---

## Components

| Piece | Path |
|--------|------|
| Presence + gate | `cloudflare/gateway/src/presence.ts` |
| Webhook + stage API | `cloudflare/gateway/src/index.ts` |
| Stage plugin | `E2B-Template/extensions/plugins/fromdonna_presence/` |

---

## Ops

```bash
cd cloudflare/gateway && npm test && npx wrangler deploy
# Template only if plugin/harness changed
```

Constants: `PRESENCE_ACK_SYSTEM_PROMPT`, `PRESENCE_PROCESS_SYSTEM_PROMPT`, `PRESENCE_ACK_FALLBACK`.
