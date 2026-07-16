# Nango

Custom integrations, actions, and config for **Nango** (OAuth + owned tool layer).

## Intent

- Multi-user connections and tokens live in **Nango**, not in E2B.
- Worker calls Nango with `user_id` / connection ids; sandboxes never hold the Nango secret.
- Put custom integration scripts, openapi defs, and deploy notes here as you build them.

## Production deployment

Self-hosted free edition on Lightsail **nango-server** (`Ubuntu-3`).

| | |
|--|--|
| **URL** | https://nango.fromdonna.com |
| **OAuth callback** | `https://nango.fromdonna.com/oauth/callback` |
| **Host** | `18.136.11.230` (static) |
| **SSH** | `ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230` |
| **Private key** | `nango/keys/lightsail-Ubuntu-3-key.pem` (Lightsail key pair `Ubuntu-3-key`) |
| **App dir** | `/home/ubuntu/nango` |
| **Tunnel** | Cloudflare tunnel `nango` → local `:3003` |
| **Dashboard creds** | On server: `/home/ubuntu/nango/CREDENTIALS.txt` |

Stack: Docker Compose (`nango-server`, Postgres 16, Redis 7). See root `AGENTS.md` for ops commands.

### SSH key

Private key for this host is stored in the repo:

```
nango/keys/lightsail-Ubuntu-3-key.pem
```

```bash
chmod 600 nango/keys/lightsail-Ubuntu-3-key.pem
ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230
```

### Update Nango

```bash
ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230
cd ~/nango
sudo docker compose stop
sudo docker compose rm -f
sudo docker compose pull
sudo docker compose --env-file .env up -d
```

## Related

- `documentation/tooling/general.md` — Nango vs CLI vs MCP vs API
- `cloudflare/` — Worker proxy that will call Nango
- `E2B-Template/` — agent image (no Nango project secrets)
- `AGENTS.md` — full Lightsail / tunnel inventory
