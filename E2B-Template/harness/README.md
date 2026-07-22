# Harness

```
Channel → Cloudflare Worker (edge) → sandbox harness
  → agent runtime GatewayRunner + TelegramAdapter (Telegram today)
  → outbound via Worker Bot API proxy
```

## Invariant

- **Worker** owns webhooks, E2B lifecycle, Bot API proxy, **R2 checkpoint put/restore**.
- **Sandbox** runs the agent gateway runtime (not long-lived channel tokens).
- One sandbox = one user = one agent `~/.hermes` brain + `workspace`.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness; `auth_ready`, `telegram_proxy_ready`, `gateway_running` |
| POST | `/bootstrap` | body secret | Inject harness secret + optional Telegram proxy + `userId` / `workerUrl` |
| POST | `/telegram/update` | Bearer + `x-llm-capability` | Inject one raw Telegram Update into the agent gateway |
| GET | `/internal/checkpoint/export` | Bearer | Worker pulls staged checkpoint tar (Architecture B) |
| POST | `/internal/restore` | Bearer | Worker pushes R2 checkpoint (gzip tar) after create/replace |
| GET | `/internal/debug/request-dumps` | Bearer | List agent `request_dump_*.json` files (newest first) |
| GET | `/internal/debug/latest-api-request` | Bearer | Newest full API dump (+ extracted `instructions`); `?instructions_only=true` for plain text |
| GET | `/internal/debug/request-dumps/{filename}` | Bearer | One dump by name; same `?instructions_only` |
| POST | `/turn` | Bearer + `x-llm-capability` | Legacy harness turn path |

### Inspecting the model “instructions” (system seed)

Same mechanism as the [Chitti first-API-request explainer](https://chitti-explainers.pages.dev/hermes-first-api-request/):

1. Image sets `HERMES_DUMP_REQUESTS=1` (see `template.ts` / gateway runtime).
2. On every LLM call the agent runtime writes a redacted dump under  
   `~/.hermes/sessions/request_dump_{session}_{timestamp}.json`.
3. After a Telegram message, pull it:

```bash
# From a machine that can reach the sandbox harness port:
curl -sS -H "Authorization: Bearer $WORKER_TO_HARNESS_SECRET" \
  "https://8788-<sandboxId>.<domain>/internal/debug/latest-api-request" | jq .

# Plain system seed only (Responses `instructions` or Chat Completions system msg):
curl -sS -H "Authorization: Bearer $WORKER_TO_HARNESS_SECRET" \
  "https://8788-<sandboxId>.<domain>/internal/debug/latest-api-request?instructions_only=true"
```

**Shape note:** FromDonna’s baked `config.yaml` uses `api_mode: chat_completions` (via llm-proxy), so the wire body is `messages` + `tools`, not xAI Responses `instructions` + `input`. The harness still surfaces the system seed as `instructions` in the JSON summary. The Chitti explainer dump was Responses API to xAI directly.

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
