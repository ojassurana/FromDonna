# 13 · Active Hermes profile

**Type:** hard-coded (built into Hermes source)

**Hard-coded string** for the default profile in `agent/system_prompt.py` (non-default profiles get a variant with the profile name filled in).

---

```text
Active Hermes profile: default. Other profiles (if any) live under ~/.hermes/profiles/<name>/. Each profile has its own skills/, plugins/, cron/, and memories/ that affect a different session than this one. Do not modify another profile's skills/plugins/cron/memories unless the user explicitly directs you to.
```
