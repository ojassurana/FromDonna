# Harness

```
Channel → Cloudflare Worker (edge) → sandbox harness
  → official Hermes GatewayRunner + TelegramAdapter (Telegram today)
  → outbound via Worker Bot API proxy
```

## Invariant

- **Worker** owns webhooks, E2B lifecycle, Bot API proxy, **R2 checkpoint put/restore**.
- **Sandbox** runs the official Hermes gateway code (not long-lived channel tokens).
- One sandbox = one user = one Hermes `~/.hermes` brain + `workspace`.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness; `auth_ready`, `telegram_proxy_ready`, `gateway_running` |
| POST | `/bootstrap` | body secret | Inject harness secret + optional Telegram proxy + `userId` / `workerUrl` |
| POST | `/telegram/update` | Bearer + `x-llm-capability` | Inject one raw Telegram Update into official Hermes gateway |
| GET | `/internal/checkpoint/export` | Bearer | Worker pulls staged checkpoint tar (Architecture B) |
| POST | `/internal/restore` | Bearer | Worker pushes R2 checkpoint (gzip tar) after create/replace |
| POST | `/turn` | Bearer + `x-llm-capability` | Legacy harness turn path |

## Runtime checkpoint (Architecture B)

Sandbox → Worker **POST is not the live path** (Cloudflare often returns **1010** from E2B to `workers.dev`).

**After an agent session finishes:**

1. Harness packs filtered agent-home + workspace  
2. Stages:
   - `~/.hermes/fromdonna-checkpoint-latest.tar.gz`
   - `~/.hermes/fromdonna-checkpoint-ready.json`
3. Worker harvests asynchronously:
   - `GET /internal/checkpoint/export`, and/or  
   - E2B envd file read of the staged tar  
4. Worker writes R2: `users/{userId}/checkpoint.tar.gz` + manifest  

**On create / replaceRuntime:** Worker `POST /internal/restore` with the R2 blob before serving traffic.

Normal E2B pause/unpause does **not** need R2. See [documentation/deployment/memorymanagement.md](../../documentation/deployment/memorymanagement.md).

## Local verification

```bash
cd E2B-Template/harness
python3 -m pytest -q test_server.py test_checkpoint.py  # if pytest available
```
