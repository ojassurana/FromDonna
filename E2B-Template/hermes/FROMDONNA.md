# FromDonna Hermes pin

Vendored from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) for the E2B sandbox image and harness work.

- **Upstream commit (shallow clone):** `79c08064568665251dac93b79b2247082b0510ee`
- **Cloned:** 2026-07-12T08:01:38Z
- **Role:** modify here; `E2B-Template/template.ts` installs this tree into the image.
- **Do not** put product channel/Nango secrets in this tree for multi-user deploys.

When merging upstream later: re-clone or fetch upstream and re-apply FromDonna patches, or convert this directory to a proper git remote/fork.

---

## FromDonna product rebrand (model-facing only)

Users and the model must never be told they are on “Hermes.” Runtime contracts stay Hermes-shaped so the engine keeps working.

### Do not rename (contracts)

| Contract | Why |
|----------|-----|
| `HERMES_HOME`, `HERMES_*` env | Engine reads these names |
| `~/.hermes` paths | Default agent home + checkpoints |
| Toolset ids `hermes-cli`, `hermes-api-server` | Registry names |
| YAML key `metadata.hermes` | Skill frontmatter schema |
| Package / CLI / imports (`hermes_cli`, `bin/hermes`, …) | Install surface |
| Template tags `fromdonna-hermes(-dev)` | E2B + gateway wiring |

### Pin patches to re-apply on upstream merge

1. **System seed / guidance** (`agent/prompt_builder.py`, `agent/system_prompt.py`, plus other model-injected strings under `agent/`):
   - Identity fallback → Donna
   - Self-help guidance → `donna-agent` skill (not `hermes-agent` / Nous docs)
   - Platform / env / skills preamble: no “Hermes” product brand
   - Active profile lines: “Active agent profile…”

2. **Skills**
   - `skills/autonomous-ai-agents/donna-agent/` (was `hermes-agent`) — product guide only
   - `skills/software-development/skill-authoring/` (was `hermes-agent-skill-authoring`)
   - `optional-skills/devops/s6-container-supervision/` (was `hermes-s6-container-supervision`)
   - Bulk prose sanitization of `SKILL.md` trees (authors, descriptions, body)
   - Helper: `E2B-Template/scripts/sanitize_skill_hermes_brand.py` (re-run after skill pulls)

3. **Default SOUL seeds** in pin (if present): Donna identity — product SOUL is also baked via `config/hermes/SOUL.md` → `~/.hermes/SOUL.md`

### Intentional remaining “Hermes”

- Operator comments / docstrings / logger lines
- Env, paths, module names (`HERMES_HOME`, `hermes_tools`, `hermes-cli`)
- Optional **godmode** skill mentions of the **Nous Hermes model family** (actual model IDs, not agent product)
- HTTP User-Agent headers (network identity, not chat)

### Tool-schema brand scrub (follow-up)

Always-on and common tool schemas / tool results reworded so model-facing
text says **agent** / **Donna** rather than product Hermes:

- `tools/file_tools.py`, `session_search_tool.py`, `code_execution_tool.py`
- `tools/terminal_tool.py`, `web_tools.py`, desktop terminal tools
- Mid-turn: `conversation_loop.py`, `thinking_timeout_guidance.py`,
  `background_review.py`, `context_references.py`
- Conditional media/MCP/skill-manager error strings as found

**Still not zero:** developer docstrings, CLI binary name in some rare
operator paths, and filesystem path tokens (`.hermes` / `~/.hermes`).
