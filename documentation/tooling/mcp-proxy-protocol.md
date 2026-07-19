# Protocol: adding another product MCP

Use this whenever you add a **multi-user MCP integration** that needs secrets or per-user identity **outside** E2B.

This is the same **product door** pattern as Composio — not a second auth model.

| Related | Path |
|---------|------|
| Connector buckets | [general.md](./general.md) |
| Reference implementation | [composio.md](./composio.md) + `cloudflare/composio-proxy/` |
| Plain HTTP APIs (not MCP) | [api-proxy-worker.md](./api-proxy-worker.md) |

---

## When to use this protocol

| Situation | Use |
|-----------|-----|
| Vendor/custom **MCP** with a product key, service token, or per-user session | **This protocol** (Worker MCP door) |
| Multi-user **OAuth apps** (Gmail, Drive, GitHub, …) | Prefer **Composio** + toolkit allowlist — do **not** stand up a parallel OAuth vault |
| Plain **HTTP API** + product key (Exa-style) | **api-proxy** — [api-proxy-worker.md](./api-proxy-worker.md) |
| Local **stdio MCP with no secrets** | May run **inside** that user’s E2B (no Worker door) |
| Channel bot tokens / model credentials | **gateway** / **llm-proxy** — not MCP |

---

## Architecture (canonical)

```text
Hermes (sandbox)  mcp_servers.<name>
  url:     https://fromdonna-<door>…/mcp     ← SAME public URL for all users
  headers: Authorization: Bearer ${FROMDONNA_<NAME>_MCP_TOKEN}
           (yaml holds ${…} placeholder only)
            │
            ▼
Product MCP Worker (door)
  verify capability Bearer → user_id + policy claims
  hold real product secret(s) on Worker only
  reverse-proxy MCP  OR  act as MCP client to upstream
            │
            ▼
Upstream MCP / tool router / vendor
```

Hermes remains the **MCP client** to **our** door (list tools → expand into `tools[]`).  
The Worker holds secrets and enforces identity — same split as composio-proxy.

```text
Not this:
  per-user public MCP URL
  COMPOSIO_API_KEY / vendor key in E2B or gateway
  literal Bearer written into config.yaml on disk
  inventing a third capability/auth family
```

---

## Rules (always)

1. **Real product secrets** live only on the **MCP door Worker** (`wrangler secret put …`). Never gateway, llm-proxy, E2B template, harness disk, or git.
2. **Shared public MCP URL** for all sandboxes; **identity is the capability Bearer**, not a different URL per user.
3. **Sandbox** gets process-env capability only: e.g. `FROMDONNA_<NAME>_MCP_TOKEN` (+ URL if needed). Hermes yaml uses `Bearer ${FROMDONNA_<NAME>_MCP_TOKEN}` — expand like other `${ENV}` MCP secrets.
4. **Gateway** mints/verifies capability on **bootstrap** (and provision/replace as hard or soft require — match Composio). Warm Telegram inject may **skip** bootstrap; design for that.
5. **Capability model** = same family as Composio MCP Bearer (HMAC session claims: `user_id`, policy, optional sticky upstream ids, `exp`). Prefer **reuse** `COMPOSIO_SESSION_SECRET` patterns / claim shape — do **not** invent a third auth scheme next to LLM capability + Composio Bearer without an explicit product decision.
6. **Allowlist / policy** for what tools or toolkits a user may reach (D1 or Worker config). Do not expose full vendor catalogs by default.
7. **Sticky upstream session** (if the vendor is sessionful): store ids/URLs in **D1**, not in the sandbox, so E2B recreate reuses them.
8. After any harness / template / default Hermes MCP block change: **`cd E2B-Template && npm run build:prod`** (`fromdonna-hermes`). Existing sandboxes keep the old image until recreated.
9. **SOUL stays persona-only** — connect/procedure lives in a skill + config, not SOUL/MEMORY procedure walls.
10. **Never commit** real API keys or live capability tokens.

---

## Checklist

| Step | Where | What |
|------|--------|------|
| 1. Choose door | `cloudflare/` | **New** Worker (`fromdonna-<name>-proxy`) **or** extend an existing MCP door if the product boundary is the same. Prefer one door per trust domain (Composio OAuth vault ≠ random vendor MCP). |
| 2. Public MCP surface | Worker | `*` or streamable HTTP on `/mcp` (or documented path). Reverse-proxy to upstream MCP **or** terminate MCP and call upstream as client. |
| 3. Internal mint | Worker + gateway | `POST /internal/session` (or reuse gateway helper): create/reuse sticky upstream session if needed; return `{ url, token, … }` for harness. Auth internal secret same family as Composio. |
| 4. Capability Bearer | Worker | HMAC-verify on `/mcp`. Claims: at least `user_id`, policy (toolkits/tools allowlist), `exp`; optional sticky `upstream_session_id` / `upstream_mcp_url`. Default TTL product decision (Composio production = **30d**). |
| 5. Secrets | Worker only | `npx wrangler secret put <VENDOR>_…` — never on gateway/E2B. |
| 6. D1 policy / sticky | gateway migrations | Per-user row if needed (allowlist JSON, sticky session id, sticky upstream MCP URL). Mirror `user_composio` shape when analogous. |
| 7. Gateway bootstrap | `cloudflare/gateway/` | Mint on harness bootstrap; inject into `/bootstrap` payload; hard vs soft require (provision hard, warm inject soft — same tradeoffs as Composio). Prefer **service binding** to the door Worker (avoid CF **1042** on public `workers.dev` fetch). |
| 8. Harness apply | `E2B-Template/harness/` | Set process env token (+ URL); write Hermes `mcp_servers.<name>` with shared url + `Authorization: Bearer ${FROMDONNA_<NAME>_MCP_TOKEN}`; `connect_timeout` / `timeout` / `skip_preflight` as needed. Reload MCP if gateway already running. Health flag e.g. `<name>_mcp_ready`. |
| 9. Hermes config | template `config/hermes/` | Bake default `mcp_servers.<name>` block (placeholder Bearer only). Ensure platform toolsets include the server if it must be on by default (`include_default_mcp_servers` / explicit enable). |
| 10. Agent UX | skills / MEMORY seed | Connect or usage procedure in a **skill** (and optional product MEMORY pointer) — **not** SOUL. |
| 11. Tests | Worker + harness | Reject bad Bearer; secret never returned; mint sticky reuse; harness env + yaml placeholder; optional live `tools/list` smoke. |
| 12. Docs | this file + [general.md](./general.md) + [composio.md](./composio.md) if OAuth-related | Door URL, secret names, env vars, D1 tables, bootstrap hard/soft rules. |
| 13. Deploy + template | ops | Deploy Worker → gateway binding/vars → **`E2B-Template` `npm run build:prod`**. Recreate sandboxes to pick up image changes. |

---

## Hermes side (what the model sees)

FromDonna does **not** use provider-native Responses `type: "mcp"`. Hermes is the MCP client:

1. Connect to **our** `/mcp` with the capability Bearer.  
2. `list_tools` (and optional `tools/list_changed` refresh).  
3. Expand each tool into normal function schemas in **`tools[]`**.  
4. On tool call → Hermes → our door → upstream.

If the upstream catalog updates, Hermes refreshes its registry; the model sees the new set on the **next** API request. The Worker usually **pass-throughs** MCP; it does not own a second full tool catalog unless you intentionally filter/allowlist at the door.

**Cost note:** Large MCP catalogs bloat `tools[]` every turn. Prefer allowlists / tool filters at session mint or Worker policy.

---

## Auth and TTL guidance

| Concern | Guidance |
|---------|----------|
| Product key | Worker secret only |
| User OAuth tokens | Prefer **Composio vault** for OAuth apps; do not reimplement |
| Capability Bearer | Process env in harness; not D1; not yaml literal |
| Warm path | Bootstrap may be **skipped** — do not assume remint every Telegram message |
| Stolen Bearer | Treat as session cookie for that user until `exp`; rotate HMAC secret to kill all |

---

## What not to do

- Put vendor MCP keys on **gateway** or in **E2B**  
- Per-user public MCP URLs as the identity mechanism  
- Duplicate **Gmail/Drive-class OAuth** outside Composio without a product decision  
- Write live tokens into `config.yaml` / R2 checkpoints as the primary store  
- Skip template rebuild when the default MCP block or harness apply changes  
- Invent a third capability HMAC dialect when Composio/LLM patterns already exist  
- Put OAuth/MCP runbooks into **SOUL.md**

---

## Reference implementation (Composio)

Copy this shape; do not re-derive from scratch.

| Piece | Where |
|-------|--------|
| Door Worker | `cloudflare/composio-proxy/` |
| Mint + sticky | `cloudflare/gateway/src/composio.ts`, D1 `user_composio` |
| Full product write-up | [composio.md](./composio.md) |
| Harness inject | `E2B-Template/harness/server.py` (`composioMcp`, `_apply_composio_mcp`) |
| Hermes block | `mcp_servers.composio` + `Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}` |
| Agent notes | root `AGENTS.md` (Composio section) |

---

## One-line summary

**Shared product `/mcp` door + per-user capability Bearer + secrets on Worker + Hermes native MCP client → expand tools into `tools[]`. Composio is the reference; this checklist is how you add the next one.**
