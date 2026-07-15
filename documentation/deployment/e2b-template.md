# E2B template (Hermes + product runtime)

How to build the **shared sandbox image** FromDonna users boot from: Hermes (possibly customized), CLIs, optional MCPs, plugins, and extra product code.

Related: [memorymanagement.md](./memorymanagement.md) (what lives on the box vs R2), [../tooling/general.md](../tooling/general.md) (secrets stay on Worker), [../gateway/telegram.md](../gateway/telegram.md) (Worker create + `/bootstrap` + `/turn`).

Source tree: `E2B-Template/`

## Live status (FromDonna)

| Item | Value |
|------|--------|
| Prod template alias | `fromdonna-hermes` |
| Dev template alias | `fromdonna-hermes-dev` |
| Gateway var | `E2B_TEMPLATE=fromdonna-hermes` |
| Harness port | `8788` (uvicorn warm start) |
| Hermes config | `config/hermes/config.yaml` → LLM proxy base URL + `grok-4.5` |
| Harness code | `E2B-Template/harness/server.py` |

### What is baked today

- Vendored Hermes under `E2B-Template/hermes/`
- Agent-only Hermes config (no channel tokens)
- FastAPI harness with `/health`, `/bootstrap`, `/turn`
- `setStartCmd` starts uvicorn and waits for port 8788

### What is *not* baked

- Telegram bot token, E2B API key, Codex/OAuth, relay secret
- Per-user `WORKER_TO_HARNESS_SECRET` (injected post-create via `/bootstrap`)
- Per-user capability tokens (injected per `/turn` as `OPENAI_API_KEY` for the Hermes child only)

### Warm start + `/bootstrap`

Build snapshots uvicorn already listening. Create-time `envVars` do **not** reach that process. After `Sandbox.create`, the gateway:

1. Waits for `GET /health`
2. `POST /bootstrap` with `{ "secret": "<WORKER_TO_HARNESS_SECRET>" }`
3. Stores sandbox id in D1 as `ready`

See [telegram.md](../gateway/telegram.md) for the full Worker lifecycle.

## Goal

One reusable template (e.g. `fromdonna-hermes`) so every user sandbox starts with:

- Hermes Agent installed (pinned, optionally **your fork / patches**)
- System tools + **CLIs** you want on `PATH`
- Optional **plugins**, **bundled skills**, **local MCP servers** (secret-free only)
- Extra **product code** (HTTP harness, thin tool wrappers that call Worker)
- Optional **warm start** (process already listening for Worker)

**Not** in the template: Telegram/WhatsApp tokens, Nango secrets, real OAuth tokens, per-user `~/.hermes` brain, R2 user files.

## What you can bake in

| Layer | Examples | Notes |
|-------|----------|--------|
| **Base OS / runtimes** | Python, Node, `uv`, build tools | Pin versions |
| **Hermes** | Official install **or** your modified tree | Pin commit/tag |
| **Hermes config (defaults)** | Tools on/off, agent-only, no gateway tokens | Secrets via env at create only if unavoidable |
| **CLIs** | `gh`, `gog`, `ffmpeg`, `jq`, custom bins | No real API keys in image |
| **Plugins** | Hermes plugins you ship to all users | Product-wide, not per-user experiments |
| **Bundled skills** | Skills every user should start with | Per-user skills still grow in live `~/.hermes` |
| **MCP (local stdio)** | Secret-free local servers only | Auth-heavy MCP (Zepto etc.) → Worker, not image secrets |
| **Product code** | Small HTTP server, Worker client, fake-token CLI wrappers | Calls Worker with capability |
| **Start command** | Warm Hermes / harness on a port | Snapshot so create is fast |

## What stays out (always)

- Channel bot tokens  
- `NANGO_*` / Composio project secrets  
- Long-lived user OAuth  
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
- Minimal agent-only config  

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
  - `POST /bootstrap` — one-time Worker secret into process memory  
  - `POST /turn` — Worker-forwarded message → Hermes `--oneshot` → `{ text }`  
  - `GET /health` — liveness + `auth_ready`  
- **Thin tools** / wrappers that call Worker for Nango / API / MCP  
- CLI shims that rewrite upstream base URLs to Worker  

This code is **yours**, versioned in FromDonna, **copied in at template build** (`template.ts` copies `harness/` + `hermes/` + default config).

### 8. Warm start (recommended)

```text
setStartCmd → start harness
wait until port accepts connections
```

Build captures a snapshot with the process **already running** → `Sandbox.create` is much cheaper than “install + boot Hermes from zero” every time.

**Caveat:** env frozen at start — create-time `envVars` do not update the snapshotted uvicorn. FromDonna handles this with **`POST /bootstrap`** after create, and **capability on each `/turn`**, never long-lived provider keys in the image.

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
  autoPause + autoResume
  metadata.fromdonna_user_id
→ wait GET https://8788-{id}.e2b.dev/health
→ POST /bootstrap { secret }
→ D1 status=ready
```

Before later turns: `POST .../sandboxes/{id}/connect` then `POST /turn`.  
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
| User skills/memory/config drift | **Live sandbox `~/.hermes`** |
| Docs/images/exports | **R2** |
| Secrets / OAuth | **Worker / Nango** |

## Ops checklist

1. Pin Hermes (commit/version) + CLI versions  
2. Apply your Hermes mods/plugins/bundled skills in the recipe  
3. Copy harness + Worker client code  
4. Default config: agent-only, no channel tokens  
5. MCP: only secret-free local in-image; privileged MCP via Worker  
6. Optional warm `setStartCmd` + port wait  
7. Build → set Worker `TEMPLATE_ID`  
8. Smoke test: create sandbox → `which hermes` → CLIs on PATH → one harness turn → no product secrets in env dump  

## One-line summary

**Template build = pin and install Hermes (yours), CLIs, plugins, optional local MCP, and product harness once; users get create/resume from that image; secrets and per-user brain stay off the shared image except via live sandbox + R2 rules.**
