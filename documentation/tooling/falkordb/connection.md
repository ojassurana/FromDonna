# FalkorDB — connection guide for agents & external apps

This document tells an AI agent (or a human) on **any other server** how to talk to the shared FalkorDB graph database.  
There is **no public raw Redis port**. Access is via **Cloudflare Tunnel TCP** + **Redis password auth**.

Ignore any web UI. Apps use the **Redis wire protocol** only.

---

## Quick facts

| Item | Value |
|------|--------|
| Product | FalkorDB (Redis + graph module) |
| Cloudflare TCP hostname | `falkordb-redis.ojassurana.com` |
| Local bind after tunnel | `127.0.0.1:6379` |
| Auth method | Redis `requirepass` (password) |
| Password | `duu0JMRezw921VzS4jpvwA4D1UHWKPOK` |
| Connection URL (after tunnel) | `redis://:duu0JMRezw921VzS4jpvwA4D1UHWKPOK@127.0.0.1:6379` |
| Origin server (do not open publicly) | Lightsail `HeadScaleEtc` / tailnet `100.64.0.2` — Redis only on `127.0.0.1:6379` |

**Do not** point clients at the Lightsail public IP for Redis. **Do not** use `falkordb.ojassurana.com` for app access (browser UI only).

---

## What you need on the client server

1. Network egress to Cloudflare (HTTPS / tunnel).
2. [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed.
3. A Redis-compatible client library (or `redis-cli`).
4. The password above.

Optional: run `cloudflared` as a long-lived systemd service / sidecar so the app always sees `127.0.0.1:6379`.

---

## Step 1 — Install cloudflared (if missing)

```bash
# Debian/Ubuntu example
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

cloudflared --version
```

(Other OS: use the official Cloudflare cloudflared install docs.)

---

## Step 2 — Open a TCP tunnel to FalkorDB

On the **client** machine (the other server), keep this running:

```bash
cloudflared access tcp \
  --hostname falkordb-redis.ojassurana.com \
  --url 127.0.0.1:6379
```

- Listens on **this machine**: `127.0.0.1:6379`
- Forwards through Cloudflare to origin FalkorDB
- Leave it in the foreground, `tmux`/`screen`, or a systemd unit

If port `6379` is already taken locally, pick another local port:

```bash
cloudflared access tcp \
  --hostname falkordb-redis.ojassurana.com \
  --url 127.0.0.1:16379
```

Then use port `16379` in the app config instead of `6379`.

---

## Step 3 — Authenticate and test

```bash
redis-cli -h 127.0.0.1 -p 6379 -a duu0JMRezw921VzS4jpvwA4D1UHWKPOK PING
# expect: PONG
```

Python example:

```python
import redis

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    password="duu0JMRezw921VzS4jpvwA4D1UHWKPOK",
    decode_responses=True,
)
assert r.ping() is True
```

Node example:

```js
import { createClient } from "redis";

const client = createClient({
  url: "redis://:duu0JMRezw921VzS4jpvwA4D1UHWKPOK@127.0.0.1:6379",
});
await client.connect();
console.log(await client.ping()); // PONG
```

---

## Step 4 — Use the graph DB

FalkorDB is driven with **graph commands** over the same Redis connection (module name `graph`).

Examples (`redis-cli` with password):

```bash
# List graphs (if supported by your version)
redis-cli -h 127.0.0.1 -p 6379 -a duu0JMRezw921VzS4jpvwA4D1UHWKPOK GRAPH.LIST

# Create / query a graph (Cypher)
redis-cli -h 127.0.0.1 -p 6379 -a duu0JMRezw921VzS4jpvwA4D1UHWKPOK \
  GRAPH.QUERY mygraph "CREATE (n:Person {name: 'Ada'}) RETURN n"

redis-cli -h 127.0.0.1 -p 6379 -a duu0JMRezw921VzS4jpvwA4D1UHWKPOK \
  GRAPH.QUERY mygraph "MATCH (n:Person) RETURN n.name"
```

Prefer official **FalkorDB client libraries** when available; they still need host/port/password as above (pointing at the local forwarded port).

---

## Agent checklist (copy-paste)

1. Install `cloudflared` if not present.
2. Start:  
   `cloudflared access tcp --hostname falkordb-redis.ojassurana.com --url 127.0.0.1:6379`
3. Connect Redis client to `127.0.0.1:6379` with password `duu0JMRezw921VzS4jpvwA4D1UHWKPOK`.
4. Verify with `PING` → `PONG`.
5. Issue `GRAPH.*` commands (or FalkorDB SDK) against that connection.
6. Keep `cloudflared` running for the lifetime of the app.

### Config blob for agents

```yaml
falkordb:
  # Public tunnel hostname (NOT a direct redis host:port on the internet)
  tunnel_hostname: falkordb-redis.ojassurana.com
  # After cloudflared access tcp:
  host: 127.0.0.1
  port: 6379
  password: duu0JMRezw921VzS4jpvwA4D1UHWKPOK
  url: redis://:duu0JMRezw921VzS4jpvwA4D1UHWKPOK@127.0.0.1:6379
  protocol: redis
  graph_commands: true
  ui_url: null   # do not use browser UI for app access
```

---

## What will NOT work

| Attempt | Result |
|---------|--------|
| `redis://falkordb-redis.ojassurana.com:6379` dialed directly | Fail — CF edge is not raw public Redis |
| Lightsail public IP `:6379` | Fail — Redis bound to localhost only |
| `https://falkordb.ojassurana.com` from an app as a DB API | Wrong — browser UI only |
| Connecting without password | Fail — `NOAUTH` / auth required |
| Connecting without `cloudflared` (or equivalent tunnel) | Fail from external servers |

---

## Security notes for agents

- Treat the password as a **secret**. Do not commit it to public repos if the project is public; prefer env vars in production (`FALKORDB_PASSWORD`).
- This password grants **full read/write** to the graph DB.
- Prefer least privilege at the **app** layer (separate graphs/keys per app if multi-tenant).
- Cloudflare Tunnel keeps the origin off the open internet; still protect the password.

Suggested env on client servers:

```bash
export FALKORDB_HOST=127.0.0.1
export FALKORDB_PORT=6379
export FALKORDB_PASSWORD=duu0JMRezw921VzS4jpvwA4D1UHWKPOK
export FALKORDB_URL="redis://:${FALKORDB_PASSWORD}@${FALKORDB_HOST}:${FALKORDB_PORT}"
export FALKORDB_TUNNEL_HOSTNAME=falkordb-redis.ojassurana.com
```

---

## Ops / where this DB lives (reference)

- Host alias: `HeadScaleEtc` / `headscale-sg`
- Tailnet IP: `100.64.0.2`
- Compose dir on origin: `/home/ubuntu/falkordb/`
- Cloudflare tunnel name: `falkordb-lightsail`
- This file: `/home/ubuntu/falkordb/connection.md`

If `PING` fails: confirm `cloudflared access tcp` is running, local port is free, password is exact, and the origin container `falkordb` is up on the FalkorDB server.
