# Memory & file management

How a user’s data is stored across **E2B sandboxes**, **agent home (`~/.hermes`)**, **workspace**, and **R2**.

**Architecture B (live):** after agent use, the sandbox **stages** a filtered checkpoint; the Worker **pulls** it into R2; on create/replace the Worker **restores** from R2.  
Channel-agnostic keys use product `userId` (e.g. `telegram:123`), never a single-channel path layout.

Related: [e2b-template.md](./e2b-template.md), [../gateway/telegram.md](../gateway/telegram.md), [fromdonna-persistence-technical-report.pdf](./fromdonna-persistence-technical-report.pdf).

## Big picture

```
User (years)
  ├── Account / routing          → Worker D1 (user_id → runtime_id)
  ├── Secrets / OAuth            → Worker / product vault (never long-lived in E2B)
  ├── Runtime checkpoint         → R2  users/{userId}/checkpoint.tar.gz
  ├── Product files & artifacts  → R2  (tools path later; optional)
  └── Live agent brain           → that user’s E2B: ~/.hermes + ~/workspace
```

| Concern | Where |
|---------|--------|
| Day-to-day continuity | **E2B pause/resume** (same disk; memory/workspace **not** cleared on unpause) |
| Survive missing / replaced sandbox | **R2 checkpoint** (agent-home + workspace) |
| Channel tokens / E2B API key | **Worker only** |

## Three per-user resources

Every Donna user is allocated **exactly three dedicated usages** outside the shared product edge (gateway, LLM proxy, API proxy, bot token, E2B *template*). Everything else is shared infrastructure.

| # | Resource | Binding / name | Per-user unit | Usage |
|---|----------|----------------|---------------|--------|
| **1** | **D1** (routing) | Worker `FROMDONNA_ROUTING` → DB `fromdonna-routing` | One row in `user_agents` | **Identity & routing only:** channel identity → product `user_id` → live `runtime_id` / `status` / provider. Does **not** store agent memory, skills, or chat history. |
| **2** | **E2B** (live runtime) | Template alias `fromdonna-hermes` (shared image); **one sandbox id per user** | One VM / `runtime_id` (e.g. harness `https://8788-{id}.e2b.dev`) | **Live agent brain:** Hermes + harness, `~/.hermes`, workspace. Day-to-day continuity via pause/resume (same disk). Provisioned/resumed by the gateway with `E2B_API_KEY` (key stays on Worker). |
| **3** | **R2** (durable checkpoint) | Worker `USER_STATE` → bucket `fromdonna-user-state` | Object prefix `users/{userId}/` | **Survive sandbox loss/replace:** filtered agent-home + workspace archive + manifest. Written by Worker **pull** after agent use; **restored** on create/replace. Keys: `checkpoint.tar.gz`, `manifests/latest.json`. |

```text
                    ┌─ 1. D1 ──────────────────────────────────────┐
                    │  user_agents: who is this user, which runtime? │
                    └──────────────────────┬───────────────────────┘
                                           │ runtime_id
              ┌────────────────────────────┼────────────────────────────┐
              ▼                                                         ▼
   ┌─ 2. E2B (this user) ─┐                          ┌─ 3. R2 (this user) ─┐
   │  live Hermes          │   stage → Worker pull    │  users/{userId}/      │
   │  ~/.hermes + workspace │ ───────────────────────► │  checkpoint + manifest│
   │  pause = keep disk    │ ◄── restore on replace ─ │  no channel secrets   │
   └───────────────────────┘                          └──────────────────────┘
```

### What each is *not*

| Resource | Not used for |
|----------|----------------|
| **D1** | Conversation history, SOUL/MEMORY files, workspace files, secrets |
| **E2B** | Long-lived product API keys, bot tokens, R2 credentials, global routing |
| **R2** | Live inference, channel I/O, or as the day-to-day “open the box” path (that’s E2B pause/resume) |

### Shared (not per-user)

Gateway Worker, LLM proxy, API proxy, Telegram bot token / webhook secrets, E2B **template** image — one product-wide copy; sandboxes never hold those long-lived secrets.

### How they stay in sync

| Event | D1 | E2B | R2 |
|-------|----|-----|-----|
| First message / provision | Insert/update row → `ready` + `runtime_id` | Create from template, bootstrap, optional restore | Read checkpoint if present |
| Idle → next message | Lookup `runtime_id` | Resume / connect same sandbox | Unchanged (no restore) |
| After agent session | Unchanged (or status touch) | Stage tar on disk | Worker harvest → put objects |
| replaceRuntime / dead box | New `runtime_id` | New VM; kill old | Restore into new VM if objects exist |

### Ops: inspect one user’s three usages

```bash
# 1) D1 routing row
npx wrangler d1 execute fromdonna-routing --remote --command \
  "SELECT gateway, gateway_user_id, user_id, status, runtime_provider, runtime_id, updated_at
   FROM user_agents WHERE user_id = 'telegram:<id>';"

# 2) E2B live harness (runtime_id from D1)
curl -sS "https://8788-<runtime_id>.e2b.dev/health"

# 3) R2 checkpoint manifest
npx wrangler r2 object get \
  "fromdonna-user-state/users/telegram:<id>/manifests/latest.json" \
  --file /tmp/man.json --remote
```

Details of pack/exclude/harvest and pause vs restore are in the sections below.

## Sandbox lifecycle

| Action | Data on the box |
|--------|------------------|
| **Create** from template | Fresh image; then Worker **restores** R2 checkpoint if one exists |
| **Pause** | Disk + memory **kept** (sleep). Not deleted. |
| **Resume** (`connect`) | Same computer continues; `~/.hermes` + workspace as left |
| **replaceRuntime** (404 / broken harness) | New VM; **restore from R2**; old id killed |
| **Delete / kill** without backup | That VM’s disk is **gone** |

### When R2 restore is needed vs not

| Event | Same disk? | R2 restore? |
|-------|------------|-------------|
| Idle pause → next message | Yes | **No** |
| connect 404 / failed resume → replace | No | **Yes** |
| Failed / stuck provision → new create | No | **Yes** if prior checkpoint |
| Template rebuild / deliberate kill | No | **Yes** if you care about continuity |

## What lives where

### Live agent home (`~/.hermes` / `$HERMES_HOME`)

Typically `/home/user/.hermes` on the sandbox:

| Path | Role |
|------|------|
| `config.yaml` | Settings / tools policy |
| `skills/` | Bundled + user/agent skills |
| `state.db` / `sessions/` | Conversation store |
| `SOUL.md`, `memories/MEMORY.md`, `memories/USER.md` | Identity + curated memory ([identity-and-memory.md](../hermes/identity-and-memory.md)) |
| `plugins/`, cron, logs, … | Other Hermes runtime state |

**Day to day:** stays on the sandbox (pause preserves it).

### Workspace

`/home/user/workspace` — agent working files (harness CWD for tools). Included in the runtime checkpoint.

### R2 runtime checkpoint (implemented — Architecture B)

**Bucket:** `fromdonna-user-state` (Worker binding `USER_STATE`).

**Layout:**

```text
users/{userId}/checkpoint.tar.gz
users/{userId}/manifests/latest.json
```

**Manifest fields:** `version`, `userId`, `savedAt`, `bytes`, `sha256`, `runtimeId`, `source`  
(`source` examples: `envd-pull`, `gateway-session`, `harness-export`)

#### What is packed

Filtered **agent-home** + **workspace**:

- Include: config, skills, memories, `state.db` (via SQLite backup API), sessions, SOUL, plugins, etc.
- Exclude: `.env`, `auth.json`, caches, venvs, `node_modules`, PIDs, WAL/SHM, staged checkpoint files themselves, `/opt/fromdonna`

#### How backup runs (not sandbox → Worker POST)

Sandbox **outbound POST** to `*.workers.dev` is often blocked by Cloudflare **error 1010**. Live path:

```text
Agent session finishes
  → harness stages tar on disk
      ~/.hermes/fromdonna-checkpoint-latest.tar.gz
      ~/.hermes/fromdonna-checkpoint-ready.json
  → Worker harvests (async, separate waitUntil):
      1) GET harness /internal/checkpoint/export
      2) fallback: E2B envd GET /files (staged tar)
  → R2 put + manifest
```

Also pulled:

- At the **start of the next message** (safety net)
- **Before replace/kill** when the old box is still reachable

#### How restore runs

On **provision** and **replaceRuntime**, after harness `/bootstrap`:

```text
Worker GET R2 checkpoint (if any)
  → POST harness /internal/restore  (gzip body)
  → extract into ~/.hermes + workspace
  → mark D1 ready
```

| Situation | Action |
|-----------|--------|
| Normal use / pause / unpause | **No R2 required** — disk stays |
| After agent use | Stage → Worker **pull** → R2 (async; may land shortly after the reply) |
| Create / replaceRuntime | Worker **restore** from R2 if present |

### Product files (tools → R2)

Separate from the runtime checkpoint: durable docs/exports may later use agent tools → Worker → R2 (`r2://` descriptors already exist in harness). The agent must not hold long-lived R2 credentials.

### Outside the sandbox (always)

- Channel bot tokens  
- OAuth / product secrets  

- Billing, identity, `user_id ↔ runtime_id`  

## Mental model

```
                    ┌──────────────────────────────┐
                    │  Worker / D1                 │
                    │  identity, secrets, routing  │
                    │  R2 checkpoint put + restore │
                    └───────────┬──────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                                   ▼
     ┌─────────────────┐                 ┌─────────────────┐
     │  E2B (this user)│                 │  R2 (this user) │
     │  Hermes live    │  stage + pull   │  checkpoint.tar │
     │  ~/.hermes      │ ───────────────►│  + manifest     │
     │  workspace      │                 │                 │
     │  pause = keep   │ ◄── restore ─── │  on new runtime │
     └─────────────────┘                 └─────────────────┘
```

## Ops checks

```bash
# Manifest for a user (Worker secret)
curl -sS -H "Authorization: Bearer $WORKER_TO_HARNESS_SECRET" \
  "https://fromdonna-gateway.code-df4.workers.dev/internal/checkpoint/status?userId=telegram:<id>"

# Or via wrangler
npx wrangler r2 object get \
  "fromdonna-user-state/users/telegram:<id>/manifests/latest.json" \
  --file /tmp/man.json --remote
```

## One-line summary

**Pause keeps the live brain on the box; Architecture B stages after agent use and the Worker pulls into R2 so a missing or replaced E2B can restore agent-home + workspace — channel-agnostic, no secrets in the archive.**
