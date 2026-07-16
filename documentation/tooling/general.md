# Tooling — multi-user sandbox app

How connectors work when **each user has an E2B sandbox**.  
Secrets never live long-term in the sandbox. The agent sees **tools** (plus local **CLI** in the box).

## Front door (four Workers)

```text
User message → gateway Worker (identity + channel) → that user’s E2B
Any external action → E2B → dedicated Worker door → backend
```

| Worker | Role | Secrets |
|--------|------|---------|
| **`fromdonna-gateway`** | Channels, D1 routing, E2B lifecycle, Bot API proxy | Telegram / harness / E2B; shared Composio session HMAC |
| **`fromdonna-llm-proxy`** | Model inference only | Relay + LLM capability HMAC |
| **`fromdonna-api-proxy`** | Plain HTTP API connectors (Exa first) | `EXA_API_KEY`, future product API keys |
| **`fromdonna-composio-proxy`** | OAuth apps vault + MCP door (Composio) | `COMPOSIO_API_KEY`, session HMAC |

Rules:

- **E2B** = untrusted computer per user (code, shell, local files).
- **Product HTTP API keys** = **api-proxy only** ([api-proxy-worker.md](./api-proxy-worker.md)).
- **Composio API key** = **composio-proxy only** ([composio.md](./composio.md)).
- Sandbox never gets long-lived provider secrets (Gmail OAuth, Exa real key, etc.).

## Connector buckets

| Bucket | What it is | Where it runs | Auth | What the agent sees |
|--------|------------|---------------|------|---------------------|
| **OAuth apps** | User-connected accounts (Gmail, GitHub, …) | **Composio** outside E2B | Connect once in browser; tokens vaulted under Donna `user_id` | Hermes **MCP** tools → **composio-proxy** (capability Bearer) → Composio → provider |
| **CLI** | Shell binaries / local programs | **Inside** that user’s E2B | No key: local. Needs key: placeholder + Worker URL | Agent runs CLI; secret path is Worker-backed |
| **MCP (generic)** | Vendor/custom MCP with auth | Shared process/URL outside E2B by default | Per-user session/token vaulted outside E2B | Prefer Worker as MCP client; agent gets tools |
| **API** | Plain HTTP APIs (e.g. **Exa**) | Upstream via **api-proxy** | Product key on api-proxy only | Hermes tools → api-proxy (stub today) → vendor |

Composio is the **OAuth apps** bucket implemented as a **product MCP door** (specialized Worker). Details: [composio.md](./composio.md).

## How each is managed

### 1. OAuth apps (Composio)

- Vault: **Composio**, keyed by Donna `user_id` forever.
- Flow: Hermes MCP client → **composio-proxy** (30d capability Bearer) → Composio tool_router → provider.
- Same public MCP URL for all sandboxes; identity is in the Bearer.
- Toolkit **slug** allowlist for new users (not full catalog).
- User: ask Donna → manage-connections / login link → `connect.composio.dev` once per app.
- D1 holds allowlist + sticky session pointers only — **not** OAuth tokens.

Full write-up: [composio.md](./composio.md).

### 2. CLI

- Runs in the user’s sandbox (needs a real shell).
- **No secret:** run as normal in E2B.
- **Needs API key:** do not put the real key in sandbox env long-term.
  - Prefer: CLI pointed at a Worker (custom base URL) with a **placeholder** credential; Worker injects the real key.
  - Or: thin wrapper that calls a Worker instead of the upstream API.

### 3. MCP (generic / non-Composio)

- Multi-user product MCP with secrets: **Worker is the MCP client** (or reverse-proxy like composio-proxy).
- Local stdio MCP with **no secrets** may run in that user’s E2B.
- Do not reimplement vendor MCP inside an OAuth vault you do not own.

**Exception — Composio:** Hermes *is* the MCP client to **our** proxy URL; the proxy holds the product key. That is intentional (native Hermes MCP + capability Bearer).

### 4. API (Exa live)

- **`EXA_API_KEY` only on `fromdonna-api-proxy`**.
- Sandbox: `web.backend: exa`, `EXA_API_KEY=STUB`, `EXA_BASE_URL=https://fromdonna-api-proxy…/v1/exa`.
- Auth today: stub. Later: short-lived capability (same family as LLM proxy).
- Protocol to add more: [api-proxy-worker.md](./api-proxy-worker.md).

## What is “toolified”

| Kind | Toolified for the agent? | Worker involved? |
|------|--------------------------|------------------|
| OAuth apps (Composio) | Yes (MCP tools) | **composio-proxy** |
| API | Yes | **api-proxy** |
| Generic MCP | Yes | Product Worker path |
| CLI | No (raw shell) | Only when a key/proxy is required |
| LLM | Yes (OpenAI-compatible) | **llm-proxy** + capability |

## Per-user state (outside E2B)

| Store | Examples |
|-------|----------|
| Gateway D1 | `user_id`, routing, `user_composio` (toolkits + sticky session ids) |
| Composio | OAuth connections for that `user_id` |
| R2 | Runtime checkpoints (Hermes home), not OAuth |
| Sandbox only | Short-lived MCP capability Bearer in Hermes config |

## What each E2B gets

- Code, shell, secret-free CLIs  
- Hermes config pointing at **Workers** (llm-proxy, api-proxy stub, composio-proxy MCP)  
- Short-lived **LLM** capability; **Composio** capability Bearer (30d default); **API stub** until capability ships for api-proxy  
- **Not** long-lived Gmail/GitHub/Exa/Composio product secrets  

## Explicit non-goals

- Full OAuth store installed in every E2B  
- Real OAuth/API product tokens living in the agent sandbox  
- Product API keys or `COMPOSIO_API_KEY` on the **gateway** (channels + routing only)  
- Different one-off auth path per connector without a shared Worker door  

## One-line summary

**Four backends (OAuth apps, CLI, MCP, API), four Worker doors (gateway / llm-proxy / api-proxy / composio-proxy), credentials outside E2B; the agent sees tools plus local CLI.**
