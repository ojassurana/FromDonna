"""FromDonna's channel-neutral outbound transport plugin.

The plugin has no network client and no transport credentials.  During a
harness-owned turn, it appends schema-validated actions to the private file
selected in ``FROMDONNA_ACTIONS_FILE``.  The harness is the only component
that reads that file and gives the actions to the Worker for channel rendering.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


_ACTIONS_FILE_ENV = "FROMDONNA_ACTIONS_FILE"
_MAX_TEXT_LENGTH = 16_000
_MAX_CAPTION_LENGTH = 4_096
_MAX_ACTION_BYTES = 32_768
_MAX_BUTTON_ROWS = 16
_MAX_BUTTONS_PER_ROW = 16
_MAX_BUTTONS = 100


SEND_ACTION_SCHEMA = {
    "name": "fromdonna_send",
    "description": (
        "Deliberately send a channel-neutral response action through the user's "
        "private FromDonna transport. Use send_message for text, send_media for "
        "a Worker-addressable artifact, or inline_buttons for callback/URL "
        "buttons. This tool never needs or exposes a channel token or recipient."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["send_message", "send_media", "inline_buttons"],
                "description": "The outbound action to record.",
            },
            "text": {
                "type": "string",
                "description": "Required for send_message.",
            },
            "artifact": {
                "type": "object",
                "additionalProperties": False,
                "description": "Required for send_media: a Worker-addressable r2:// or https:// artifact.",
                "properties": {
                    "uri": {"type": "string"},
                    "name": {"type": "string"},
                    "mimeType": {"type": "string"},
                },
                "required": ["uri"],
            },
            "caption": {
                "type": "string",
                "description": "Optional caption for send_media.",
            },
            "buttons": {
                "type": "array",
                "description": "Required for inline_buttons. Rows of buttons with a text plus exactly one callbackData or HTTPS url.",
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "text": {"type": "string"},
                            "callbackData": {"type": "string"},
                            "url": {"type": "string"},
                        },
                        "required": ["text"],
                    },
                },
            },
            "targetActionIndex": {
                "type": "integer",
                "minimum": 0,
                "description": "Optional zero-based action index the button set decorates.",
            },
        },
        "required": ["operation"],
    },
}


def _trimmed_string(value: Any, field: str, *, maximum: int, required: bool = False) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    value = value.strip()
    if not value:
        if required:
            raise ValueError(f"{field} must not be empty")
        return None
    if len(value) > maximum:
        raise ValueError(f"{field} is too long")
    return value


def _safe_artifact(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - {"uri", "name", "mimeType"}:
        raise ValueError("artifact must contain only uri, name, and mimeType")
    uri = _trimmed_string(value.get("uri"), "artifact.uri", maximum=2_048, required=True)
    parsed = urlparse(uri)
    if parsed.scheme not in {"r2", "https"} or not parsed.netloc:
        raise ValueError("artifact.uri must be an r2:// or https:// URI")

    artifact = {"uri": uri}
    name = _trimmed_string(value.get("name"), "artifact.name", maximum=255)
    mime_type = _trimmed_string(value.get("mimeType"), "artifact.mimeType", maximum=255)
    if name is not None:
        artifact["name"] = name
    if mime_type is not None:
        artifact["mimeType"] = mime_type
    return artifact


def _safe_buttons(value: Any) -> list[list[dict[str, str]]]:
    if not isinstance(value, list) or not value or len(value) > _MAX_BUTTON_ROWS:
        raise ValueError("buttons must contain between 1 and 16 rows")

    normalized: list[list[dict[str, str]]] = []
    count = 0
    for row in value:
        if not isinstance(row, list) or not row or len(row) > _MAX_BUTTONS_PER_ROW:
            raise ValueError("each button row must contain between 1 and 16 buttons")
        normalized_row: list[dict[str, str]] = []
        for button in row:
            if not isinstance(button, dict) or set(button) - {"text", "callbackData", "url"}:
                raise ValueError("each button must contain only text, callbackData, and url")
            text = _trimmed_string(button.get("text"), "button.text", maximum=128, required=True)
            callback_data = _trimmed_string(button.get("callbackData"), "button.callbackData", maximum=256)
            url = _trimmed_string(button.get("url"), "button.url", maximum=2_048)
            if (callback_data is None) == (url is None):
                raise ValueError("each button requires exactly one callbackData or HTTPS url")
            if url is not None:
                parsed = urlparse(url)
                if parsed.scheme != "https" or not parsed.netloc:
                    raise ValueError("button.url must be an HTTPS URL")
            normalized_row.append(
                {"text": text, **({"callbackData": callback_data} if callback_data else {}), **({"url": url} if url else {})}
            )
            count += 1
            if count > _MAX_BUTTONS:
                raise ValueError("too many buttons")
        normalized.append(normalized_row)
    return normalized


def _normalize_action(params: dict[str, Any]) -> dict[str, Any]:
    operation = params.get("operation")
    if operation == "send_message":
        if set(params) - {"operation", "text"}:
            raise ValueError("send_message only accepts text")
        return {
            "type": "sendMessage",
            "text": _trimmed_string(params.get("text"), "text", maximum=_MAX_TEXT_LENGTH, required=True),
        }
    if operation == "send_media":
        if set(params) - {"operation", "artifact", "caption"}:
            raise ValueError("send_media only accepts artifact and caption")
        action: dict[str, Any] = {"type": "sendMedia", "artifact": _safe_artifact(params.get("artifact"))}
        caption = _trimmed_string(params.get("caption"), "caption", maximum=_MAX_CAPTION_LENGTH)
        if caption is not None:
            action["caption"] = caption
        return action
    if operation == "inline_buttons":
        if set(params) - {"operation", "buttons", "targetActionIndex"}:
            raise ValueError("inline_buttons only accepts buttons and targetActionIndex")
        action = {"type": "inlineButtons", "buttons": _safe_buttons(params.get("buttons"))}
        target = params.get("targetActionIndex")
        if target is not None:
            if type(target) is not int or target < 0 or target >= 50:
                raise ValueError("targetActionIndex must be an integer from 0 through 49")
            action["targetActionIndex"] = target
        return action
    raise ValueError("operation must be send_message, send_media, or inline_buttons")


def _action_file() -> Path:
    raw_path = os.environ.get(_ACTIONS_FILE_ENV)
    if not raw_path:
        raise RuntimeError("FromDonna transport is only available during a Worker turn")
    path = Path(raw_path)
    if not path.is_absolute() or path.name == "." or ".." in path.parts:
        raise RuntimeError("FromDonna transport action path is invalid")
    return path


def _append_action(action: dict[str, Any]) -> None:
    path = _action_file()
    flags = os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise RuntimeError("FromDonna transport action file is unavailable") from exc
    try:
        file_stat = os.fstat(fd)
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.getuid() or file_stat.st_mode & 0o077:
            raise RuntimeError("FromDonna transport action file is not private")
        payload = (json.dumps(action, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(payload) > _MAX_ACTION_BYTES:
            raise ValueError("action payload is too large")
        offset = 0
        while offset < len(payload):
            offset += os.write(fd, payload[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)


def fromdonna_send(params: dict[str, Any], **_kwargs: Any) -> str:
    """Validate and append one action; no credentials or recipient data involved."""
    try:
        action = _normalize_action(params)
        _append_action(action)
    except (RuntimeError, ValueError) as exc:
        return json.dumps({"success": False, "error": str(exc)})
    return json.dumps({"success": True, "action": action})


def _available_for_harness_turn() -> bool:
    return bool(os.environ.get(_ACTIONS_FILE_ENV))


def register(ctx: Any) -> None:
    ctx.register_tool(
        name="fromdonna_send",
        toolset="fromdonna_transport",
        schema=SEND_ACTION_SCHEMA,
        handler=fromdonna_send,
        check_fn=_available_for_harness_turn,
        description="Record a channel-neutral outbound message, artifact, or inline-button action for the FromDonna Worker.",
    )
