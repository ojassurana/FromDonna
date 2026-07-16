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

**Not this bucket:** channel tokens → gateway; model credentials → llm-proxy; OAuth multi-user apps → tooling docs (connector pattern).

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
3. Known active footprint (as of 2026-07-17; re-verify with the CLI before acting):

| Region | Instances |
|--------|-----------|
| `ap-southeast-1` (Singapore) | **2** (all running, as of 2026-07-17) |
| Other Lightsail regions | 0 (last full scan) |

### Instances (ap-southeast-1)

| Name | Bundle | Public IP | Notes |
|------|--------|-----------|--------|
| `Ubuntu-1` | large_3_0 | 18.139.147.239 | Static IP `StaticIp-1` |
| `Ubuntu-chitti-replica` | large_3_0 | 52.74.65.226 | Static IP `Ubuntu-chitti-replica-static` |

Static IPs: two attached (above).

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
