# Harness

```
Telegram → Cloudflare Worker (edge proxy) → sandbox harness
  → official Hermes GatewayRunner + TelegramAdapter
  → captured Bot API actions → Worker → Telegram
```

## Invariant

- **Worker** owns the Telegram webhook, E2B provisioning, and Bot API delivery.
- **Sandbox** runs the **official Hermes Telegram gateway code** (not `hermes chat -q`).
- One sandbox = one user = one Hermes `~/.hermes` brain.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness |
| POST | `/bootstrap` | none (once) | Inject `WORKER_TO_HARNESS_SECRET` |
| POST | `/turn` | Bearer + `x-llm-capability` | One official gateway turn |

## Local verification

```bash
cd E2B-Template/harness
pytest -q test_server.py
```
