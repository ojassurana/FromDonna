# How Hermes `instructions` are built

Sequential structure of the Responses API **`instructions`** field (the system seed).

Source of truth for this map: Chitti live first-API-request dump
([hermes-first-api-request explainer](https://chitti-explainers.pages.dev/hermes-first-api-request/)),
cross-checked against Hermes assembly in `agent/system_prompt.py` + `agent/prompt_builder.py`.

Chunks are joined with blank lines (`\n\n`). Built-in blocks are linked to the
**hard-coded** text; host/session-specific blocks are linked to **examples** from that dump.

| Badge | Meaning |
|-------|---------|
| **hard-coded** | Fixed string in Hermes source |
| **example** | Live Chitti content (changes per host/session) |

---

## Sequence

1. [`SOUL.md` identity](./instruction%20examples/01-soul-md.md) · example  
   *(or hard-coded `DEFAULT_AGENT_IDENTITY` if SOUL is missing — see same page)*

2. [Hermes self-help pointer](./instruction%20examples/02-hermes-agent-help-guidance.md) · hard-coded

3. [Finishing the job](./instruction%20examples/03-finishing-the-job.md) · hard-coded

4. [Parallel tool calls](./instruction%20examples/04-parallel-tool-calls.md) · hard-coded

5. [Memory + session_search + skill_manage guidance](./instruction%20examples/05-memory-session-skills-guidance.md) · hard-coded

6. [Mid-turn user steering](./instruction%20examples/06-mid-turn-user-steering.md) · hard-coded

7. [Tool-use enforcement](./instruction%20examples/07-tool-use-enforcement.md) · hard-coded

8. [Execution discipline](./instruction%20examples/08-execution-discipline.md) · hard-coded *(Grok / GPT family)*

9. [Skills (mandatory) preamble](./instruction%20examples/09-skills-preamble.md) · hard-coded

10. [Skills catalog `<available_skills>`](./instruction%20examples/10-skills-catalog.md) · example *(generated list; wrapper hard-coded)*

11. [Host / environment hints](./instruction%20examples/11-host-environment.md) · example *(probed)*

12. [Python toolchain probe](./instruction%20examples/12-python-toolchain.md) · example *(probed)*

13. [Active Hermes profile](./instruction%20examples/13-active-profile.md) · hard-coded

14. [Platform hint — Telegram](./instruction%20examples/14-platform-telegram.md) · hard-coded

15. [MEMORY snapshot](./instruction%20examples/15-memory-snapshot.md) · example

16. [USER profile snapshot](./instruction%20examples/16-user-profile.md) · example

17. [Conversation started / Model / Provider](./instruction%20examples/17-session-meta.md) · example *(template hard-coded)*

18. [Current Session Context](./instruction%20examples/18-current-session-context.md) · example *(gateway ephemeral)*

---

## Not present in the Chitti first-request dump

These slots exist in the assembler but were empty for that Telegram probe:

- Caller `system_message` override  
- Project context (`.hermes.md` / `AGENTS.md` / `CLAUDE.md` / `.cursorrules`)  
- Computer-use multi-paragraph block (only if that tool is loaded)  
- External memory provider (e.g. Honcho)  
- Coding-posture blocks  
- Alibaba model-id workaround  

---

## Notes

- Within a session, this string is **cached** and re-sent as `instructions` each API call (plus tools / growing `input`).  
- Rebuild happens on new session or context compaction.  
- Full raw dump used for examples: `artifacts/html-explainers/publish/hermes-first-api-request/full-instructions.txt`.
