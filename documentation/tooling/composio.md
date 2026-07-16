# Composio (OAuth vault + MCP for Hermes)

Multi-user app connections (Gmail, Drive, GitHub, …) via **Composio**.

- Sandboxes never hold `COMPOSIO_API_KEY` or provider OAuth tokens.
- Hermes uses a **native MCP client** against a FromDonna Worker (`fromdonna-composio-proxy`).
- Shared public MCP URL for all users; **identity is a per-user capability Bearer**.

| Related | Path |
|---------|------|
| Connector buckets overview | [general.md](./general.md) |
| Gateway bootstrap / mint | `cloudflare/gateway/src/composio.ts` |
| Proxy Worker | `cloudflare/composio-proxy/` |
| E2B harness apply | `E2B-Template/harness/server.py` (`composioMcp`) |
| Agent notes | root `AGENTS.md` (Composio section) |

---

## 1. Architecture

```text
Telegram → gateway (D1 user_agents + user_composio + E2B)
  → bootstrapHarness: ensureUserComposio + mintComposioMcpAccess
  → POST sandbox /bootstrap { composioMcp: { url, token, toolkits } }
  → Hermes mcp_servers.composio
       url:  https://fromdonna-composio-proxy…/mcp   (SAME for all users)
       headers.Authorization: Bearer <capability token>
            │
            ▼
composio-proxy Worker
  verify HMAC Bearer → user_id + toolkits + sticky session
  COMPOSIO_API_KEY → Composio tool_router (trs_…)
  reverse-proxy MCP → that user's connected apps
```

**Not** a different public MCP URL per person. Identity is in the Bearer.

### Live URLs (this account)

| Piece | Value |
|--------|--------|
| Proxy Worker | `https://fromdonna-composio-proxy.code-df4.workers.dev` |
| MCP endpoint | `…/mcp` |
| Gateway var | `COMPOSIO_PROXY_URL` → same base |

---

## 2. What is stored where

### We do **not** store (user OAuth / product key)

| Item | Where it lives |
|------|----------------|
| `COMPOSIO_API_KEY` | composio-proxy **Worker secret only** |
| Gmail / Drive / GitHub **access & refresh tokens** | **Composio** vault, keyed by Donna `user_id` |
| Full Composio catalog for every user | Not enabled (allowlist only) |

### We **do** store (FromDonna)

| Item | Where | Lifetime |
|------|--------|----------|
| Donna `user_id` | D1 `user_agents` / bootstrap | Forever (= Composio `user_id`) |
| Toolkit allowlist | D1 `user_composio.toolkits_json` | Forever (product policy) |
| Sticky tool-router session id (`trs_…`) | D1 `user_composio.composio_session_id` | Until force-new / recreate |
| Sticky Composio MCP URL | D1 `user_composio.composio_mcp_url` | Same as session |
| MCP **capability Bearer** | Hermes `~/.hermes/config.yaml` on the sandbox (not D1) | **30 days** default; re-minted on gateway **bootstrap** |

Migrations: `cloudflare/gateway/migrations/0004_user_composio.sql`, `0005_user_composio_session_sticky.sql`.

---

## 3. Capability token (MCP Bearer)

Short name for the Hermes → proxy credential. **Not** the user's Google token.

| Property | Value |
|----------|--------|
| Format | HMAC-signed session claims (`COMPOSIO_SESSION_SECRET`) |
| Claims | `user_id`, toolkits, optional sticky `composio_session_id` / `composio_mcp_url`, `exp` |
| Default TTL | **30 days** (`SESSION_TTL_SECONDS=2592000` on proxy; code floor 1h, ceiling 90d) |
| When re-minted | Gateway **harness bootstrap** (create, reclaim, unhealthy sandbox) — not every Telegram message |
| Refresh | `POST /internal/session/refresh` — re-issue from prior token (accepts up to **7 days** past expiry) |
| Sticky Composio session | Reused from D1 when present (avoids thrashing `trs_` every bootstrap) |

### If the Bearer is stolen

Treat like a **stolen session cookie for that one user**:

- Attacker can call `/mcp` **as that user** for allowlisted toolkits until expiry.
- Cannot forge tokens without `COMPOSIO_SESSION_SECRET`.
- Cannot read other users' connections.
- Does **not** leak `COMPOSIO_API_KEY` or offline OAuth refresh tokens.

**Mitigate later (not required for MVP):** shorter TTL, re-mint every inject, bind to `runtime_id`, revoke list.

**If leaked now:** rotate `COMPOSIO_SESSION_SECRET` on proxy **and** gateway (all old Bearers die); optionally user disconnects apps in Composio/Google; recreate sandbox for a fresh mint.

---

## 4. Default toolkit allowlist

Composio **Tool Router slugs** (validated live against Composio).  
Underscore Google names like `google_drive` are **invalid**.

```text
gmail, googledrive, googlecalendar, googlesheets, googledocs,
github, notion, linkedin, dropbox, splitwise, outlook, dropbox_sign
```

Aliases are canonicalized in the proxy (`google_drive` → `googledrive`, etc.).

**Not in default** (need project auth configs or bad slugs): `docusign`, `strava`, `onedrive`, `sharepoint`.

Source of truth: `cloudflare/composio-proxy/src/toolkits.ts`  
Gateway seed copy: `cloudflare/gateway/src/composio.ts` (keep in sync).

---

## 5. User experience

1. New Telegram user → gateway seeds `user_composio` + mints Bearer on first sandbox bootstrap.
2. User: “connect my Gmail” (or Drive, etc.).
3. Hermes uses Composio MCP tools, especially **`COMPOSIO_MANAGE_CONNECTIONS`**, and may search/execute via `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_MULTI_EXECUTE_TOOL`.
4. User gets a **`connect.composio.dev`** link → browser OAuth once per app.
5. Connection stays under that `user_id` in Composio across sandboxes.
6. Days later: “connect Calendar” → same flow for another allowlisted app; prior apps remain.

Ops can also mint a link without Hermes:

`POST /internal/connect` on the proxy (gateway-authenticated) → `redirect_url`.

Composio wiring lives in Hermes `mcp_servers.composio` + tool schemas (not SOUL — SOUL stays persona-only).

---

## 6. Lifecycle (code path)

1. **First user / first E2B** — `ensureUserComposio` + `mintComposioMcpAccess` in `bootstrapHarness`.
2. **Harness** — template bakes the **official Hermes Composio MCP block** (`mcp_servers.composio` with `url` / `headers` / `connect_timeout: 60` / `timeout: 180` / `skip_preflight: true`, same shape as [composio.dev/hermes](https://composio.dev/hermes)). Bootstrap sets `FROMDONNA_COMPOSIO_MCP_TOKEN` (and URL); Hermes expands `Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}` like any other `${ENV}` MCP secret. Hermes auto-includes `composio` into platform toolsets (`include_default_mcp_servers`). Applied **before** Telegram gateway start so stock `discover_mcp_tools` loads it.
3. **Later E2B** — same `user_id`; re-mint Bearer; reuse sticky `trs_` from D1 when possible.
4. **Connect** — manage-connections tool or `POST /internal/connect`.
5. **Template change** — rebuild `fromdonna-hermes` (`npm run build:prod`); old sandboxes keep old image until reclaimed/recreated.

---

## 7. Proxy API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | public | Service + default toolkits |
| `GET` | `/v1/toolkits/default` | public | Allowlist JSON |
| `POST` | `/internal/session` | internal Bearer / `x-fromdonna-internal` | Create or re-mint capability + optional sticky session |
| `POST` | `/internal/session/refresh` | internal | Re-issue Bearer from prior token |
| `POST` | `/internal/connect` | internal | Toolkit login `redirect_url` |
| `*` | `/mcp` | user capability Bearer | Hermes MCP reverse-proxy to Composio |

Internal auth secret: `COMPOSIO_SESSION_SECRET` (or fallbacks documented in `env.ts`). Gateway sends the same secret it uses to mint.

---

## 8. Ops

### Secrets

| Secret | Worker |
|--------|--------|
| `COMPOSIO_API_KEY` | **composio-proxy only** |
| `COMPOSIO_SESSION_SECRET` | composio-proxy **and** gateway (shared HMAC) |

Never put either in E2B template, git, or llm/api-proxy.

### Deploy order

```bash
# 1) composio-proxy
cd cloudflare/composio-proxy
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put COMPOSIO_SESSION_SECRET
npx wrangler deploy

# 2) gateway + D1
cd ../gateway
npx wrangler secret put COMPOSIO_SESSION_SECRET
npx wrangler d1 migrations apply fromdonna-routing --remote
npx wrangler deploy

# 3) E2B template (harness writes mcp_servers.composio)
cd ../../E2B-Template
npm run build:prod   # alias fromdonna-hermes
```

### Health / smoke

```bash
curl -sS https://fromdonna-composio-proxy.code-df4.workers.dev/health

curl -sS -X POST "$COMPOSIO_PROXY/internal/session" \
  -H "Authorization: Bearer $COMPOSIO_SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"telegram:123","toolkits":["gmail"]}'
# expect: mcp_url, mcp_token, ttl_seconds ≈ 2592000, composio_session_id
```

### Tests

```bash
cd cloudflare/composio-proxy && npm test
```

---

## 9. Non-goals

- Composio key or user OAuth tokens in E2B / Hermes long-lived env  
- Full Composio catalog for every user  
- Per-user public MCP URL  
- Nango (removed)

---

## 10. Verification checklist

- [x] No `COMPOSIO_API_KEY` under `E2B-Template/`
- [x] Proxy health + default toolkits (validated slugs)
- [x] MCP Bearer TTL = 30d; sticky `trs_` in D1
- [x] Live MCP `tools/list` (manage connections, search, execute, …)
- [x] Live `POST /internal/connect` → `connect.composio.dev`
- [x] Sticky re-mint sets `reused_composio_session: true`
- [x] Prod E2B template includes Composio harness bootstrap
- [x] Sandbox bootstrap writes `mcp_servers.composio` with Bearer
- [ ] Real Telegram user → `user_composio` row (live DM)
- [ ] User completes browser OAuth → Gmail tool call succeeds
- [ ] New E2B for same user reuses OAuth connections

---

## 11. Future hardening (optional)

- Shorter Bearer TTL + refresh on inject  
- Bind token to `runtime_id` / sandbox id  
- Explicit revoke list  
- Telegram `/connect` shortcut calling `mintComposioConnectLink`  
- Force Hermes MCP reload after mid-life re-mint
