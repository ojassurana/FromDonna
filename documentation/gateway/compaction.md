# Context compression (long-lived Donna chats)

Hermes auto-summarizes older turns when the live session nears the model context window. That is **required** for people who keep texting forever. Product rules for FromDonna:

| Must | Must not |
|------|----------|
| Compress when needed | Show packing / token-count plumbing on Telegram |
| Prefer work **between** turns | Block the user’s current answer on a huge compact |
| Keep main history thin | Turn compression **off** (hard failures are worse) |

## What the user saw (bug)

Bubble like:

> 📦 Pre-API compression: ~99,194 tokens near the context/output limit. Compacting before the next model call.

That string came from Hermes `conversation_loop` → `_emit_status` → gateway `status_callback` → Telegram. It is **not** Donna answering.

## Shipped product behavior (2026-07)

### 1. Mute lifecycle packing to Telegram

- Gateway filter `_TELEGRAM_NOISY_STATUS_RE` suppresses Pre-API / compacting / near-limit / iteration-budget status on all chat surfaces (`gateway/run.py`).
- Pre-API path **no longer calls** `_emit_status` for the packing line (`agent/conversation_loop.py`) — logs only.

### 2. Silent compact after a successful final

- `turn_finalizer._schedule_post_turn_silent_compact` runs a **daemon thread** after a completed reply (does not delay the final send).
- Soft floor ~**45%** of context (or real `should_compress`) so free time between messages shrinks history.
- Compress still uses the normal compressor (summary LLM); user just never waits mid-ask if this ran earlier.

### 3. Config (`E2B-Template/config/hermes/config.yaml`)

```yaml
compression:
  enabled: true
  threshold: 0.70          # rarer mid-turn pre-API stalls
  target_ratio: 0.22
  protect_last_n: 24
  protect_first_n: 0       # rolling PA DMs
  in_place: true           # one durable session id
```

Mid-turn pre-API compress remains a **safety net** if the session is already fat; it should be uncommon after post-turn silent compact + thin tool results.

### 4. Keep the thread thin (ops / product)

- Prefer short tool results; large artifacts → files / R2.
- Do not re-enable Hermes mid-turn interim / tool_progress (presence owns WIP).
- Memory tool stays off for product unless Ojas opts in later.

## Files

| Piece | Path |
|--------|------|
| Noise filter | `E2B-Template/hermes/gateway/run.py` |
| No Pre-API status emit | `E2B-Template/hermes/agent/conversation_loop.py` |
| Post-turn silent compact | `E2B-Template/hermes/agent/turn_finalizer.py` |
| Product compression knobs | `E2B-Template/config/hermes/config.yaml` |
| Tests | `E2B-Template/hermes/tests/gateway/test_telegram_noise_filter.py` |

## Related

- Presence (msgs 1–3): [presence.md](./presence.md)
- Template rebuild after Hermes/config change: [e2b-template.md](../deployment/e2b-template.md)
- Strategy board (product): temporary explainer `donna-compaction-strategies` on chitti-explainers
