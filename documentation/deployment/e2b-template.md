# E2B template (Hermes + product runtime)

How to build the **shared sandbox image** FromDonna users boot from: Hermes (possibly customized), CLIs, optional MCPs, plugins, and extra product code.

Related: [memorymanagement.md](./memorymanagement.md) (pause vs R2 Architecture B), [../tooling/general.md](../tooling/general.md) (secrets stay on Worker), [../gateway/telegram.md](../gateway/telegram.md) (Worker create + inject + checkpoint harvest).

Source tree: `E2B-Template/`

## Live status (FromDonna)

| Item | Value |
|------|--------|
| Prod template alias | `fromdonna-hermes` |
| Dev template alias | `fromdonna-hermes-dev` |
| Gateway var | `E2B_TEMPLATE=fromdonna-hermes` |
| Harness port | `8788` (uvicorn warm start) |
| Hermes config | `config/hermes/config.yaml` → LLM proxy + `grok-4.5` + **`web.backend: exa`** |
| Hermes SOUL | `config/hermes/SOUL.md` → `/home/user/.hermes/SOUL.md` (**You are Donna.**) |
| Hermes MEMORY seed | `config/hermes/memories/MEMORY.md` → compact connect-apps pointer only |
| Built-in memory tool | **`memory.memory_enabled: false`** (USER profile off; memory nudge `0`) |
| Skill self-improvement | **`skills.creation_nudge_interval: 10`** (post-turn skill review on) |
| Harness code | `E2B-Template/harness/` (`server.py`, `gateway_runtime.py`, `checkpoint.py`) |
| Web / Exa | Stub `EXA_API_KEY=STUB` + `EXA_BASE_URL` → [api-proxy](../tooling/api-proxy-worker.md); real key never in image |

### Hermes agent defaults (product policy)

Baked from `config/hermes/config.yaml` (re-read after template rebuild):

| Key | Value | Meaning |
|-----|--------|---------|
| `memory.memory_enabled` | `false` | No Hermes `memory` tool writes to MEMORY/USER |
| `memory.user_profile_enabled` | `false` | No USER.md profile injection path |
| `memory.nudge_interval` | `0` | No post-turn **memory** background review fork |
| `skills.creation_nudge_interval` | `10` | Post-turn **skill** curator still runs (~every 10 turns) |
| `display.memory_notifications` | `off` | Quiet UX — no 💾 review chat spam |
| `display.streaming` / TG | `false` | Single final reply (avoids mid-turn draft swallowing finals) |
| FromDonna thinking-dots | **Removed** | No `.`/`..`/`...` bubble (`fromdonna_ux` deleted 2026-07-27) |
| `web.backend` | `exa` | Via api-proxy stub key |

**SOUL** is persona-only (`You are Donna.…`). **MEMORY** seed is a short Composio connect-apps pointer (not a runbook). Connect procedure lives in skill `extensions/skills/productivity/connect-apps/`. There is **no** harness `product_memory` re-assert anymore (removed). Detail: [../hermes/identity-and-memory.md](../hermes/identity-and-memory.md).

### What is baked today

- Vendored Hermes under `E2B-Template/hermes/`
- Agent-only Hermes config (no channel tokens; **Exa as default web backend**; memory tool off as above)
- Default Donna `SOUL.md` (`config/hermes/SOUL.md` → `~/.hermes/SOUL.md`)
- Compact `MEMORY.md` seed (connect-apps pointer)
- Product plugins under `extensions/plugins` (e.g. `fromdonna_transport`)
- FastAPI harness: `/health`, `/bootstrap`, `/telegram/update`, `/internal/checkpoint/status`, `/internal/checkpoint/export`, `/internal/restore`, legacy `/turn`
- Checkpoint pack/stage helpers (`checkpoint.py`)
- `exa-py` (Hermes `[messaging,exa]`); Exa SDK base URL points at api-proxy
- `setStartCmd` starts uvicorn and waits for port 8788

### What is *not* baked

- Telegram bot token, E2B API key, Codex/OAuth, relay secret, **real `EXA_API_KEY`**
- Per-user `WORKER_TO_HARNESS_SECRET` (injected post-create via `/bootstrap`)
- Per-user LLM capability tokens (injected per inject as short-lived capability)
- Per-user R2 data (restored after create if a checkpoint exists)

### Warm start + `/bootstrap` + restore

Build snapshots uvicorn already listening. Create-time `envVars` do **not** reach that process. After `Sandbox.create`, the gateway:

1. Waits for `GET /health`
2. `POST /bootstrap` with secret + telegramProxy + `userId` / `workerUrl`
3. **`POST /internal/restore`** with R2 checkpoint body if one exists for `userId`
4. Stores sandbox id in D1 as `ready`

See [telegram.md](../gateway/telegram.md) and [memorymanagement.md](./memorymanagement.md).
## Goal

One reusable template (e.g. `fromdonna-hermes`) so every user sandbox starts with:

- Hermes Agent installed (pinned, optionally **your fork / patches**)
- System tools + **CLIs** you want on `PATH`
- Optional **plugins**, **bundled skills**, **local MCP servers** (secret-free only)
- Extra **product code** (HTTP harness, thin tool wrappers that call Worker)
- Optional **warm start** (process already listening for Worker)

**Not** in the template: Telegram/WhatsApp tokens, real OAuth tokens, per-user `~/.hermes` brain, R2 user files.

## What you can bake in

| Layer | Examples | Notes |
|-------|----------|--------|
| **Base OS / runtimes** | Python, Node, `uv`, build tools | Pin versions |
| **Hermes** | Official install **or** your modified tree | Pin commit/tag |
| **Hermes config (defaults)** | Tools on/off; **no real channel tokens** (proxy + capabilities); official TG adapter runs in-sandbox | Secrets via bootstrap / create only if unavoidable |
| **CLIs** | `gh`, `gog`, `ffmpeg`, `jq`, custom bins | No real API keys in image |
| **Plugins** | Hermes plugins you ship to all users | Product-wide, not per-user experiments |
| **Bundled skills** | Skills every user should start with | Per-user skills still grow in live `~/.hermes` |
| **MCP (local stdio)** | Secret-free local servers only | Auth-heavy MCP (Zepto etc.) → Worker, not image secrets |
| **Product code** | Small HTTP server, Worker client, fake-token CLI wrappers | Calls Worker with capability |
| **Start command** | Warm Hermes / harness on a port | Snapshot so create is fast |

## What stays out (always)

- Channel bot tokens  
- `COMPOSIO_API_KEY` / Composio project secrets (live only on **composio-proxy** — see [../tooling/composio.md](../tooling/composio.md))  
- Long-lived user OAuth (vaulted in Composio, not the image)  
- Per-user memory/skills history (that accumulates **after** create in their sandbox)  
- User artifacts (those go to **R2** via tools)

## End-to-end process

### 1. Decide the recipe

List explicitly:

1. Hermes source (upstream pin vs your repo/branch)  
2. Default `config.yaml` policy (e.g. terminal on/off)  
3. CLIs + package versions  
4. Plugins / bundled skills  
5. Local MCPs (if any) + how they’re registered **without** secrets  
6. Extra code paths (harness entrypoint)  
7. Warm start: yes/no + port  

### 2. Define the template (Build System 2.0 style)

Conceptually:

```text
base image
  → install OS packages + runtimes
  → install CLIs
  → install / copy Hermes (pinned; your patches applied)
  → install plugins + bundled skills into the image Hermes home template
  → copy default config + product harness code
  → register secret-free MCP entries if needed
  → setStartCmd(harness) + wait for port   # optional but recommended
  → build → template name/id
```

Exact API is E2B’s template SDK/CLI (`Template` / `e2b template build`). Prefer **reproducible, pinned** steps over “latest” floating installs.

### 3. Install CLIs

At **build** time, put binaries on `PATH` (apt, official installers, copied bins).

For CLIs that need API keys at runtime:

- Prefer **Worker proxy / fake token + base URL** (see tooling doc)  
- Do **not** bake production keys into the template  
- Optional: placeholder env in docs only; real inject only via controlled create if you accept the risk  

### 4. Hermes: stock vs modified

**Stock**

- Install pinned Hermes release into the image  
- Minimal config: **no real bot token**; Telegram via Worker proxy base URL after bootstrap  

**Modified Hermes (your patches / fork)**

- Copy or `git clone` **your** Hermes at a **pinned commit** during build  
- Install deps from that tree  
- Same idea: one known-good agent binary/tree for all users  

Upgrading Hermes later = **new template build** + optional user recreate + restore live `~/.hermes` (see memory doc).

### 5. Plugins

- Install product plugins into the image’s Hermes plugin path so **every** new sandbox has them  
- User-specific plugins they add later live in **that user’s** live `~/.hermes` (pause preserves; rebuild needs `~/.hermes` transfer)

### 6. MCP in the template

| MCP type | In template? |
|----------|----------------|
| Local stdio, **no secrets** | Optional yes (command + args in default config) |
| Remote MCP with **Bearer / OAuth** | **No secrets in image** — Worker holds auth; agent gets toolified calls |
| Per-user OAuth MCP (e.g. Zepto) | Worker MCP client; not “API key in every E2B” |

If default config lists an MCP server, ensure either:

- it needs no secret, or  
- config points at **Worker** as the only privileged hop (not real third-party keys in the box)

### 7. Additional product code

Typical extras in the image:

- **HTTP harness** (implemented):  
  - `GET /health` — liveness + gateway/proxy readiness  
  - `POST /bootstrap` — Worker secret + Telegram proxy + identity + optional **`composioMcp`** (writes Hermes `mcp_servers.composio`; no product API key)  
  - `POST /telegram/update` — inject Update into official Hermes Telegram gateway  
  - `GET /internal/checkpoint/status` — stage handshake (`idle` \| `packing` \| `ready` \| `failed`)  
  - `GET /internal/checkpoint/export` — Worker pull of staged runtime checkpoint  
  - `POST /internal/restore` — apply R2 checkpoint after create/replace  
  - `POST /turn` — legacy path  
- **Checkpoint packer** (`checkpoint.py`) — filtered agent-home + workspace tar; packing/ready/failed markers for harvest  

- **Composio** — capability Bearer only at bootstrap; OAuth vault stays on composio-proxy ([../tooling/composio.md](../tooling/composio.md))  
- **Thin tools** / wrappers that call Workers for API / MCP  

- CLI shims that rewrite upstream base URLs to Worker  

This code is **yours**, versioned in FromDonna, **copied in at template build** (`template.ts` copies `harness/` + `hermes/` + default config + plugins).
### 8. Warm start (recommended)

```text
setStartCmd → start harness
wait until port accepts connections
```

Build captures a snapshot with the process **already running** → `Sandbox.create` is much cheaper than “install + boot Hermes from zero” every time.

**Caveat:** env frozen at start — create-time `envVars` do not update the snapshotted uvicorn. FromDonna handles this with **`POST /bootstrap`** after create (harness secret, Telegram proxy, optional `composioMcp`, identity), then live turns via **`POST /telegram/update`** with a short-lived LLM capability header. Legacy **`POST /turn`** is not the primary Telegram path. Never put long-lived provider keys in the image.

### 9. Build and name

```text
build template → e.g. fromdonna-hermes@v3
record template id/name in Worker config
```

### 10. Wire create path

Worker on first need (implemented in `cloudflare/gateway`):

```text
POST api.e2b.app/sandboxes
  templateID: fromdonna-hermes
  autoPause + autoResume   # safety net; primary idle path is post-turn pause
  timeout: 3600
  metadata.fromdonna_user_id
→ wait GET https://8788-{id}.e2b.dev/health
→ POST /bootstrap { secret, userId, workerUrl, telegramProxy, composioMcp? }
→ POST /internal/restore  (R2 blob if any)
→ D1 status=ready

Per turn (after inject):
→ poll GET /internal/checkpoint/status → export on ready → R2
→ ~60s quiet (unless activity_epoch bumped) → POST E2B …/pause
```

`composioMcp` is minted by the gateway from composio-proxy (shared MCP URL + per-user Bearer). See [../tooling/composio.md](../tooling/composio.md).

Before later messages: `POST .../sandboxes/{id}/connect` then `POST /telegram/update`.  
After agent sessions: sandbox stages checkpoint; Worker harvests to R2 (Architecture B).  
Don’t rebuild the template per message.
### Build commands

```bash
cd E2B-Template
cp .env.example .env   # E2B_API_KEY only
npm install
npm run build:dev      # fromdonna-hermes-dev
npm run build:prod     # fromdonna-hermes
npm run smoke          # create sandbox, probe hermes + harness /health
```

## Upgrade workflow

When you change Hermes patches, CLIs, plugins, or harness code:

```
1. Update recipe / product code
2. Build new template version
3. New users → new template immediately
4. Existing users:
   a. Keep old sandbox until you choose to migrate, or
   b. Create new sandbox from new template
      → restore that user’s live ~/.hermes (from old box or R2 backup)
      → update user → sandbox_id
      → delete old sandbox
```

User **R2 files** do not need moving (already durable).  
**`~/.hermes`** moves only on rebuild/backup (see memorymanagement).

## Day-to-day vs image

| Concern | Where it lives |
|---------|----------------|
| Hermes binary, CLIs, stock plugins, harness | **Template** |
| User skills/memory/config/sessions drift | **Live sandbox `~/.hermes` + workspace** |
| Runtime checkpoint for replace/missing box | **R2** (Worker pull after use) |
| Product docs/images/exports (tools) | **R2** (later / separate path) |
| Secrets / OAuth | **Worker / product vault** |

## Ops checklist

1. Pin Hermes (commit/version) + CLI versions  
2. Apply your Hermes mods/plugins/bundled skills in the recipe  
3. Copy harness (`checkpoint.py`, gateway runtime) + default config  
4. Default config: no real channel tokens; official in-sandbox Telegram gateway + proxy after bootstrap
5. MCP: only secret-free local in-image; privileged MCP via Worker
6. Warm `setStartCmd` + port wait
7. Build → Worker `E2B_TEMPLATE=fromdonna-hermes` + R2 `USER_STATE` bound  
8. Smoke: create sandbox → `/health` → `/bootstrap` → inject path → no product secrets in env dump  
9. After a real turn: confirm R2 `users/{userId}/manifests/latest.json` updates  

## One-line summary

**Template build = pin Hermes, plugins, and harness (including checkpoint stage/export/restore) once; users get create/resume from that image; secrets stay off the image; per-user brain is live on the sandbox and durably checkpointed to R2 via Worker pull.**
