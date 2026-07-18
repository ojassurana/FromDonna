# fromdonna-ops-dashboard

Standalone Cloudflare Worker for **per-message turn flow** (ops only).

- **Writes:** `fromdonna-gateway` → D1 `message_turns` / `message_turn_events`
- **Reads/UI:** this Worker
- **Auth:** off for now (open read). Re-enable before sharing publicly.

```bash
cd cloudflare/ops-dashboard
npm install
npx wrangler deploy
# open https://fromdonna-ops-dashboard.<account>.workers.dev/
```

Do not put Telegram tokens, E2B keys, or product traffic on this Worker.
