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

- Live brain for each Telegram user is **that sandbox’s** `~/.hermes` (see [../deployment/memorymanagement.md](../deployment/memorymanagement.md)).
- Template seeds **Donna** identity via `E2B-Template/config/hermes/SOUL.md` → image `/home/user/.hermes/SOUL.md` (see [../deployment/e2b-template.md](../deployment/e2b-template.md)). Hermes does not overwrite an existing SOUL after first use.
- Per-user memories (`MEMORY.md` / `USER.md`) grow after first use.
- Template upgrade / sandbox kill requires restore of `~/.hermes` if you want the same identity and memory.

---

## Related

| Doc | Contents |
|-----|----------|
| [../deployment/memorymanagement.md](../deployment/memorymanagement.md) | Sandbox vs R2 vs `~/.hermes` lifecycle |
| [../deployment/e2b-template.md](../deployment/e2b-template.md) | What is baked into the image vs live home |
| Upstream Hermes | `website/docs/developer-guide/prompt-assembly.md`, `guides/use-soul-with-hermes.md` |
