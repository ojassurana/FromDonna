"""FromDonna presence: notify gateway on tool starts for process WIP lines.

Does NOT send Telegram messages itself. Gateway owns msg 2–3 (light LLM +
human intent). Hermes mid-turn chat stays off.

Env (set by harness bootstrap / inject):
  FROMDONNA_WORKER_URL     Public gateway base (no trailing slash)
  WORKER_TO_HARNESS_SECRET Shared Bearer for /internal/presence/stage
  FROMDONNA_USER_ID        e.g. telegram:123
  FROMDONNA_CHAT_ID        Telegram chat id (optional; defaults from proxy)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger("fromdonna.presence")

# Same-tool de-dupe only (gateway owns cross-tool budget / interval).
_SAME_TOOL_MIN_S = 1.5
_last_fire_mono = 0.0
_last_tool = ""
_lock = threading.Lock()
_missing_env_warned = False


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _report_stage(tool_name: str) -> None:
    global _last_fire_mono, _last_tool, _missing_env_warned

    worker = _env("FROMDONNA_WORKER_URL")
    secret = _env("WORKER_TO_HARNESS_SECRET")
    user_id = _env("FROMDONNA_USER_ID")
    chat_id = _env("FROMDONNA_CHAT_ID") or _env("FROMDONNA_GATEWAY_CHAT_ID")
    if not worker or not secret or not user_id or not chat_id:
        if not _missing_env_warned:
            _missing_env_warned = True
            logger.warning(
                "fromdonna_presence: stage skipped — missing env "
                "(worker=%s secret=%s user=%s chat=%s)",
                bool(worker),
                bool(secret),
                bool(user_id),
                bool(chat_id),
            )
        return

    now = time.monotonic()
    with _lock:
        # Only suppress identical tool spam within a short window.
        # Do NOT throttle different tools across turns (gateway owns budget).
        if tool_name == _last_tool and (now - _last_fire_mono) < _SAME_TOOL_MIN_S:
            return
        _last_fire_mono = now
        _last_tool = tool_name

    url = worker.rstrip("/") + "/internal/presence/stage"
    payload = json.dumps(
        {
            "userId": user_id,
            "chatId": str(chat_id),
            "toolName": tool_name or "tool",
        }
    ).encode("utf-8")

    def _post() -> None:
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {secret}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                resp.read()
        except Exception as exc:
            logger.warning("presence stage post failed: %s", exc)

    threading.Thread(target=_post, name="fromdonna-presence-stage", daemon=True).start()


def on_pre_tool_call(*, tool_name: str = "", **_: Any) -> None:
    """Fire-and-forget stage report; never block the agent tool path."""
    try:
        if not tool_name:
            return
        _report_stage(str(tool_name))
    except Exception as exc:
        logger.warning("presence pre_tool_call error: %s", exc)


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    logger.info("fromdonna_presence: registered pre_tool_call hook")
