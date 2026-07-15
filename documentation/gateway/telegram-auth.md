# Telegram auth: gateway Worker ↔ E2B sandbox

How **Telegram-related** authentication works between the Cloudflare gateway Worker and each user’s Hermes sandbox. **LLM capability tokens are out of scope** here (see [llm-proxy-worker.md](./llm-proxy-worker.md)).

Source: `cloudflare/gateway/src/bot_api_proxy.ts`, `cloudflare/gateway/src/index.ts`, `E2B-Template/harness/server.py`, `E2B-Template/harness/gateway_runtime.py`.

---

## Model (one sentence)

**Telegram talks only to the Worker. The sandbox never holds the real bot token.** The Worker authenticates itself to the harness with a shared secret, and the sandbox calls Telegram **through** the Worker using a per-user HMAC proxy token.

---

## Secrets (Telegram only)

| Secret | Lives on | Purpose |
|--------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Worker only | Real Bot API token; used only when proxying to `api.telegram.org` |
| `TELEGRAM_WEBHOOK_SECRET` | Worker + Telegram `setWebhook` | Inbound webhook: `X-Telegram-Bot-Api-Secret-Token` |
| `WORKER_TO_HARNESS_SECRET` | Worker; also injected into sandbox at create / `/bootstrap` | Shared secret for control plane (bootstrap + inject) **and** minting Bot API proxy tokens |

`E2B_API_KEY` is for E2B lifecycle only (create/connect/kill), not Telegram message auth.

---

## Layer 1 — Telegram → Worker (edge)

```text
Telegram servers
  → POST /telegram/webhook
  → Header X-Telegram-Bot-Api-Secret-Token must match TELEGRAM_WEBHOOK_SECRET
```

If the header is wrong, the Worker rejects the update. Sandboxes never see this secret.

---

## Layer 2 — Worker → sandbox (control plane)

Shared secret: **`WORKER_TO_HARNESS_SECRET`**.

| Call | Auth |
|------|------|
| `POST https://8788-{sandboxId}.e2b.dev/bootstrap` | JSON body `secret` must match (sets harness secret + optional telegram proxy config; starts official Hermes Telegram gateway) |
| `POST …/telegram/update` | Header `Authorization: Bearer <WORKER_TO_HARNESS_SECRET>` |

Only a caller that knows the harness secret can bootstrap the box or inject raw Telegram Updates into Hermes’ official `TelegramAdapter`.

Also at create time the Worker may pass `WORKER_TO_HARNESS_SECRET` in E2B `envVars` so the harness process can become `auth_ready` without a separate env reload (warm-start caveat: prefer `/bootstrap` as the source of truth).

---

## Layer 3 — Sandbox → Worker Bot API proxy (outbound Telegram)

Hermes runs the **official** `TelegramAdapter` with PTB custom base URLs (same hook as a local Bot API server):

| PTB / Hermes field | Value |
|--------------------|--------|
| `base_url` | `https://<worker>/telegram-bot-api/bot` |
| `base_file_url` | `https://<worker>/telegram-bot-api/file/bot` |
| `token` | **Proxy token**, not the real bot token |

### Proxy token format

```text
fd1.<b64url(userId)>.<b64url(chatId)>.<b64url(hmac16)>
```

- HMAC key: `WORKER_TO_HARNESS_SECRET`
- Material: `bot-proxy:v2:{userId}:{chatId}`
- Minted by Worker at `/bootstrap` (`mintBotProxyToken` in `bot_api_proxy.ts`)

### What the Worker does on each Bot API call

1. Parse path: `/telegram-bot-api/bot{proxyToken}/{method}`
2. `verifyBotProxyToken` — invalid / malformed base64 → **401** (must not 500; that used to make Hermes retry connect for a long time)
3. Swap in real `TELEGRAM_BOT_TOKEN` and forward to `api.telegram.org`
4. For chat-scoped methods (`sendMessage`, etc.): **force `chat_id`** to the conversation bound in the token (sandbox cannot message arbitrary chats)
5. Block ownership methods: `getUpdates`, `setWebhook`, `deleteWebhook`, `logout`, `close`, etc.

```text
Hermes TelegramAdapter
  → HTTPS Worker /telegram-bot-api/bot{fd1…}/sendMessage
  → Worker verifies HMAC, rewrites chat_id, attaches real bot token
  → api.telegram.org
```

---

## End-to-end picture

```text
User DM
  → Telegram
  → Worker webhook (TELEGRAM_WEBHOOK_SECRET)
  → D1 user → sandbox id
  → E2B create/connect
  → POST /bootstrap
        secret = WORKER_TO_HARNESS_SECRET
        telegramProxy.token = fd1… (HMAC)
  → POST /telegram/update
        Authorization: Bearer WORKER_TO_HARNESS_SECRET
  → Official Hermes TelegramAdapter.process_update
  → Outbound Bot API via Worker proxy (proxy token → real token)
```

---

## Threat model (honest)

### Safer than

Putting **`TELEGRAM_BOT_TOKEN`** (or webhook secret) inside every E2B sandbox.

### Current limits

| Risk | Why |
|------|-----|
| **Shared harness secret** | One `WORKER_TO_HARNESS_SECRET` for all users. Leak = can mint proxy tokens for any user/chat and call inject/bootstrap on any box that uses that secret. |
| **Secret often present in the sandbox** | Create-time env / bootstrap leaves the secret in process memory; a compromised agent environment can read it. |
| **Proxy tokens are not short-lived** | Valid until the harness secret rotates; no per-turn expiry today. |
| **No mTLS / per-sandbox identity** | Auth is “knows secret / valid HMAC,” not a unique sandbox cert. |

### If `WORKER_TO_HARNESS_SECRET` leaks

Treat the Telegram bridge as **compromised until rotated**:

1. `printf '%s' 'NEW' | npx wrangler secret put WORKER_TO_HARNESS_SECRET` (gateway Worker)
2. Kill existing sandboxes / clear D1 routes (or force re-provision) so old env secrets die
3. Next messages re-bootstrap with the new secret

See also [ops.md](./ops.md) secret rotation.

### Hardening direction (not implemented)

Short-lived, **Worker-minted**, per-user (per-turn) capabilities for inject + Bot API proxy, with the minting key **never** in the sandbox — same *idea* as LLM capabilities, applied to Telegram. Today’s LLM capability path does **not** replace this Telegram auth.

---

## Related docs

| Doc | Contents |
|-----|----------|
| [telegram.md](./telegram.md) | Live adapter, D1, provision, harness HTTP contract |
| [gateway.md](./gateway.md) | Channel-agnostic Worker vs sandbox split |
| [ops.md](./ops.md) | Deploy, tails, rotate secrets |
| [../deployment/e2b-template.md](../deployment/e2b-template.md) | Warm start, `/bootstrap` after create |
