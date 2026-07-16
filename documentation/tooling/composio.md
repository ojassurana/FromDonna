# Composio (OAuth vault + MCP for Hermes)

Multi-user connectors (Gmail, Drive, GitHub, …) via **Composio**.  
Sandboxes never hold `COMPOSIO_API_KEY`. Hermes uses a **native MCP client** against a FromDonna Worker proxy.

Related: [general.md](./general.md) · gateway provision in `cloudflare/gateway/` · proxy in `cloudflare/composio-proxy/`.

## Architecture

```text
Telegram → gateway (D1 user_agents + E2B)
  → bootstrap: ensure Composio user rules + mint MCP token
  → Hermes mcp_servers.composio
       url:  https://fromdonna-composio-proxy…/mcp   (SAME for all users)
       headers.Authorization: Bearer <short-lived token>
            │
            ▼
composio-proxy Worker
  verify token → user_id + toolkits
  COMPOSIO_API_KEY → Composio tool_router session
  proxy MCP → user's Gmail/… connections
```

| Piece | Where | Lifetime |
|--------|--------|----------|
| `COMPOSIO_API_KEY` | composio-proxy secret only | product |
| Donna `user_id` | D1 `user_agents` / bootstrap | forever (= Composio user) |
| Toolkit allowlist | D1 `user_composio.toolkits_json` | forever (policy) |
| OAuth connections | Composio under `user_id` | until disconnect |
| MCP Bearer for Hermes | Injected at bootstrap (and re-minted on every inject) | **30 days** default (`SESSION_TTL_SECONDS=2592000`); sticky Composio session id in D1 |

**Not** a different public MCP URL per person. Identity is in the Bearer token.

### Production lifetime

- **OAuth connections** under Donna `user_id` persist in Composio (connect once).
- **Composio tool-router session** (`trs_…`) is stored in D1 and **reused** across sandboxes (not recreated every message).
- **Hermes Bearer** defaults to **30 days** and is **re-minted on every gateway bootstrap/inject** so long-running Donna boxes stay valid.
- `POST /internal/session/refresh` re-issues Bearer from a prior token (up to 7d past expiry) without a new Composio user.

## Default toolkit allowlist (new users)

Composio **Tool Router slugs** (validated live). Underscore forms like `google_drive` are **invalid**.

```yaml
gmail, googledrive, googlecalendar, googlesheets, googledocs,
github, notion, linkedin, dropbox, splitwise, outlook, dropbox_sign
```

Aliases (`google_drive` → `googledrive`, etc.) are canonicalized in the proxy.

**Not in default** (need Composio project auth configs or invalid slugs): `docusign`, `strava`, `onedrive`, `sharepoint`.

Source of truth: `cloudflare/composio-proxy/src/toolkits.ts`  
(gateway copy for D1 seeding: `cloudflare/gateway/src/composio.ts`).

## Lifecycle

1. **First user / first E2B** — gateway `ensureUserComposio` + `mintComposioMcpAccess` during `bootstrapHarness`.
2. **Later E2B** — same `user_id`; re-mint token only; no second Composio identity.
3. **Connect an app** — `POST /internal/connect` on composio-proxy (gateway-authenticated) returns Composio redirect URL.

## Ops

```bash
cd cloudflare/composio-proxy
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put COMPOSIO_SESSION_SECRET   # share with gateway (or reuse WORKER_TO_HARNESS_SECRET)
npx wrangler deploy

cd ../gateway
# optional: same session secret as composio-proxy
npx wrangler secret put COMPOSIO_SESSION_SECRET
npx wrangler d1 migrations apply fromdonna-routing --remote
npx wrangler deploy
```

### Health

```bash
curl -sS https://fromdonna-composio-proxy.<account>.workers.dev/health
```

### Internal session (gateway only)

```bash
curl -sS -X POST "$COMPOSIO_PROXY/internal/session" \
  -H "Authorization: Bearer $COMPOSIO_SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"telegram:123","toolkits":["gmail"]}'
```

## Non-goals

- Composio key in E2B template / Hermes env  
- Full Composio catalog for every user  
- Nango  

## Verification checklist

- [x] No `COMPOSIO_API_KEY` under `E2B-Template/`  
- [x] Proxy health + default toolkits  
- [x] MCP Bearer TTL = 30d (`SESSION_TTL_SECONDS=2592000`); sticky `trs_` in D1  
- [x] Live MCP `tools/list` returns Composio tool-router tools (`COMPOSIO_MANAGE_CONNECTIONS`, search/execute, …)  
- [x] Live `POST /internal/connect` → `connect.composio.dev` login URL  
- [x] Sticky session re-mint sets `reused_composio_session: true`  
- [x] Prod E2B template rebuilt with Composio harness (`fromdonna-hermes`)  
- [x] Sandbox bootstrap writes Hermes `mcp_servers.composio` (url + Bearer, timeout/skip_preflight)  
- [x] Default toolkit slugs validated live (incl. `googledrive`, `googlecalendar`, …)  
- [ ] New Telegram user → `user_composio` row with default toolkits (gateway path on real DM)  
- [ ] User completes browser OAuth → Gmail tool call succeeds  
- [ ] New E2B for same user reuses OAuth connections  

### Production deploy order

```bash
# 1) composio-proxy secrets + deploy
cd cloudflare/composio-proxy
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put COMPOSIO_SESSION_SECRET
npx wrangler deploy

# 2) gateway (same COMPOSIO_SESSION_SECRET) + D1 migrations
cd ../gateway
npx wrangler secret put COMPOSIO_SESSION_SECRET
npx wrangler d1 migrations apply fromdonna-routing --remote
npx wrangler deploy

# 3) E2B template (harness writes mcp_servers.composio)
cd ../../E2B-Template
npm run build:prod   # alias fromdonna-hermes
# Existing user sandboxes keep the old image until recreated/reclaimed.
```
