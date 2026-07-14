# Harness

Small HTTP (or similar) entrypoint the **Worker** calls:

```
Worker → POST sandbox harness → Hermes turn → reply JSON
```

## Responsibilities

- Accept capability-authenticated requests from Worker  
- Run one user turn on Hermes in this sandbox  
- Return text/media descriptors (Worker sends to Telegram/etc.)  
- Never require channel tokens inside the sandbox  

## Warm start

When ready, `template.ts` `setStartCmd` should start this harness and wait for its port so create is fast.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness |
| POST | `/bootstrap` | none (once) | Inject `WORKER_TO_HARNESS_SECRET` into process memory |
| POST | `/turn` | `Authorization: Bearer <secret>` + `x-llm-capability` | Run one Hermes oneshot turn |

## Why `/bootstrap`

Template warm-start freezes process env at image build time. Create-time `envVars` are visible to new shells but not to the already-running uvicorn. The Worker calls `/bootstrap` immediately after create (and best-effort on later turns).

## LLM path

Hermes uses the existing Cloudflare LLM proxy (`FROMDONNA_LLM_PROXY_BASE_URL` / config.yaml `base_url`) with the per-turn capability as `OPENAI_API_KEY`. No provider OAuth tokens enter the sandbox.

