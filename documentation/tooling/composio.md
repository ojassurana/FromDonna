# Composio (OAuth vault + MCP for Hermes)

Multi-user app connections (Gmail, Drive, GitHub, …) via **Composio**.

- Sandboxes never hold `COMPOSIO_API_KEY` or provider OAuth tokens.
- Hermes uses a **native MCP client** against a FromDonna Worker (`fromdonna-composio-proxy`).
- Shared public MCP URL for all users; **identity is a per-user capability Bearer**.

| Related | Path |
|---------|------|
| Connector buckets overview | [general.md](./general.md) |
| **Protocol: adding another product MCP** | [mcp-proxy-protocol.md](./mcp-proxy-protocol.md) (Composio is the reference implementation) |
| Gateway bootstrap / mint | `cloudflare/gateway/src/composio.ts` |
| Gateway → proxy | **Service binding** `COMPOSIO_PROXY` (not public `workers.dev` fetch — CF **1042**) |
| Proxy Worker | `cloudflare/composio-proxy/` |
| E2B harness apply | `E2B-Template/harness/server.py` (`composioMcp`) |
| Agent notes | root `AGENTS.md` (Composio section) |

---

## 1. Architecture

```text
Telegram → gateway (D1 user_agents + user_composio + E2B)
  → bootstrapHarness: ensureUserComposio + mintComposioMcpAccess
  → POST sandbox /bootstrap { composioMcp: { url, token, toolkits } }
  → harness process env:
       FROMDONNA_COMPOSIO_MCP_TOKEN=<capability Bearer>
       FROMDONNA_COMPOSIO_MCP_URL=https://fromdonna-composio-proxy…/mcp
  → Hermes mcp_servers.composio (on disk — placeholder only):
       url:  https://fromdonna-composio-proxy…/mcp   (SAME for all users)
       headers.Authorization: "Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}"
       connect_timeout: 60 / timeout: 180 / skip_preflight: true
            │
            ▼
composio-proxy Worker
  verify HMAC Bearer → user_id + toolkits + sticky session claims
  COMPOSIO_API_KEY → Composio tool_router (trs_…)
  reverse-proxy MCP → that user's connected apps
```

**Not** a different public MCP URL per person. Identity is in the Bearer (process env), **not** a literal token in yaml.

### Live URLs (this account)

| Piece | Value |
|--------|--------|
| Proxy Worker | `https://fromdonna-composio-proxy.code-df4.workers.dev` |
| MCP endpoint | `…/mcp` |
| Gateway var | `COMPOSIO_PROXY_URL` → same base |
| Gateway service binding | `COMPOSIO_PROXY` → `fromdonna-composio-proxy` (mint/connect) |

---

## 2. What is stored where

### We do **not** store (user OAuth / product key)

| Item | Where it lives |
|------|----------------|
| `COMPOSIO_API_KEY` | composio-proxy **Worker secret only** |
| Gmail / Drive / GitHub **access & refresh tokens** | **Composio** vault, keyed by Donna `user_id` |
| Full Composio catalog for every user | Not enabled (allowlist only) |
| Capability Bearer on disk / in D1 | Never — process env only |

### We **do** store (FromDonna)

| Item | Where | Lifetime |
|------|--------|----------|
| Donna `user_id` | D1 `user_agents` / bootstrap | Forever (= Composio `user_id`) |
| Toolkit allowlist | D1 `user_composio.toolkits_json` | Forever (product policy) |
| Sticky tool-router session id (`trs_…`) | D1 `user_composio.composio_session_id` | Until force-new / recreate |
| Sticky **upstream** Composio MCP URL | D1 `user_composio.composio_mcp_url` | Same as sticky `trs_` — this is Composio’s hosted session MCP target, **not** the shared product `fromdonna-composio-proxy…/mcp` URL |
| MCP **capability Bearer** | Harness **process env** `FROMDONNA_COMPOSIO_MCP_TOKEN` (not D1; **not** a literal secret in yaml) | **30 days** default claim TTL; re-minted only when gateway runs **bootstrap** (see warm path) |

**Bearer placement (do not misread the yaml):** Hermes `~/.hermes/config.yaml` stores only a placeholder — `Authorization: "Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}"`. The real token is set in the **harness process environment** on `/bootstrap` (`FROMDONNA_COMPOSIO_MCP_TOKEN` + `FROMDONNA_COMPOSIO_MCP_URL`). It is **process-env only** (not written to `.env` or disk); a harness restart drops it until the next gateway bootstrap re-mints and re-injects.

Migrations: `cloudflare/gateway/migrations/0004_user_composio.sql`, `0005_user_composio_session_sticky.sql`.

---

## 3. Capability token (MCP Bearer)

Credential Hermes presents to **our** composio-proxy `/mcp`. **Not** the user's Google/GitHub token. **Not** “short-lived” like LLM capability nonces — production default is **30 days**.

| Property | Value |
|----------|--------|
| Format | HMAC-signed session claims (`COMPOSIO_SESSION_SECRET`) |
| Claims | `user_id`, toolkits, optional sticky `composio_session_id` / **upstream** `composio_mcp_url`, `exp` (optional `runtime_id`) |
| Default TTL | **30 days** (`SESSION_TTL_SECONDS=2592000` on proxy; code floor 1h, ceiling 90d) |
| When re-minted | Only when gateway runs **`bootstrapHarness`**: first provision, replaceRuntime, cold resume / unhealthy harness, inject-retry re-bootstrap. **Not** every Telegram message |
| Warm inject | If harness `/health` already shows TG gateway live (`auth_ready` + `telegram_proxy_ready` + `gateway_running`), inject **skips `/bootstrap` entirely** — even when `composio_mcp_ready: false`. No remint on that path |
| Gateway mint path | Always `POST /internal/session` (create or reuse sticky `trs_`). Gateway does **not** call `/internal/session/refresh` today |
| Proxy refresh API | `POST /internal/session/refresh` exists on composio-proxy (re-issue Bearer from a prior token; accepts up to **7 days** past expiry) — ops/manual only unless gateway is wired later |
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

Gateway helper `mintComposioConnectLink` exists in `cloudflare/gateway/src/composio.ts` but is **not** wired to a Telegram `/connect` command yet — product path is Hermes manage-connections (or direct proxy internal connect).

Composio wiring lives in Hermes `mcp_servers.composio` + tool schemas + `connect-apps` skill (not SOUL — SOUL stays persona-only).

---

## 6. Lifecycle (code path)

1. **First user / first E2B** — `ensureUserComposio` + `mintComposioMcpAccess` in `bootstrapHarness` with **`requireComposio: true`**. Mint returning null fails provision (does **not** mark D1 ready).
2. **Harness** — template bakes the **official Hermes Composio MCP block** (`mcp_servers.composio` with `url` / `headers` / `connect_timeout: 60` / `timeout: 180` / `skip_preflight: true`, same shape as [composio.dev/hermes](https://composio.dev/hermes)). Bootstrap sets `FROMDONNA_COMPOSIO_MCP_TOKEN` (and URL) in **process env only**; Hermes expands `Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}` like any other `${ENV}` MCP secret. Hermes auto-includes `composio` into platform toolsets (`include_default_mcp_servers`). Applied **before** Telegram gateway start so stock `discover_mcp_tools` loads it. If the gateway is already running, harness **reloads MCP** (`shutdown` + `discover_mcp_tools` + agent tool refresh) after re-applying the Bearer.
3. **Warm DM (ready sandbox)** — `shouldSkipBootstrap` true when TG gateway is live → **no** mint, **no** `/bootstrap` (latency path). Composio stays whatever is already in process env.
4. **Cold resume / unhealthy / inject retry** — `bootstrapHarness` with **`requireComposio: false`**: best-effort mint + inject; chat still works if mint fails (logs “composio MCP NOT injected…”).
5. **Later E2B / replaceRuntime** — same `user_id`; hard-require mint again; reuse sticky `trs_` from D1 when possible (`force_new` retries on non-401 mint failures).
6. **Connect** — manage-connections tool or `POST /internal/connect`.
7. **Template change** — rebuild `fromdonna-hermes` (`npm run build:prod`); old sandboxes keep old image until reclaimed/recreated.

---

## 7. Proxy API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | public | Service + default toolkits |
| `GET` | `/v1/toolkits/default` | public | Allowlist JSON |
| `POST` | `/internal/session` | internal Bearer / `x-fromdonna-internal` | **Live gateway mint path** — create or re-mint capability + optional sticky session |
| `POST` | `/internal/session/refresh` | internal | Re-issue Bearer from prior token (**proxy API only**; gateway does not call this yet) |
| `POST` | `/internal/connect` | internal | Toolkit login `redirect_url` |
| `*` | `/mcp` | user capability Bearer | Hermes MCP reverse-proxy to Composio |

Internal auth secret: `COMPOSIO_SESSION_SECRET` (or fallbacks documented in `env.ts`). Gateway sends the same secret it uses to mint (both `x-fromdonna-internal` and `Authorization: Bearer`).

---

## 8. Ops

### Secrets

| Secret | Worker |
|--------|--------|
| `COMPOSIO_API_KEY` | **composio-proxy only** |
| `COMPOSIO_SESSION_SECRET` | composio-proxy **and** `fromdonna-gateway` (shared HMAC + internal auth) |

Both Workers need the **same** `COMPOSIO_SESSION_SECRET` or mint returns **401** and sandboxes stay `composio_mcp_ready: false`. A mint **401 is almost always a secret mismatch** (gateway vs proxy), **not** a “stale Composio session” — sticky `trs_` reuse is a separate path; do not force-new / wipe sessions as the first fix for 401.

> **Warning — `INTERNAL_AUTH_SECRET` footgun**
>
> Proxy internal auth may accept **any configured candidate** secret after the multi-candidate fix (`INTERNAL_AUTH_SECRET` → `COMPOSIO_SESSION_SECRET` → `WORKER_TO_HARNESS_SECRET` on the proxy). Gateway presents `COMPOSIO_SESSION_SECRET` (then `WORKER_TO_HARNESS_SECRET`) via `x-fromdonna-internal` — it does **not** read `INTERNAL_AUTH_SECRET`.
>
> **Recommended config:** set the **same** `COMPOSIO_SESSION_SECRET` on gateway **and** composio-proxy, and **do not set** `INTERNAL_AUTH_SECRET` on the proxy unless you intentionally align it to that same value. Setting `INTERNAL_AUTH_SECRET` to a *different* value than gateway’s `COMPOSIO_SESSION_SECRET` is a classic split-brain that yields permanent mint 401s and empty Composio on sandboxes.

Never put either secret in E2B template, git, or llm/api-proxy.

### New-user guarantee (do not regress)

**Restored product policy** (hard vs soft — do not blur):

| Call site | `requireComposio` | On mint/inject / health miss |
|-----------|-------------------|------------------------------|
| **Provision** (first sandbox) | **hard** (`true`) | Fail provision — do **not** mark D1 `ready` without Composio MCP ready |
| **replaceRuntime** (recreate) | **hard** (`true`) | Fail replace — same bar as first provision |
| **Per-message inject** (ready user) | **soft** (`false`) | Warm path may **skip bootstrap** entirely; if bootstrap runs, chat continues on mint miss (log “composio MCP NOT injected…”); no user-facing hard error for transient glitches |

Gateway provision / replaceRuntime **hard-require** harness `/health` → `composio_mcp_ready: true` before finishing (mint → inject → health check, with force-new retries where appropriate). Soft inject never blocks chat on Composio.

`mintComposioMcpAccess` itself returns `null` on failure (no throw). Hard vs soft is entirely the **caller** (`bootstrapHarness` / provision). Do not read the mint helper as “bootstrap always succeeds.”

Harness `/bootstrap` reports `composio_mcp: true` only when the token is live in **process env** + config URL entry — not merely present in the request body. If `composioMcp` is in the body and apply fails, harness returns **502**.

### Deploy order

```bash
# 1) composio-proxy
cd cloudflare/composio-proxy
npx wrangler secret put COMPOSIO_API_KEY
npx wrangler secret put COMPOSIO_SESSION_SECRET   # same value as gateway
npx wrangler deploy

# 2) channel-agnostic gateway + D1
cd ../gateway
# name = fromdonna-gateway
npx wrangler secret put COMPOSIO_SESSION_SECRET   # same value as proxy
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
- Product OAuth path via Nango (not the Composio door; monorepo may still contain other Nango notes elsewhere)

---

## 10. Verification checklist

- [x] No `COMPOSIO_API_KEY` under `E2B-Template/`
- [x] Proxy health + default toolkits (validated slugs)
- [x] MCP Bearer TTL = 30d; sticky `trs_` in D1
- [x] Live MCP `tools/list` (manage connections, search, execute, …)
- [x] Live `POST /internal/connect` → `connect.composio.dev`
- [x] Sticky re-mint sets `reused_composio_session: true`
- [x] Prod E2B template includes Composio harness bootstrap
- [x] Sandbox bootstrap writes `mcp_servers.composio` with **placeholder** Bearer `${FROMDONNA_COMPOSIO_MCP_TOKEN}` (real token in process env)
- [x] Re-bootstrap reloads MCP when gateway already running
- [ ] Real Telegram user → `user_composio` row (live DM)
- [ ] User completes browser OAuth → Gmail tool call succeeds
- [ ] New E2B for same user reuses OAuth connections

---

## 11. Future hardening (optional)

- Shorter Bearer TTL + remint on warm inject (today warm path skips bootstrap)  
- Bind token to `runtime_id` / sandbox id  
- Explicit revoke list  
- Telegram `/connect` shortcut calling `mintComposioConnectLink`  
- Wire gateway to `POST /internal/session/refresh` instead of full `/internal/session` when only the Bearer needs rotation  
