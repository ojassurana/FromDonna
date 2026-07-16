# Tooling — multi-user sandbox app

How connectors are managed when **each user has an E2B sandbox**.  
Secrets never live in the sandbox. The agent mostly sees **tools** (plus local **CLI** in the box).

## Front door (three Workers)

```
User message → gateway Worker (identity + channel) → that user’s E2B
Any external action → E2B → dedicated Worker door → backend
```

| Worker | Role | Secrets |
|--------|------|---------|
| **`fromdonna-gateway`** | Channels, D1 routing, E2B lifecycle, Bot API proxy | Telegram / harness / E2B |
| **`fromdonna-llm-proxy`** | Model inference only | Relay + LLM capability HMAC |
| **`fromdonna-api-proxy`** | Plain HTTP API connectors (Exa first) | `EXA_API_KEY`, future API keys |
| **`fromdonna-composio-proxy`** | OAuth apps vault + MCP door (Composio) | `COMPOSIO_API_KEY`, session HMAC |

- **E2B** = untrusted computer per user (code, shell, local files).
- **API keys for product connectors** = **api-proxy only**, never gateway, never sandbox.
- **Composio API key** = **composio-proxy only**, never gateway, never sandbox.
- Sandbox never gets long-lived provider secrets (Gmail, Zepto, Exa, OAuth tokens, etc.).

See [api-proxy-worker.md](./api-proxy-worker.md) for the API door and the **protocol for adding more API connectors**.

## Connector buckets

| Bucket | What it is | Where it runs | Auth | What the agent sees |
|--------|------------|---------------|------|---------------------|
| **OAuth apps** | User-connected third-party accounts (Gmail, GitHub, …) | Shared vault outside E2B (product Worker path) — **not** per sandbox | User connects once; tokens vaulted under product `user_id` | Tools → **gateway or api-proxy tool path** → vaulted credentials → provider |
| **CLI** | Shell binaries / local programs | **Inside that user’s E2B** | No key: local only. Needs key: **fake token + Worker URL**; real key on **api-proxy** (or CLI-specific door) | Agent runs CLI in sandbox; secret path is Worker-backed |
| **MCP** | Vendor/custom MCP (e.g. Zepto MCP) | Shared MCP process/URL — **not** one MCP install per E2B by default | Per-user session/token vaulted outside E2B | Tools → Worker is MCP client → real MCP |
| **API** | Plain HTTP APIs (e.g. **Exa**) | Upstream API | Product key on **`fromdonna-api-proxy` only** | Hermes tools (`web_search` / `web_extract` via Exa) → api-proxy → Exa |

## How each is managed

### 1. OAuth apps (Composio)

- Multi-user OAuth (Gmail, GitHub, …) lives **outside** E2B under **Composio**, keyed by Donna `user_id`.
- Agent does not hold `COMPOSIO_API_KEY` or long-lived provider tokens in the sandbox.
- Flow: Hermes **MCP client** → **composio-proxy** Worker (short-lived Bearer) → Composio → provider.
- Same public MCP URL for all sandboxes; identity is in the session token.
- Toolkit allowlist for new users (not full catalog): see [composio.md](./composio.md).
- Connect once per app via Composio Connect link (Worker-minted).

### 2. CLI

- Runs in the user’s sandbox (needs a real shell).
- **No secret:** run as normal in E2B.
- **Needs API key:** do not put the real key in sandbox env long-term.
  - Prefer: CLI pointed at a Worker (custom base URL / HTTP proxy) with a **placeholder** credential; Worker injects the real key.
  - Or: thin wrapper script that calls Worker instead of the upstream API.
- Industry pattern: credential broker / short-lived token; never long-lived keys in the agent box.

### 3. MCP

- Worker is the **MCP client** for multi-user product use.
- Agent does **not** speak MCP JSON-RPC; it only gets **toolified** entry points.
- Registry: `server id → URL, auth type, which users`.
- One protocol for all MCPs, e.g. `POST /internal/mcp/call` with capability + `server` + `tool` + `args`.
- **Do not** reimplement vendor MCP “inside” an OAuth vault unless you own that integration layer. Zepto’s own MCP → Worker talks to Zepto MCP directly.
- Local stdio MCP with **no secrets** may run in that user’s E2B; anything with auth stays outside.

### 4. API (Exa live)

- Same shape from the agent’s view: tools call a **proxied** HTTP API.
- **`EXA_API_KEY` lives only on `fromdonna-api-proxy`** (wrangler secret).
- Sandbox: `web.backend: exa`, `EXA_API_KEY=STUB`, `EXA_BASE_URL=https://fromdonna-api-proxy…/v1/exa`.
- Hermes uses official `exa-py` with base URL override → api-proxy → `api.exa.ai`.
- Auth today: **stub** (`x-api-key: STUB`). Later: real short-lived capability (same family as LLM proxy).
- Prefer direct API proxy over remote MCP when you only need search/extract.

## What is “toolified”

| Kind | Toolified for the agent? | Worker involved? |
|------|--------------------------|------------------|
| OAuth apps | Yes | Always |
| API | Yes | Always (**api-proxy**) |
| MCP | Yes (Worker is MCP client) | Always |
| CLI | No (raw shell in E2B) | Only when a key/proxy is required |
| LLM | Yes (OpenAI-compatible) | **llm-proxy** + real capability |

## Per-user state (outside E2B)

Store on gateway D1/R2 and/or a product OAuth vault (not in the agent box long-term):

- stable `user_id`
- OAuth connection ids / connected accounts
- MCP sessions if multi-user
- optional personal API keys (vaulted)
- capability signing secrets (gateway + llm-proxy; api-proxy later)

## What each E2B gets

- Code, shell, secret-free CLIs
- Thin tools that only call **your Workers**
- Short-lived **LLM** capability; **API stub** until capability ships for api-proxy
- **Not** long-lived Gmail/GitHub/Zepto/Exa/OAuth secrets

## Explicit non-goals

- Full OAuth store installed in every E2B
- Real OAuth/API tokens living in the agent sandbox
- Product API keys on the **gateway** Worker (channels only)
- Different one-off auth path per connector without a shared Worker door
- Hermes `mcp_servers` with real Bearer tokens inside untrusted multi-user sandboxes

## One-line summary

**Four backends (OAuth apps, CLI, MCP, API), three Worker doors (gateway / llm-proxy / api-proxy), credentials outside E2B; the agent sees tools plus local CLI.**
