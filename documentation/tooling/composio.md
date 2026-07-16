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

```yaml
gmail, google_drive, google_calendar, google_sheets, google_docs,
github, notion, linkedin, dropbox, onedrive, sharepoint,
docusign, strava, splitwise, outlook, dropbox_sign
```

Source of truth in code: `cloudflare/composio-proxy/src/toolkits.ts`  
(gateway keeps a copy for D1 seeding: `cloudflare/gateway/src/composio.ts`).

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

- [ ] No `COMPOSIO_API_KEY` under `E2B-Template/`  
- [ ] New Telegram user → `user_composio` row with default toolkits  
- [ ] Bootstrap sets Hermes `mcp_servers.composio`  
- [ ] MCP `tools/list` scoped to allowlist (after live key)  
- [ ] Connect Gmail → tool call succeeds  
- [ ] New E2B for same user reuses connections  
