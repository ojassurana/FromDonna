# FromDonna documentation

Architecture and ops notes for the multi-user Hermes product: one Telegram bot, one Cloudflare control plane, one E2B sandbox (+ Hermes) per user.

## Index

### Gateway (control plane)

| Doc | Contents |
|-----|----------|
| [gateway/gateway.md](./gateway/gateway.md) | Channel-agnostic design: Worker owns I/O + routing; sandbox is agent-only |
| [gateway/telegram.md](./gateway/telegram.md) | **Live Telegram adapter** — webhook, D1 schema, provision, harness contract, deploy |
| [gateway/telegram-auth.md](./gateway/telegram-auth.md) | **Telegram auth** — Worker ↔ sandbox secrets, proxy tokens, threat model (not LLM) |
| [gateway/llm-proxy-worker.md](./gateway/llm-proxy-worker.md) | LLM proxy Worker, streaming SSE shim, Codex relay, capability tokens |
| [gateway/ops.md](./gateway/ops.md) | **Ops runbook** — status checks, logs, failures, secret rotation, deploy matrix |

### Deployment (sandbox image)

| Doc | Contents |
|-----|----------|
| [deployment/e2b-template.md](./deployment/e2b-template.md) | Template recipe, warm start, `/bootstrap`, harness checkpoint endpoints |
| [deployment/memorymanagement.md](./deployment/memorymanagement.md) | **Arch B:** pause vs R2 checkpoint (stage → Worker pull → restore) |
| [deployment/fromdonna-persistence-technical-report.pdf](./deployment/fromdonna-persistence-technical-report.pdf) | Full technical report (implementation + live verification) |

### Hermes (in-sandbox agent)

| Doc | Contents |
|-----|----------|
| [hermes/README.md](./hermes/README.md) | Index for Hermes agent-runtime notes |
| [hermes/identity-and-memory.md](./hermes/identity-and-memory.md) | **SOUL / MEMORY / USER** — prompt order, freeze policy, `memory` tool |

### Tooling

| Doc | Contents |
|-----|----------|
| [tooling/general.md](./tooling/general.md) | Connectors (Nango / CLI / MCP / API); secrets stay on Worker |

## Live path (one sentence)

**User DMs `@fromdonna_bot` → gateway Worker + D1 → dedicated E2B Hermes (official Telegram gateway) → LLM proxy (capability only) → reply via Bot API proxy; after use, Worker pulls a runtime checkpoint to R2 for restore if the box is replaced.**

## Repo map

```text
cloudflare/gateway/     Telegram Worker + D1 + R2 USER_STATE checkpoints
cloudflare/llm-proxy/   OpenAI-compatible inference Worker + host relay
E2B-Template/           Sandbox image (Hermes, harness, config)
documentation/          This tree
```
