# FromDonna documentation

Architecture and ops notes for the multi-user Hermes product: one Telegram bot, one Cloudflare control plane, one E2B sandbox (+ Hermes) per user.

## Index

### Gateway (control plane)

| Doc | Contents |
|-----|----------|
| [gateway/gateway.md](./gateway/gateway.md) | Channel-agnostic design: Worker = edge + proxies; sandbox = official Hermes channel adapter + brain |
| [gateway/telegram.md](./gateway/telegram.md) | **Live Telegram adapter** — webhook, D1 schema, provision, harness contract, deploy |
| [gateway/telegram-auth.md](./gateway/telegram-auth.md) | **Telegram auth** — Worker ↔ sandbox secrets, proxy tokens, threat model (not LLM) |
| [gateway/llm-proxy-worker.md](./gateway/llm-proxy-worker.md) | LLM proxy Worker, streaming SSE shim, Codex relay, capability tokens |
| [gateway/ops.md](./gateway/ops.md) | **Ops runbook** — status checks, logs, failures, secret rotation, deploy matrix |
| [gateway/delete-user-data.md](./gateway/delete-user-data.md) | **User wipe protocol** — E2B + R2 + D1 order; post-wipe provision notes |

### Deployment (sandbox image)

| Doc | Contents |
|-----|----------|
| [deployment/e2b-template.md](./deployment/e2b-template.md) | Template recipe, warm start, `/bootstrap`, harness checkpoint endpoints |
| [deployment/memorymanagement.md](./deployment/memorymanagement.md) | **Three per-user resources** (D1 + E2B + R2); Arch B pause vs R2 checkpoint |
| [deployment/fromdonna-persistence-technical-report.pdf](./deployment/fromdonna-persistence-technical-report.pdf) | Full technical report (implementation + live verification) |

### Hermes (in-sandbox agent)

| Doc | Contents |
|-----|----------|
| [hermes/README.md](./hermes/README.md) | Index for Hermes agent-runtime notes |
| [hermes/identity-and-memory.md](./hermes/identity-and-memory.md) | **SOUL / MEMORY / USER** — prompt order, freeze policy, `memory` tool |
| [Hermes Understanding/README.md](./Hermes%20Understanding/README.md) | **Instructions map** — sequential system-seed layers + hard-coded/example text |

### Tooling

| Doc | Contents |
|-----|----------|
| [tooling/general.md](./tooling/general.md) | Connectors (OAuth / CLI / MCP / API); **four** Worker doors |
| [tooling/composio.md](./tooling/composio.md) | **Composio** — OAuth vault, capability Bearer, MCP proxy, storage & threat notes |
| [tooling/api-proxy-worker.md](./tooling/api-proxy-worker.md) | **API proxy** — Exa + protocol for more HTTP connectors; keys never in E2B |

## Live path (one sentence)

**User DMs `@fromdonna_bot` → gateway Worker + D1 → dedicated E2B (official Hermes Telegram gateway) → LLM proxy (capability) + API proxy (Exa stub) + composio-proxy MCP (per-user Bearer) → reply via Worker Bot API proxy; after use, Worker may pull a runtime checkpoint to R2.**

## Repo map

```text
cloudflare/gateway/          Channel-agnostic gateway Worker + D1 + R2 checkpoints + Bot API proxy
cloudflare/llm-proxy/        OpenAI-compatible inference Worker + host relay
cloudflare/api-proxy/        HTTP API connectors (Exa first); product API keys
cloudflare/composio-proxy/   Composio OAuth/MCP door; product COMPOSIO_API_KEY
E2B-Template/                Sandbox image (Hermes, harness, config)
documentation/               This tree
```
