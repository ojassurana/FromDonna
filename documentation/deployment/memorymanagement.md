# Memory & file management

How a user’s data is stored across **E2B sandboxes**, **`~/.hermes`**, and **R2**.

## Big picture

```
User (years)
  ├── Account / routing          → Worker DB (user_id → sandbox_id)
  ├── Secrets / OAuth            → Worker + Nango (never long-lived in E2B)
  ├── Product files & artifacts  → R2  (per-user prefix)
  └── Live Hermes agent brain    → that user’s E2B sandbox: ~/.hermes
```

- **Sandbox** = that user’s current computer (Hermes runs here).
- **R2** = durable place for files the product cares about day to day.
- **`~/.hermes`** = live Hermes personalization (skills, memory, config, sessions).

## Sandbox lifecycle

| Action | What happens to data on the box |
|--------|----------------------------------|
| **Create** from template | Fresh machine; Hermes installed base image; empty/new user brain until restore |
| **Pause** | Disk + memory **kept** (sleep). Not deleted. |
| **Resume** | Same computer continues; `~/.hermes` as they left it |
| **Delete / kill** | That VM’s disk is **gone** (unless you backed up) |
| **New sandbox** (rebuild) | New computer; restore `~/.hermes` if you want the same agent brain |

### Per-user allocation

- Product model: **one primary sandbox per user** for as long as practical.
- DB maps `user_id → sandbox_id` (update if you ever recreate).
- E2B is not free immortal hosting forever — pause while active; recreate when you must (limits, template upgrade, cost). Customer lifetime ≠ “never delete this VM no matter what,” but **prefer** the same sandbox when you can.

### Template vs pause snapshot

| Kind | Meaning |
|------|---------|
| **Template snapshot** | Shared base image (Hermes + deps). **No** one user’s personal data. Built once, used for creates. |
| **Paused sandbox** | **That user’s** machine frozen at pause time (their files + `~/.hermes` + processes). |

## What lives where

### R2 (day-to-day product data)

Store **here** under a per-user prefix, e.g. `users/{userId}/…`:

- Docs, exports, images, downloads  
- Deliverables the agent or user “created as product files”  
- Anything that must survive sandbox death without a special restore step  

Access pattern: agent calls **tools** → Worker (capability + `userId`) → R2.  
The agent does not hold raw R2 credentials.

### `~/.hermes` on the sandbox (live agent brain)

Hermes’s own state on the box (or `$HERMES_HOME` if set), typically:

| Path (under `~/.hermes`) | Role |
|--------------------------|------|
| `config.yaml` | Settings / tools policy |
| `skills/` | Installed and agent-written skills |
| `state.db` / sessions | Conversation store |
| Memory / user profile files | Cross-session memory |
| cron, plugins, etc. | Other Hermes runtime state |

**Day to day:** this stays **on the sandbox** (pause/resume preserves it).

**Not** continuously mirrored to R2 unless you add a backup job.

### Outside both (never “only on the sandbox”)

- Telegram/WhatsApp tokens  
- Nango OAuth / API product keys  
- Billing, identity, `user_id ↔ sandbox_id`  

These live on **Worker** (and Nango), not as the only copy inside E2B.

### Other paths on the sandbox

If Hermes writes project files under e.g. `~/workspace` and you **don’t** send them through R2 tools, those are **only on that VM** until you back them up. Prefer R2 tools for anything product-durable.

## Rebuild / template upgrade (move `~/.hermes` only when needed)

If you **don’t** upgrade the template and never delete the sandbox:

- User keeps the same box; **no** `~/.hermes` transfer required.

When you **must** replace the computer (new template, forced delete, etc.):

```
1. Build new template (optional — new Hermes/base)
2. Create new sandbox from template
3. Restore ~/.hermes from old sandbox or from R2 backup
4. Update user_id → new sandbox_id
5. Delete old sandbox
```

Assuming product files already live on R2: **transferring `~/.hermes` is enough** for the agent brain.

### When `~/.hermes` touches R2

| Situation | Action |
|-----------|--------|
| Normal use | **No** — brain stays on sandbox |
| Backup (optional / scheduled) | Copy `~/.hermes` → R2 |
| Rebuild / disaster restore | R2 (or live old box) → new sandbox `~/.hermes` |

So: **R2 is ongoing storage for user files.**  
**`~/.hermes` is copied to/from R2 only for backup or transfer**, not as the live primary path every turn (unless you later build a full remote FS).

## Mental model (one page)

```
                    ┌─────────────────────────┐
                    │  Worker / Nango / DB    │
                    │  identity, secrets,     │
                    │  user → sandbox_id      │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                                   ▼
     ┌─────────────────┐                 ┌─────────────────┐
     │  E2B (this user)│                 │  R2 (this user) │
     │  Hermes process │                 │  files/artifacts│
     │  ~/.hermes live │                 │  via tools      │
     │  pause = keep   │                 │  durable        │
     └─────────────────┘                 └─────────────────┘
              │
              │ only on rebuild/backup
              └──────────► optional ~/.hermes archive on R2
```

## One-line summary

**R2 holds ongoing user files; the sandbox holds the live Hermes brain (`~/.hermes`); pause keeps that brain in place; you move or backup `~/.hermes` only when replacing or protecting the machine.**
