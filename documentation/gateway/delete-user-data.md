# Delete user data (FromDonna)

Canonical ops protocol when Ojas says **delete all user data** / **wipe users** / **delete each user**.

## Intent

Remove **user-generated data** so brains and OAuth sticky state cannot come back.  
Do **not** destroy the D1 database resource, Workers, templates, or unrelated R2 buckets.

## What is “user data”

| Layer | What | Why |
|-------|------|-----|
| E2B sandboxes | Live `~/.hermes` + workspace | Active brain |
| R2 `fromdonna-user-state` | `users/{userId}/checkpoint.tar.gz` + `manifests/latest.json` | Next provision **restores** old brain if left |
| D1 `user_composio` | Sticky Composio session + toolkits | OAuth / MCP session binding |
| D1 `user_agents` | Routing (user → runtime) | Optional; clear on full wipe so next DM is a fresh claim |

**One shared R2 bucket**, per-user **prefixes** — not one bucket per user.

## Never touch

- D1 resource/schema (`wrangler d1 delete` / drop DB)
- Other R2 buckets (`file-bromux-files`, `myself`, …)
- Workers, secrets, E2B template `fromdonna-hermes`
- Non-FromDonna sandboxes

## Order (FK-safe)

1. Double-confirm targets with Ojas (all users vs one `telegram:<id>`).
2. Kill FromDonna E2B sandboxes (running + paused).
3. Delete R2 keys under `users/` (or `users/{userId}/` for one user).
4. `DELETE FROM user_composio` (child first).
5. `DELETE FROM user_agents` (if clearing routes — default for full wipe).
6. Verify each layer empty for the targets.

**Pitfall:** `DELETE FROM user_agents` alone → `FOREIGN KEY constraint failed` while `user_composio` rows remain.

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

# 3) D1 — full wipe (FK order)
npx wrangler d1 execute fromdonna-routing --remote --command \
  "DELETE FROM user_composio; DELETE FROM user_agents;"

# Single user:
# user_id = telegram:<tgId>
npx wrangler d1 execute fromdonna-routing --remote --command \
  "DELETE FROM user_composio WHERE user_id = 'telegram:<tgId>';
   DELETE FROM user_agents WHERE user_id = 'telegram:<tgId>';"

# 4) Verify
npx wrangler d1 execute fromdonna-routing --remote --command \
  "SELECT (SELECT COUNT(*) FROM user_agents) a, (SELECT COUNT(*) FROM user_composio) c;"
e2b sandbox list --format json -l 0
# R2 prefix users/ should be empty for wiped users
```

## After wipe

Next DM → fresh provision. Gateway **must not** hard-fail if Composio mint is down (telegram-first).  
If “Something went wrong” returns:

1. Check D1 `status` + whether sandbox still exists  
2. Probe composio-proxy mint (`COMPOSIO_SESSION_SECRET` aligned on gateway + proxy)  
3. Prefer clear failed row + retry once secrets fixed — see `ops.md` and skill `references/wipe-and-reprovision-ops.md`

## Single-user vs all

| Phrase | Scope |
|--------|--------|
| delete all user data / wipe users | All FromDonna sandboxes + all `users/*` R2 + all D1 user rows |
| delete user `telegram:…` / this user | That user only |
| delete the sandbox | Sandbox only (leave D1/R2 unless also asked) |
| delete the D1 | Clear routing rows on `fromdonna-routing` only — **never** destroy DB |
