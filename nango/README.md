# Nango

Custom integrations, actions, and config for **Nango** (OAuth + owned tool layer).

## Intent

- Multi-user connections and tokens live in **Nango**, not in E2B.
- Worker calls Nango with `user_id` / connection ids; sandboxes never hold the Nango secret.
- Put custom integration scripts, openapi defs, and deploy notes here as you build them.

## Status

Empty placeholder.

## Related

- `documentation/tooling/general.md` — Nango vs CLI vs MCP vs API
- `cloudflare/` — Worker proxy that will call Nango
- `E2B-Template/` — agent image (no Nango project secrets)
