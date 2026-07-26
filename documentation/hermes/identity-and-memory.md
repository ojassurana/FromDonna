# Hermes identity & memory files

How Hermes uses **`SOUL.md`**, **`MEMORY.md`**, and **`USER.md`** under the agent home (`~/.hermes` / `$HERMES_HOME` on each FromDonna sandbox). Skills and session DB are out of scope here except where they contrast.

Upstream detail: Hermes `agent/prompt_builder.py`, `agent/system_prompt.py`, `tools/memory_tool.py`, and docs under `E2B-Template/hermes/website/docs/developer-guide/prompt-assembly.md`.

---

## Files at a glance

| File | Path | Role |
|------|------|------|
| **SOUL.md** | `$HERMES_HOME/SOUL.md` | Agent **identity / persona** — who Hermes is and how it speaks |
| **MEMORY.md** | `$HERMES_HOME/memories/MEMORY.md` | Agent **notes** — durable facts about environment, conventions, lessons |
| **USER.md** | `$HERMES_HOME/memories/USER.md` | **User profile** — name, preferences, communication style, habits |

In FromDonna, `$HERMES_HOME` is typically `/home/user/.hermes` on that user’s E2B sandbox (pause keeps the tree; delete sandbox loses it unless backed up).

---

## What is injected into each session (prompt order)

Hermes assembles the system prompt roughly as **stable → context → volatile**:

| Order | Layer | Identity / memory content |
|-------|--------|---------------------------|
| **1 (very start)** | Stable — identity | **`SOUL.md`** (or built-in default if missing/empty) |
| … | Stable — tools, skills index, env/platform hints | (not these files) |
| … | Context — project rules | e.g. `AGENTS.md` / `CLAUDE.md` / `.cursorrules` in **project cwd** (not SOUL) |
| **Later** | Volatile — memory snapshot | **`MEMORY.md`** |
| **Later** | Volatile — user profile snapshot | **`USER.md`** |
| … | Ephemeral | timestamp / session / model line |

### Direct answers

- **`SOUL.md` is placed at the start of the system prompt for every session** (identity slot #1).
- **`MEMORY.md` and `USER.md` are not at the very start.** They are injected **later** as frozen snapshots in the volatile tier.
- Mid-session, those snapshots in the prompt stay **read-only** for the rest of the session even if the agent edits the files on disk.

```text
Session start
  ┌─────────────────────────────────────┐
  │ 1. SOUL.md          (identity top)  │
  │ 2. tools / skills / …               │
  │ 3. project AGENTS.md (if any)       │
  │ 4. MEMORY.md snapshot               │
  │ 5. USER.md snapshot                 │
  └─────────────────────────────────────┘
         frozen for this session
```

---

## Update policies

| File | Who updates | How | When prompt sees it |
|------|-------------|-----|---------------------|
| **SOUL.md** | Human / product (seed on first run if absent) | Edit the file. **Not** the `memory` tool. Hermes does **not** overwrite an existing SOUL. | Next session load (identity block). Empty/missing → default identity. |
| **MEMORY.md** | Agent (primary) via **`memory` tool** | `target: "memory"`, actions `add` / `replace` / `remove` (or batch `operations`) | **Disk** immediately; **prompt** only on **next session** |
| **USER.md** | Agent (primary) via **`memory` tool** | `target: "user"`, same actions | Same frozen-snapshot policy as MEMORY |

### The `memory` tool (only official tool for MEMORY / USER)

- Implementation: `tools/memory_tool.py`, toolset `memory`, name **`memory`**.
- Targets: `"memory"` → `memories/MEMORY.md`; `"user"` → `memories/USER.md`.
- Entries delimited by `§`; char budgets ~**2200** (MEMORY) / ~**1375** (USER) by default; consolidation when full.
- Writes are durable on disk; system-prompt snapshot is intentionally **not** rewritten mid-session (prefix-cache stability).

### What does **not** own these files

| Path / mechanism | Note |
|------------------|------|
| Generic file/shell tools | Could touch SOUL if allowed; not the designed API. Hermes treats “edit SOUL.md” style content as high-risk in scanners. |
| Skill manager / `skills/` | Procedural skills — different store from MEMORY/USER. |
| Session DB / `sessions/` | Conversation history — not curated memory files. |
| External memory providers (Honcho, mem0, …) | Optional plugins with their own tools; built-in MEMORY/USER still use `memory`. |

---

## SOUL vs MEMORY vs USER vs AGENTS

| Concern | Put it in |
|---------|-----------|
| Tone, personality, standing behavior everywhere | **SOUL.md** |
| Durable agent notes (env, tool quirks, lessons) | **MEMORY.md** via `memory` |
| Durable facts about the human user | **USER.md** via `memory` |
| Repo-specific conventions, ports, workflows | **AGENTS.md** (project cwd), not SOUL |

---

## FromDonna product notes

Live brain for each user is **that sandbox’s** `~/.hermes` (see [../deployment/memorymanagement.md](../deployment/memorymanagement.md)). Template upgrade / sandbox kill / `replaceRuntime`: Worker restores the R2 **runtime checkpoint** when one exists — Architecture B (not needed for ordinary pause/unpause).

### Current template policy (`E2B-Template/config/hermes/`)

| File / key | Product default | Notes |
|------------|-----------------|--------|
| **SOUL.md** | Seeded Donna persona | Starts with explicit **`You are Donna.`** Persona-only — no Composio/OAuth runbooks. Path: `config/hermes/SOUL.md` → image `~/.hermes/SOUL.md`. Hermes does not overwrite an existing SOUL after first use. |
| **MEMORY.md** | Compact product seed only | Single connect-apps pointer (Nous-style short note). Full OAuth procedure lives in skill `connect-apps`, not MEMORY. |
| **USER.md** | Not seeded | File is created only if something writes it. |
| `memory.memory_enabled` | **`false`** | Built-in `memory` tool **off** — agent does not add/replace/remove MEMORY/USER via Hermes memory. |
| `memory.user_profile_enabled` | **`false`** | User-profile store off with memory. |
| `memory.nudge_interval` | **`0`** | Post-turn **memory** background review (self-improvement fork) **never** spawns. |
| `skills.creation_nudge_interval` | **`10`** | Post-turn **skill** self-improvement review still on (Hermes default cadence). |
| `display.memory_notifications` | **`off`** | No `💾 Self-improvement review: …` chat notices (skill review may still run quietly). |

Source of truth: `E2B-Template/config/hermes/config.yaml` + `SOUL.md` + `memories/MEMORY.md`. After changing these, rebuild the template (`cd E2B-Template && npm run build:prod`). Existing sandboxes keep old home until recreated; R2 restore can bring back older SOUL/MEMORY.

### What we removed

- **`harness/product_memory.py`** — previously re-asserted the connect-apps MEMORY line on `/bootstrap` and after R2 restore. **Deleted.** MEMORY seed is template-bake only; if the agent (or restore) drops it, nothing re-glues it.

### Security note (not yet product-locked)

Hermes soft-scans “edit SOUL/config” intent; there is **no** root-only file lock on SOUL/config/MEMORY in the image today. Disabling `memory_enabled` turns off the official memory tool path; shell/`write_file` can still touch disk unless further denied.

---

## Related

| Doc | Contents |
|-----|----------|
| [../deployment/memorymanagement.md](../deployment/memorymanagement.md) | Sandbox vs R2 vs `~/.hermes` lifecycle |
| [../deployment/e2b-template.md](../deployment/e2b-template.md) | What is baked into the image vs live home; Hermes config defaults |
| Upstream Hermes | `website/docs/developer-guide/prompt-assembly.md`, `guides/use-soul-with-hermes.md` |
