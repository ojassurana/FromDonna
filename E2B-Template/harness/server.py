"""Private Worker -> Hermes HTTP handoff for one FromDonna E2B sandbox.

Secrets policy:
- No Telegram / Codex / provider credentials live here.
- Worker authenticates with a shared harness secret (injected once via /bootstrap
  because template warm-start freezes process env at image-build time).
- Per-turn LLM access is only a short-lived capability token that Hermes sends
  as OPENAI_API_KEY to the existing FromDonna LLM proxy Worker. Real provider
  credentials stay on Cloudflare / the Codex relay.
"""
from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()
HOME = Path.home()
LLM_PROXY_BASE_URL = os.environ.get(
    "FROMDONNA_LLM_PROXY_BASE_URL",
    "https://fromdonna-llm-proxy.code-df4.workers.dev/v1",
)

# Populated either from create-time env (if process is restarted) or /bootstrap.
_lock = threading.Lock()
_worker_secret: str | None = os.environ.get("WORKER_TO_HARNESS_SECRET") or None


class Turn(BaseModel):
    userId: str
    gateway: str
    gatewayChatId: str
    gatewayMessageId: str
    text: str


class Bootstrap(BaseModel):
    secret: str = Field(min_length=16, max_length=256)


def _authorized(authorization: str | None) -> bool:
    with _lock:
        expected = _worker_secret
    return bool(expected) and authorization == f"Bearer {expected}"


@app.get("/health")
def health():
    with _lock:
        ready = bool(_worker_secret)
    return {"ok": True, "service": "fromdonna-harness", "auth_ready": ready}


@app.post("/bootstrap")
def bootstrap(body: Bootstrap):
    """One-time auth setup after sandbox create. Template warm-start cannot see create envVars."""
    global _worker_secret
    secret = body.secret.strip()
    if len(secret) < 16:
        raise HTTPException(status_code=400, detail="invalid_secret")
    with _lock:
        if _worker_secret is not None:
            # Idempotent if the same secret is re-sent; reject secret rotation attempts.
            if _worker_secret == secret:
                return {"ok": True, "already": True}
            raise HTTPException(status_code=409, detail="already_bootstrapped")
        _worker_secret = secret
    return {"ok": True, "already": False}


@app.post("/turn")
def turn(
    turn: Turn,
    authorization: str | None = Header(default=None),
    x_llm_capability: str | None = Header(default=None),
):
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="unauthorized")
    if not turn.text.strip():
        return {"text": ""}
    if not x_llm_capability or not x_llm_capability.strip():
        raise HTTPException(status_code=401, detail="missing_llm_capability")

    # Capability is only for this child process — never written to disk / ~/.hermes.
    env = os.environ | {
        "HERMES_HOME": str(HOME / ".hermes"),
        "OPENAI_API_KEY": x_llm_capability.strip(),
        "OPENAI_BASE_URL": LLM_PROXY_BASE_URL,
    }
    try:
        completed = subprocess.run(
            [
                "/home/user/venv/bin/hermes",
                "--oneshot",
                turn.text,
                "--provider",
                "custom",
                "--model",
                "gpt-5.6-terra",
                "--continue",
                "fromdonna",
            ],
            cwd=str(HOME / "workspace"),
            env=env,
            text=True,
            capture_output=True,
            timeout=840,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="agent_turn_timed_out")

    if completed.returncode != 0:
        # Do not return stderr: it can contain runtime details.
        raise HTTPException(status_code=502, detail="agent_turn_failed")
    return {"text": completed.stdout.strip()}
