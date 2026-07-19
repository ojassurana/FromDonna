# Delete user data (FromDonna)

Canonical ops protocol when Ojas says **delete all user data** / **wipe users** / **delete each user**.

## Intent

Remove **user-generated data** so brains, OAuth sticky state, and turn traces cannot come back.  
Do **not** destroy the D1 database resource, Workers, templates, or unrelated R2 buckets.

## What is “user data”

| Layer | What | Why |
|-------|------|-----|
| E2B sandboxes | Live `~/.hermes` + workspace | Active brain |
| R2 `fromdonna-user-state` | `users/{userId}/checkpoint.tar.gz` + `manifests/latest.json` | Next provision **restores** old brain if left |
| D1 `user_composio` | Sticky Composio session + toolkits | OAuth / MCP session binding |
| D1 `user_agents` | Routing (user → runtime) | Optional; clear on full wipe so next DM is a fresh claim |
| D1 `message_turns` | Per-message turn rows (gateway turn_trace) | User-linked traffic history |
| D1 `message_turn_events` | Stage events for each turn | Child of `message_turns` (FK) |

**One shared R2 bucket**, per-user **prefixes** — not one bucket per user.

**Current D1 user-related tables (full wipe must hit all):** `user_agents`, `user_composio`, `message_turns`, `message_turn_events`.

## Never touch

- D1 resource/schema (`wrangler d1 delete` / drop DB)
- Other R2 buckets (`file-bromux-files`, `myself`, …)
- Workers, secrets, E2B template `fromdonna-hermes`
- Non-FromDonna sandboxes

## Order (FK-safe)

1. Double-confirm targets with Ojas (all users vs one `telegram:<id>`).
2. Kill FromDonna E2B sandboxes (running + paused).
3. Delete R2 keys under `users/` (or `users/{userId}/` for one user).
4. `DELETE FROM message_turn_events` (child of turns — delete first).
5. `DELETE FROM message_turns`.
6. `DELETE FROM user_composio` (child of routing — delete before `user_agents`).
7. `DELETE FROM user_agents` (if clearing routes — default for full wipe).
8. Verify each layer empty for the targets.

**Pitfalls:**

- `DELETE FROM user_agents` alone → `FOREIGN KEY constraint failed` while `user_composio` rows remain.
- `DELETE FROM message_turns` alone → FK fail while `message_turn_events` rows remain (delete events first).

## Commands (this host)

```bash
set -a
source <(grep -E '^(CLOUDFLARE_EMAIL|CLOUDFLARE_GLOBAL_API_KEY|CLOUDFLARE_ACCOUNT_ID)=' ~/.hermes/.env)
set +a
export CLOUDFLARE_API_KEY="$CLOUDFLARE_GLOBAL_API_KEY"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-df4acced87263715777b0c2068d03b22}"
export PATH="$HOME/.hermes/node/bin:$PATH"

# 1) Kill FromDonna sandboxes
e2b sandbox list --format json -l 0
e2b sandbox list -s paused --format json -l 0
# Kill when metadata.fromdonna_user_id is set
e2b sandbox kill <sandboxId>

# 2) R2 user checkpoints (all users)
cd ~/FromDonna/cloudflare/gateway
# list then:
npx wrangler r2 object delete "fromdonna-user-state/users/<userId>/checkpoint.tar.gz" --remote
npx wrangler r2 object delete "fromdonna-user-state/users/<userId>/manifests/latest.json" --remote

# 3) D1 — full wipe (FK order: events → turns → composio → agents)
npx wrangler d1 execute fromdonna-routing --remote --command \
  "DELETE FROM message_turn_events;
   DELETE FROM message_turns;
   DELETE FROM user_composio;
   DELETE FROM user_agents;"

# Single user:
# user_id = telegram:<tgId>
npx wrangler d1 execute fromdonna-routing --remote --command \
  "DELETE FROM message_turn_events WHERE turn_id IN (
     SELECT turn_id FROM message_turns WHERE user_id = 'telegram:<tgId>'
   );
   DELETE FROM message_turns WHERE user_id = 'telegram:<tgId>';
   DELETE FROM user_composio WHERE user_id = 'telegram:<tgId>';
   DELETE FROM user_agents WHERE user_id = 'telegram:<tgId>';"

# 4) Verify
npx wrangler d1 execute fromdonna-routing --remote --command \
  "SELECT
     (SELECT COUNT(*) FROM user_agents) a,
     (SELECT COUNT(*) FROM user_composio) c,
     (SELECT COUNT(*) FROM message_turns) t,
     (SELECT COUNT(*) FROM message_turn_events) e;"
e2b sandbox list --format json -l 0
# R2 prefix users/ should be empty for wiped users
```

## After wipe

Next DM → fresh provision. Provision / replaceRuntime **hard-require** Composio ready (`composio_mcp_ready: true`); per-message inject remains soft-fail — see [composio.md](../tooling/composio.md) §8 and [ops.md](./ops.md).

If “Something went wrong” or first provision never becomes ready:

1. Check D1 `status` + whether sandbox still exists  
2. Probe composio-proxy mint — **401 means secret mismatch**, not stale session (`COMPOSIO_SESSION_SECRET` aligned on gateway + proxy; avoid mismatched `INTERNAL_AUTH_SECRET`)  
3. Prefer clear failed row + retry once secrets fixed — see `ops.md` and skill `references/wipe-and-reprovision-ops.md`

## Single-user vs all

| Phrase | Scope |
|--------|--------|
| delete all user data / wipe users | All FromDonna sandboxes + all `users/*` R2 + all D1 user rows (`user_agents`, `user_composio`, `message_turns`, `message_turn_events`) |
| delete user `telegram:…` / this user | That user only (same layers) |
| delete the sandbox | Sandbox only (leave D1/R2 unless also asked) |
| delete the D1 | Clear routing/ops user rows on `fromdonna-routing` only — **never** destroy DB |
