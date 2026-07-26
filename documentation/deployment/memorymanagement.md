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
| Idle → next message | Lookup `runtime_id`; bump `activity_epoch` on inject | Resume / `connect` same sandbox | Unchanged (no restore) |
| After agent session | Unchanged (epoch already bumped) | Stage tar (`packing` → `ready`/`failed`); Worker harvest; **1 min quiet → pause** | Worker harvest → put objects (best-effort) |
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
| **Pause** (primary: post-turn) | After harvest attempt + **~60s quiet** with no newer inject → Worker `POST …/pause` (disk + memory kept). E2B `autoPause` + 1h TTL remains a **safety net** only. |
| **Resume** (`connect`) | Same computer continues; `~/.hermes` + workspace as left |
| **replaceRuntime** (404 / broken harness) | New VM; **restore from R2**; old id killed |
| **Delete / kill** without backup | That VM’s disk is **gone** |

### Post-turn order (live)

```text
Inject returns (agent may still be running in-sandbox)
  → Worker waitUntil starts harvest poll
Agent session finishes
  → harness stages checkpoint (packing → ready | failed)
  → Worker sees turn-scoped terminal stage → export to R2 (if USER_STATE bound)
  → wait ~60s quiet (cancel if activity_epoch bumped by a new message)
  → Worker pauses E2B sandbox
```

**Safety invariants (do not relax):**

| Rule | Why |
|------|-----|
| `ready` requires ready **marker** (not leftover tar) | Prevents harvesting a previous turn and pausing mid-session |
| Export **consumes** ready + tar | Next turn cannot see false ready |
| Stale `failed` ignored until packing (or failedAt after harvest start) | Prior pack failure must not abort this turn’s harvest |
| Pause only if `safeToPause` (terminal pack this turn) | Never pause while status stayed idle for the whole window (agent may still run) |
| Harvest budget ≥ ~16 min | Covers harness session wait (900s) + pack |

| Control | Role |
|---------|------|
| `activity_epoch` (D1 `user_agents`) | Bumped on every inject; scheduled pause skips if epoch changed |
| `POST_TURN_QUIET_MS` (60s) | Quiet window after **terminal pack** before pause |
| `timeout: 3600` + `autoPause: true` | Safety net if pause path never runs (e.g. harvest timeout while agent still busy) |

### When R2 restore is needed vs not

| Event | Same disk? | R2 restore? |
|-------|------------|-------------|
| Post-turn pause → next message | Yes | **No** |
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
| `SOUL.md`, `memories/MEMORY.md`, `memories/USER.md` | Identity + curated memory files on disk. **Product config currently has Hermes `memory_enabled: false`** (tool off; skill nudge may still run). See [identity-and-memory.md](../hermes/identity-and-memory.md). |
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

Sandbox **outbound POST** to `*.workers.dev` is often blocked by Cloudflare **error 1010**. Live path is a **stage handshake + Worker pull**:

```text
Agent session finishes
  → harness marks packing, then packs:
      ~/.hermes/fromdonna-checkpoint-packing.json   (in progress)
      ~/.hermes/fromdonna-checkpoint-latest.tar.gz
      ~/.hermes/fromdonna-checkpoint-ready.json     (success)
      — or —
      ~/.hermes/fromdonna-checkpoint-failed.json    (pack error; harvest stops early)
  → Worker (async waitUntil):
      1) poll GET harness /internal/checkpoint/status  (idle|packing|ready|failed)
      2) on ready: GET /internal/checkpoint/export → R2 put + manifest
      3) fallback: E2B envd file read if status path is down
      4) then post-turn quiet + pause (see lifecycle above)
```

Turn-trace stages: `checkpoint.harvest` (`ok` + `reason`: harvested | pack_failed | timeout | …), then `sandbox.pause`.

Also pulled (safety nets):

- At the **start of the next message** on **cold** path (warm path defers)
- **Before replace/kill** when the old box is still reachable

Harvest is **best-effort**: soft-fail does not block chat; next turn / replace may still recover from an older R2 object or live disk.

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
| After agent use | Stage handshake → Worker **pull** → R2 → 1 min quiet → pause |
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
