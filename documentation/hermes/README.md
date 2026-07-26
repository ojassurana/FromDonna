# Hermes (agent runtime notes)

Product-facing notes on how the **in-sandbox Hermes agent** behaves — files under `~/.hermes`, prompt assembly, memory tools. Gateway/Worker routing lives under [../gateway/](../gateway/).

| Doc | Contents |
|-----|----------|
| [identity-and-memory.md](./identity-and-memory.md) | **SOUL / MEMORY / USER** — prompt order, freeze policy, **current FromDonna template flags** (`memory_enabled: false`, skill nudge on) |
| [../Hermes Understanding/README.md](../Hermes%20Understanding/README.md) | **Instructions map** — sequential system-seed layers + hard-coded/example text |
| [../deployment/e2b-template.md](../deployment/e2b-template.md) | Baked image + Hermes agent defaults table |

### Current product defaults (template)

- **SOUL:** explicit Donna identity (`You are Donna.`).
- **Built-in memory tool:** off (`memory.memory_enabled: false`, `user_profile_enabled: false`).
- **Post-turn memory review:** off (`memory.nudge_interval: 0`).
- **Post-turn skill review:** on (`skills.creation_nudge_interval: 10`).
- **MEMORY seed:** short connect-apps pointer only (no harness re-assert).
