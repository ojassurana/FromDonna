# 17 · Conversation started / Model / Provider

**Type:** example (from Chitti live dump 2026-07-19 — not fixed in source)

**Template hard-coded** in `agent/system_prompt.py`:
`Conversation started: {weekday, month day, year}` + optional Session ID + Model + Provider.

Values are session-specific (example from Chitti dump). Date-only for cache stability.

---

```text
Conversation started: Sunday, July 19, 2026
Model: grok-4.5
Provider: xai-oauth
```
