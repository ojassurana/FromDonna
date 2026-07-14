# Harness

Small HTTP entrypoint the **Worker** calls for one private FromDonna E2B
sandbox:

```
Worker → POST sandbox harness → persisted Hermes chat → action envelope
```

## Responsibilities

- Accept capability-authenticated requests from Worker.
- Treat each sandbox as exactly one person's Hermes: persist one stable Hermes
  session id in `~/.hermes/fromdonna-session.json`.
- Serialize `/turn` requests with an in-process mutex plus an advisory file
  lock, so two messages cannot race or reorder conversation context.
- On the first turn, run normal `hermes chat --query ...` and record the
  session created by Hermes. Every later turn runs normal
  `hermes chat --query ... --resume <persisted-session-id>`—never
  `--oneshot` and never `--continue`.
- Convert a channel-neutral inbound event into a Hermes prompt and return
  neutral Worker-renderable actions.
- Never require channel tokens inside the sandbox.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Liveness |
| POST | `/bootstrap` | none (once) | Inject `WORKER_TO_HARNESS_SECRET` into process memory |
| POST | `/turn` | `Authorization: Bearer ***` + `x-llm-capability` | Run one persisted Hermes turn |

## `/turn` envelope

New Worker calls should send the channel-neutral `event` envelope:

```json
{
  "event": {
    "text": "Please look at this",
    "reply": {"messageId": "prior-message", "text": "Earlier context"},
    "attachments": [
      {"type": "image", "uri": "r2://user-private/image.png", "mimeType": "image/png"}
    ],
    "callback": {"id": "callback-id", "data": "open"}
  }
}
```

`text` plus the old `userId`, `gateway`, `gatewayChatId`, and
`gatewayMessageId` fields remain accepted during Worker migration. They are
not used to select a session: the sandbox itself is the one-user boundary.

The response is an action envelope, with legacy `text` retained for old
Worker code:

```json
{
  "actions": [
    {"type": "sendMessage", "text": "I found it."},
    {
      "type": "sendMedia",
      "artifact": {"uri": "r2://user-private/result.pdf", "mimeType": "application/pdf"},
      "caption": "Your result"
    },
    {
      "type": "inlineButtons",
      "buttons": [[{"text": "Open", "url": "https://example.test"}]]
    }
  ],
  "text": "I found it.",
  "sessionId": "stable-hermes-session-id"
}
```

The current Hermes CLI bridge emits `sendMessage` from its final text. The
`sendMedia` artifact and `inlineButtons` actions are part of the validated
neutral contract for future tool/artifact adapters; the Worker renders all
three action types for its channel.

## Why `/bootstrap`

Template warm-start freezes process env at image build time. Create-time
`envVars` are visible to new shells but not to the already-running uvicorn.
The Worker calls `/bootstrap` immediately after create (and best-effort on
later turns).

## LLM path

Hermes uses the existing Cloudflare LLM proxy
(`FROMDONNA_LLM_PROXY_BASE_URL` / config.yaml `base_url`) with the per-turn
capability as `OPENAI_API_KEY`. No provider OAuth tokens enter the sandbox.

## Local verification

```bash
cd E2B-Template/harness
pytest -q test_server.py
```
