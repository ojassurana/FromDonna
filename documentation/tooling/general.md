# Tooling — multi-user sandbox app

How connectors are managed when **each user has an E2B sandbox**.  
Secrets never live in the sandbox. The agent mostly sees **tools** (plus local **CLI** in the box).

## Front door

```
User message → Worker (identity) → that user’s E2B
Any external action → E2B → Worker (short-lived capability + user_id) → backend
```

- **E2B** = untrusted computer per user (code, shell, local files).
- **Worker** = control plane: verify capability, load **that user’s** credentials, call the real backend.
- Sandbox never gets long-lived provider secrets (Gmail, Zepto, Exa, Nango keys, etc.).

## Four connector buckets

| Bucket | What it is | Where it runs | Auth | What the agent sees |
|--------|------------|---------------|------|---------------------|
| **Nango** | OAuth apps; you own/customize the tool layer | Nango Cloud (or one self-host) — **not** per E2B | User connects via Nango Connect; tokens in Nango under your `user_id` | Tools → Worker → Nango (proxy/actions) → provider |
| **CLI** | Shell binaries / local programs | **Inside that user’s E2B** | No key: local only. Needs key: **fake token + Worker URL** (or wrapper); real key on Worker | Agent runs CLI in sandbox; secret path is Worker-backed |
| **MCP** | Vendor/custom MCP (e.g. Zepto MCP) | Shared MCP process/URL — **not** one MCP install per E2B by default | Per-user session/token in **Worker vault** (if multi-user) | Tools (`zepto_*` / `mcp_call`) → Worker is MCP client → real MCP |
| **API** | Plain HTTP APIs (e.g. Exa) | Upstream API | Product or per-user key on **Worker only** | Tools (`exa_search`) → Worker proxy → API |

## How each is managed

### 1. Nango

- Shared integration hub for multi-user OAuth (Gmail, GitHub, …).
- You can use catalog connectors **and** implement custom tools (TypeScript actions) so you own the tool layer.
- Agent does not talk to Nango with a project secret in E2B.
- Flow: E2B tool → Worker → Nango (connection for `user_id`) → provider.
- Free self-host is mainly auth + proxy; full functions/MCP on Nango self-host often needs Cloud/Enterprise.

### 2. CLI

- Runs in the user’s sandbox (needs a real shell).
- **No secret:** run as normal in E2B.
- **Needs API key:** do not put the real key in sandbox env long-term.
  - Prefer: CLI pointed at Worker (custom base URL / HTTP proxy) with a **placeholder** credential; Worker injects the real key.
  - Or: thin wrapper script that calls Worker instead of the upstream API.
- Industry pattern: credential broker / short-lived token; never long-lived keys in the agent box.

### 3. MCP

- Worker is the **MCP client** for multi-user product use.
- Agent does **not** speak MCP JSON-RPC; it only gets **toolified** entry points.
- Registry on Worker: `server id → URL, auth type, which users`.
- One protocol for all MCPs, e.g. `POST /internal/mcp/call` with capability + `server` + `tool` + `args`.
- **Do not** wrap arbitrary vendor MCP “inside Nango” unless you reimplement that integration as Nango actions. Zepto’s own MCP → Worker talks to Zepto MCP directly.
- Local stdio MCP with **no secrets** may run in that user’s E2B; anything with auth stays outside.

### 4. API

- Same shape as MCP from the agent’s view: **tools only**.
- Worker holds `EXA_API_KEY` (or per-user keys) and proxies HTTP.
- Prefer direct API over remote MCP when you only need search/etc. (same as existing Exa function-tool pattern).

## What is “toolified”

| Kind | Toolified for the agent? | Worker involved? |
|------|--------------------------|------------------|
| Nango | Yes | Always |
| API | Yes | Always |
| MCP | Yes (Worker is MCP client) | Always |
| CLI | No (raw shell in E2B) | Only when a key/proxy is required |

## Per-user state (outside E2B)

Store on Worker and/or Nango:

- stable `user_id` (your DB id)
- Nango connection ids / connected accounts
- MCP sessions (e.g. Zepto) if multi-user
- optional personal API keys
- capability signing for that user’s sandbox

## What each E2B gets

- Code, shell, secret-free CLIs
- Thin tools that only call **your Worker**
- Short-lived capability for those calls
- **Not** long-lived Gmail/GitHub/Zepto/Exa/Nango secrets

## Explicit non-goals

- Nango (or full OAuth store) installed in every E2B
- Real OAuth/API tokens only “because they’re personal” living in the agent sandbox — personal still means vaulted; the sandbox is agent-readable
- Different one-off auth path per connector without a shared Worker door
- Hermes/`mcp_servers` config with real Bearer tokens **inside** untrusted multi-user sandboxes (fine on a **trusted** ops host only)

## One-line summary

**Four backends (Nango, CLI, MCP, API), one Worker door, per-user credentials outside E2B; the agent sees tools plus local CLI.**
