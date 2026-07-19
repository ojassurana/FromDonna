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

**Not this bucket:** channel tokens → gateway; model credentials → llm-proxy; **OAuth multi-user apps (Gmail etc.) → Composio** (below).

## Composio (OAuth apps + MCP for Hermes/Donna)

Production multi-user Gmail/Drive/GitHub/… via **Composio**. Full write-up: [documentation/tooling/composio.md](./documentation/tooling/composio.md).

| Piece | Where | Rule |
|--------|--------|------|
| `COMPOSIO_API_KEY` | **`fromdonna-composio-proxy` secret only** | Never gateway, never E2B, never git |
| Shared MCP URL | `https://fromdonna-composio-proxy…/mcp` | Same for all users (product door) |
| Per-user identity | Bearer HMAC session token | Minted by gateway at bootstrap; **30d TTL** default (not short-lived) |
| Sticky tool-router session | D1 `user_composio.composio_session_id` | Reuse across E2B recreate |
| Sticky upstream MCP URL | D1 `user_composio.composio_mcp_url` | Composio-hosted session target — **not** the shared product `/mcp` URL |
| Toolkit allowlist | D1 `user_composio.toolkits_json` | Forever policy (seeded once) |
| Capability Bearer | Harness **process env** only | `FROMDONNA_COMPOSIO_MCP_TOKEN`; yaml has `${…}` placeholder only |

1. **Gateway** `ensureUserComposio` + `mintComposioMcpAccess` on harness bootstrap → injects `composioMcp` into sandbox. Provision/replace = **hard** `requireComposio`; per-message inject = **soft** (warm TG gateway may **skip** bootstrap entirely).
2. **Harness** writes official Hermes `mcp_servers.composio` block: shared `url`, `Authorization: Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}`, `connect_timeout: 60`, `timeout: 180`, `skip_preflight: true`. Real token stays in process env; re-bootstrap reloads MCP if gateway already running.
3. **User connects** via Composio `COMPOSIO_MANAGE_CONNECTIONS` / proxy `POST /internal/connect` → `connect.composio.dev` login URL (browser once). Gateway `mintComposioConnectLink` exists but is not a Telegram `/connect` command yet.
4. After **any** harness/composio template change: **`cd E2B-Template && npm run build:prod`** (alias `fromdonna-hermes`). Existing sandboxes keep old image until recreated.

## Product MCP doors (future MCP connectors)

When adding another **multi-user MCP** (secrets / per-user identity outside E2B) — **not** plain HTTP APIs, **not** a second OAuth vault for Gmail-class apps:

1. **Shared product `/mcp` URL** for all users; identity = **capability Bearer** (process env in harness; yaml `${…}` only).
2. **Real vendor/product secrets only on the MCP door Worker** — never gateway, E2B, or git.
3. Hermes is the **MCP client** to our door (`list_tools` → expand into `tools[]`); Worker reverse-proxies or terminates MCP upstream.
4. Prefer the **same capability/session family** as Composio (HMAC claims, sticky upstream ids in D1 if sessionful, allowlist policy). Do not invent a third auth model lightly.
5. Full checklist: [documentation/tooling/mcp-proxy-protocol.md](./documentation/tooling/mcp-proxy-protocol.md). Reference implementation: [composio.md](./documentation/tooling/composio.md). Buckets overview: [general.md](./documentation/tooling/general.md).

**Not this bucket:** plain product HTTP APIs → api-proxy; multi-user OAuth apps → extend Composio allowlist first.

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
