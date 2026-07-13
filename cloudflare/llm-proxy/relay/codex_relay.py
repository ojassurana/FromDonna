#!/usr/bin/env python3
"""Private relay for the Worker to reach the Codex backend from an allowed host."""
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

UPSTREAM = "https://chatgpt.com/backend-api/codex/responses"


def account_id(token: str) -> str | None:
    try:
        encoded = token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(encoded))
        return claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
    except Exception:
        return None


def active_codex_credential():
    """Use Hermes's active pooled credential, matching gateway selection.

    ``resolve_codex_runtime_credentials`` intentionally prefers the singleton
    device-code token. The gateway uses the credential pool first. Those can
    be different ChatGPT accounts, so selecting the singleton in this relay can
    hit an exhausted account while the gateway is using a healthy one.
    """
    from agent.credential_pool import load_pool
    from hermes_cli.auth import resolve_codex_runtime_credentials

    pool = load_pool("openai-codex")
    entry = pool.peek()
    if entry and entry.runtime_api_key:
        return entry.runtime_api_key, pool
    return str(resolve_codex_runtime_credentials().get("api_key", "") or ""), None


class Relay(BaseHTTPRequestHandler):
    server_version = "FromDonnaCodexRelay/1"

    def log_message(self, format, *args):
        # Never log request headers or bodies: they contain OAuth access tokens.
        print("%s - %s" % (self.address_string(), format % args), flush=True)

    def do_POST(self):
        if self.path != "/v1/responses":
            self.send_error(404)
            return
        if self.headers.get("X-Relay-Token") != os.environ.get("RELAY_SHARED_SECRET"):
            self.send_error(401)
            return
        # This follows the gateway's pool-first selection so the Worker uses
        # the same ChatGPT account and shared quota-rotation state.
        try:
            token, credential_pool = active_codex_credential()
            if not token:
                raise RuntimeError("No active Codex credential")
        except Exception:
            self.send_error(503, "Active Hermes Codex credential unavailable")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            json.loads(body)
        except Exception:
            self.send_error(400)
            return
        headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": "codex_cli_rs/0.0.0 (FromDonna Relay)",
            "originator": "codex_cli_rs",
        }
        chatgpt_account_id = account_id(token)
        if chatgpt_account_id:
            headers["ChatGPT-Account-ID"] = chatgpt_account_id
        try:
            upstream = requests.post(UPSTREAM, headers=headers, data=body, timeout=180)
        except requests.RequestException:
            self.send_error(502)
            return
        if upstream.status_code == 429 and credential_pool is not None:
            # Keep Worker and gateway quota rotation in one shared Hermes pool.
            # Do not log the upstream payload: it may contain account metadata.
            try:
                error_context = upstream.json()
            except ValueError:
                error_context = None
            credential_pool.mark_exhausted_and_rotate(
                status_code=429,
                error_context=error_context if isinstance(error_context, dict) else None,
                api_key_hint=token,
            )
        self.send_response(upstream.status_code)
        self.send_header("Content-Type", upstream.headers.get("content-type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(upstream.content)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9121"))
    ThreadingHTTPServer(("127.0.0.1", port), Relay).serve_forever()
