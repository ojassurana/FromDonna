# FromDonna — Agent Notes

## API connectors (api-proxy)

When adding or changing a **plain HTTP API** connector (product API key; not channel bots, not LLM inference):

1. **Put the real key only on `fromdonna-api-proxy`** (`cloudflare/api-proxy/`). Never on gateway, llm-proxy, E2B template, or git.
2. **Sandbox** gets a placeholder (`STUB` today) + public base URL to api-proxy; reverse-proxy by swapping auth (prefer official SDK + `base_url` when available).
3. **Routes:** `POST /v1/<vendor>/…` on api-proxy with an explicit path allowlist.
4. **Auth:** stub for now; leave a TODO for real capability HMAC (same family as LLM proxy) — do not invent a third model.
5. Wire template/harness env + agent config if the tool must be on by default; **rebuild E2B template** after sandbox-facing changes.
6. Full checklist: [documentation/tooling/api-proxy-worker.md](./documentation/tooling/api-proxy-worker.md) (section *Protocol: adding another API connector*). Connector buckets overview: [documentation/tooling/general.md](./documentation/tooling/general.md).

**Live Exa:** sandbox `web.backend: exa`, `EXA_API_KEY=STUB`, `EXA_BASE_URL=https://fromdonna-api-proxy.code-df4.workers.dev/v1/exa`.

**Not this bucket:** channel tokens → gateway; model credentials → llm-proxy; OAuth multi-user apps → Nango pattern in tooling docs.

## AWS CLI (this server)

- AWS CLI is installed; config lives in `~/.aws/`.
- Only one named profile exists: **`default`**.
  - Identity: `arn:aws:iam::042989515334:user/Chitti` (account `042989515334`).
  - Default region in config: `us-east-1`.
- List profiles: `aws configure list-profiles`
- Confirm identity: `aws sts get-caller-identity`

Do not assume extra profiles exist unless you re-check `~/.aws/config` and `~/.aws/credentials`.

## AWS Lightsail

When the user asks about Lightsail instances / how many Lightsail servers:

1. Lightsail is **regional**. Checking only `us-east-1` is not enough.
2. Enumerate instances across Lightsail regions (or at least all regions returned by `aws lightsail get-regions`).
3. Known active footprint (as of 2026-07-16; re-verify with the CLI before acting):

| Region | Instances |
|--------|-----------|
| `ap-southeast-1` (Singapore) | **3** (all running, as of 2026-07-16) |
| Other Lightsail regions | 0 (last full scan) |

### Instances (ap-southeast-1)

| Name | Bundle | Public IP | Notes |
|------|--------|-----------|--------|
| `Ubuntu-1` | large_3_0 | 18.139.147.239 | Static IP `StaticIp-1` |
| `Ubuntu-chitti-replica` | large_3_0 | 52.74.65.226 | Static IP `Ubuntu-chitti-replica-static` |
| **nango-server** (`Ubuntu-3` in Lightsail) | large_3_0 | 18.136.11.230 | Ubuntu 24.04; static IP `Ubuntu-3-static`; key `Ubuntu-3-key`. Private key in-repo: `nango/keys/lightsail-Ubuntu-3-key.pem` (also `~/.ssh/lightsail-Ubuntu-3-key.pem`). Alias: **nango-server**. See **Nango deployment** below. |

Static IPs: three attached (above). Unattached `kaybabylol` (13.228.85.199) was released 2026-07-16.

### Useful commands

```bash
# Profile / identity
aws configure list-profiles
aws sts get-caller-identity

# Instances in Singapore (where they live)
aws lightsail get-instances --region ap-southeast-1 \
  --query 'instances[].{name:name,state:state.name,bundle:bundleId,publicIp:publicIpAddress}' \
  --output table

# Quick multi-region instance counts
for r in us-east-1 us-east-2 us-west-2 eu-west-1 eu-west-2 eu-central-1 \
         ap-southeast-1 ap-southeast-2 ap-northeast-1 ap-south-1 ca-central-1 sa-east-1; do
  n=$(aws lightsail get-instances --region "$r" --query 'length(instances)' --output text 2>/dev/null || echo err)
  echo "$r: $n"
done

# Related resources in Singapore
aws lightsail get-static-ips --region ap-southeast-1 --output table
aws lightsail get-container-services --region ap-southeast-1
aws lightsail get-relational-databases --region ap-southeast-1
```

**Always re-query** before destructive actions (stop/delete/resize); the table above is a discovery hint, not a live inventory.

## Nango deployment (nango-server)

Self-hosted **free edition** of Nango (Auth + Proxy) on Lightsail **nango-server**.

| Item | Value |
|------|--------|
| Public URL | https://nango.fromdonna.com |
| OAuth callback | `https://nango.fromdonna.com/oauth/callback` |
| Lightsail name | `Ubuntu-3` |
| SSH | `ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230` |
| Private key (in repo) | `nango/keys/lightsail-Ubuntu-3-key.pem` (Lightsail key pair `Ubuntu-3-key`) |
| App dir on host | `/home/ubuntu/nango` |
| Compose | `/home/ubuntu/nango/docker-compose.yaml` |
| Env | `/home/ubuntu/nango/.env` (mode 600) |
| Dashboard creds | `/home/ubuntu/nango/CREDENTIALS.txt` (mode 600) |
| Local ports | `3003` (server/dashboard/API), `3009` (Connect UI), `5432` (Postgres), `6379` (Redis) |
| Docker image | `nangohq/nango-server:hosted` |

### Cloudflare Tunnel

| Item | Value |
|------|--------|
| Tunnel name | `nango` |
| Tunnel ID | `e8b11da0-f668-4304-8020-29506f6753bd` |
| Hostname | `nango.fromdonna.com` → `http://127.0.0.1:3003` |
| Config | `~/.cloudflared/config.yml` |
| Credentials | `~/.cloudflared/<tunnel-id>.json` + `cert.pem` |
| systemd | `cloudflared-nango.service` (enabled) |

```bash
# Status
ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230 \
  'sudo systemctl status cloudflared-nango --no-pager; cd ~/nango && sudo docker compose ps; curl -s https://nango.fromdonna.com/health'

# Restart Nango
ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230 \
  'cd ~/nango && sudo docker compose --env-file .env up -d'

# Restart tunnel
ssh -i nango/keys/lightsail-Ubuntu-3-key.pem ubuntu@18.136.11.230 \
  'sudo systemctl restart cloudflared-nango'
```

**Notes:** Do not rotate `NANGO_ENCRYPTION_KEY` after first start. Free self-host covers Auth + Proxy only (no Functions/webhooks/MCP). Dashboard uses basic auth (`FLAG_AUTH_ENABLED=false` + username/password in `.env`).
