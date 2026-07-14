"""Official Hermes Telegram gateway runtime for one FromDonna sandbox.

The Cloudflare Worker remains the Telegram edge (webhook, provision, render).
Inside the sandbox we run the real Hermes GatewayRunner + TelegramAdapter
codepath so slash commands, /model pickers, sessions, and tools behave like a
normal Hermes Telegram gateway.

Outbound Bot API calls are intercepted and converted into Worker-renderable
actions (sendMessage / inlineButtons / media). No Telegram secret needs to live
in the sandbox for the happy path — the Worker still sends to Telegram.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Optional

logger = logging.getLogger("fromdonna.gateway_runtime")


@dataclass
class CapturedOutbound:
    """One Telegram Bot API call intercepted from the official adapter."""

    method: str
    kwargs: dict[str, Any] = field(default_factory=dict)


class _RecordingBot:
    """Drop-in stand-in for python-telegram-bot Bot used only for capture."""

    def __init__(self) -> None:
        self.calls: list[CapturedOutbound] = []
        self._msg_id = 0

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _record(self, method: str, kwargs: dict[str, Any]) -> SimpleNamespace:
        self.calls.append(CapturedOutbound(method=method, kwargs=dict(kwargs)))
        return SimpleNamespace(
            message_id=self._next_id(),
            chat=SimpleNamespace(id=kwargs.get("chat_id")),
            text=kwargs.get("text") or kwargs.get("caption") or "",
        )

    async def send_message(self, **kwargs):
        return self._record("send_message", kwargs)

    async def send_photo(self, **kwargs):
        return self._record("send_photo", kwargs)

    async def send_document(self, **kwargs):
        return self._record("send_document", kwargs)

    async def send_audio(self, **kwargs):
        return self._record("send_audio", kwargs)

    async def send_video(self, **kwargs):
        return self._record("send_video", kwargs)

    async def send_voice(self, **kwargs):
        return self._record("send_voice", kwargs)

    async def send_animation(self, **kwargs):
        return self._record("send_animation", kwargs)

    async def send_sticker(self, **kwargs):
        return self._record("send_sticker", kwargs)

    async def send_media_group(self, **kwargs):
        self.calls.append(CapturedOutbound(method="send_media_group", kwargs=dict(kwargs)))
        return [SimpleNamespace(message_id=self._next_id())]

    async def edit_message_text(self, **kwargs):
        return self._record("edit_message_text", kwargs)

    async def edit_message_reply_markup(self, **kwargs):
        return self._record("edit_message_reply_markup", kwargs)

    async def answer_callback_query(self, **kwargs):
        self.calls.append(CapturedOutbound(method="answer_callback_query", kwargs=dict(kwargs)))
        return True

    async def send_chat_action(self, **kwargs):
        # Typing indicators are intentionally dropped — Worker has no live typing
        # bridge yet. Do not fail the turn for them.
        return True

    async def get_me(self):
        return SimpleNamespace(id=0, username="fromdonna", first_name="Donna", is_bot=True)

    async def delete_webhook(self, **kwargs):
        return True

    async def get_webhook_info(self):
        return SimpleNamespace(url="", pending_update_count=0)


class GatewayRuntime:
    """One long-lived official Hermes Telegram gateway for this sandbox user."""

    def __init__(self, hermes_home: str) -> None:
        self.hermes_home = hermes_home
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._runner = None
        self._adapter = None
        self._bot: Optional[_RecordingBot] = None
        self._ready = threading.Event()
        self._start_error: Optional[BaseException] = None

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._ready.clear()
            self._start_error = None
            self._thread = threading.Thread(
                target=self._run_loop,
                name="fromdonna-hermes-gateway",
                daemon=True,
            )
            self._thread.start()
        if not self._ready.wait(timeout=60):
            raise RuntimeError("Hermes Telegram gateway failed to start within 60s")
        if self._start_error is not None:
            raise RuntimeError(f"Hermes Telegram gateway failed to start: {self._start_error}") from self._start_error

    def _run_loop(self) -> None:
        os.environ["HERMES_HOME"] = self.hermes_home
        # Single-user sandbox: never run pairing / allowlist gates against the Worker-edge user.
        os.environ.setdefault("TELEGRAM_ALLOW_ALL_USERS", "true")
        try:
            from gateway.config import GatewayConfig, Platform, PlatformConfig, load_gateway_config
            from gateway.run import GatewayRunner
            from plugins.platforms.telegram.adapter import TelegramAdapter

            try:
                config = load_gateway_config()
            except Exception:
                config = GatewayConfig()

            # Force the official Telegram platform surface. Worker is the edge;
            # this adapter never owns the Bot API webhook.
            config.platforms[Platform.TELEGRAM] = PlatformConfig(
                enabled=True,
                token="fromdonna-proxy",  # never used for real network I/O
                extra={
                    "group_sessions_per_user": True,
                    # Allow the sole sandbox owner without pairing prompts.
                    "allow_all_users": True,
                },
            )
            # Do not boot other platforms in the sandbox.
            for plat in list(config.platforms.keys()):
                if plat != Platform.TELEGRAM:
                    config.platforms[plat].enabled = False

            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

            self._runner = GatewayRunner(config)
            self._bot = _RecordingBot()
            self._adapter = TelegramAdapter(config.platforms[Platform.TELEGRAM])
            # Official adapter code, but network-less: inject a recording bot and
            # mark the adapter connected without polling/webhook.
            self._adapter._bot = self._bot
            self._adapter._connected = True
            self._adapter._running = True
            self._adapter._webhook_mode = True  # skip getUpdates health probes
            self._adapter.set_message_handler(self._runner._handle_message)
            if hasattr(self._adapter, "set_busy_session_handler") and hasattr(self._runner, "_handle_busy_session"):
                try:
                    self._adapter.set_busy_session_handler(self._runner._handle_busy_session)
                except Exception:
                    pass
            self._runner.adapters[Platform.TELEGRAM] = self._adapter
            self._runner._running = True
            self._ready.set()
            self._loop.run_forever()
        except BaseException as exc:  # noqa: BLE001 — surface startup failure to caller
            self._start_error = exc
            self._ready.set()
            logger.exception("fromdonna gateway runtime failed")

    def handle_turn(
        self,
        *,
        text: str,
        user_id: str,
        chat_id: str,
        message_id: str | None = None,
        reply_to_message_id: str | None = None,
        reply_to_text: str | None = None,
        callback_data: str | None = None,
        callback_id: str | None = None,
        capability: str | None = None,
    ) -> list[dict[str, Any]]:
        """Run one inbound event through the official Telegram gateway path.

        Returns Worker-neutral actions: sendMessage / inlineButtons / sendMedia-ish.
        """
        self.start()
        if capability:
            os.environ["FROMDONNA_LLM_CAPABILITY"] = capability
            # Also mirror into the gateway thread env (same process).
        assert self._loop is not None and self._adapter is not None and self._bot is not None

        async def _run() -> list[dict[str, Any]]:
            from gateway.config import Platform
            from gateway.platforms.base import MessageEvent, MessageType
            from gateway.session import SessionSource

            self._bot.calls.clear()
            source = SessionSource(
                platform=Platform.TELEGRAM,
                chat_id=str(chat_id),
                user_id=str(user_id),
                user_name=str(user_id),
                chat_type="dm",
                message_id=message_id,
                # Worker already authenticated the Telegram user.
                role_authorized=True,
            )
            if callback_data is not None:
                # Prefer official callback handling when the adapter exposes it.
                event = MessageEvent(
                    text=callback_data if not text else text,
                    message_type=MessageType.TEXT,
                    source=source,
                    message_id=message_id,
                    metadata={
                        "callback_query_id": callback_id,
                        "callback_data": callback_data,
                        "fromdonna_callback": True,
                    },
                    internal=False,
                )
            else:
                event = MessageEvent(
                    text=text or "",
                    message_type=MessageType.TEXT,
                    source=source,
                    message_id=message_id,
                    reply_to_message_id=reply_to_message_id,
                    reply_to_text=reply_to_text,
                )
            # Official adapter entrypoint (same as real Telegram updates).
            await self._adapter.handle_message(event)
            return _calls_to_actions(self._bot.calls)

        future = asyncio.run_coroutine_threadsafe(_run(), self._loop)
        return future.result(timeout=840)


def _inline_keyboard_to_buttons(reply_markup: Any) -> list[list[dict[str, str]]] | None:
    if reply_markup is None:
        return None
    # python-telegram-bot InlineKeyboardMarkup or dict-shaped markup
    inline = getattr(reply_markup, "inline_keyboard", None)
    if inline is None and isinstance(reply_markup, dict):
        inline = reply_markup.get("inline_keyboard")
    if not inline:
        return None
    rows: list[list[dict[str, str]]] = []
    for row in inline:
        out_row: list[dict[str, str]] = []
        for button in row:
            text = getattr(button, "text", None) or (button.get("text") if isinstance(button, dict) else None)
            if not text:
                continue
            callback = getattr(button, "callback_data", None)
            url = getattr(button, "url", None)
            if isinstance(button, dict):
                callback = button.get("callback_data", callback)
                url = button.get("url", url)
            entry: dict[str, str] = {"text": str(text)}
            if callback:
                entry["callbackData"] = str(callback)
            elif url:
                entry["url"] = str(url)
            else:
                continue
            out_row.append(entry)
        if out_row:
            rows.append(out_row)
    return rows or None


def _calls_to_actions(calls: list[CapturedOutbound]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for call in calls:
        method = call.method
        kw = call.kwargs
        if method in {"send_message", "edit_message_text"}:
            text = (kw.get("text") or "").strip()
            buttons = _inline_keyboard_to_buttons(kw.get("reply_markup"))
            if text:
                actions.append({"type": "sendMessage", "text": text})
            if buttons:
                actions.append(
                    {
                        "type": "inlineButtons",
                        "buttons": buttons,
                        "targetActionIndex": len(actions) - 1 if text else None,
                    }
                )
        elif method in {"send_photo", "send_document", "send_audio", "send_video", "send_voice", "send_animation"}:
            # Prefer local path / URL if present; Worker can only fetch https/r2 today.
            file = kw.get("photo") or kw.get("document") or kw.get("audio") or kw.get("video") or kw.get("voice") or kw.get("animation")
            uri = None
            if isinstance(file, str) and (file.startswith("https://") or file.startswith("r2://")):
                uri = file
            elif hasattr(file, "name") and isinstance(getattr(file, "name", None), str):
                # Local file path — not yet Worker-addressable; surface as text notice.
                caption = (kw.get("caption") or "").strip()
                note = caption or f"(media attached: {getattr(file, 'name', 'file')})"
                actions.append({"type": "sendMessage", "text": note})
                continue
            if uri:
                actions.append(
                    {
                        "type": "sendMedia",
                        "artifact": {"uri": uri},
                        "caption": (kw.get("caption") or None),
                    }
                )
            elif kw.get("caption"):
                actions.append({"type": "sendMessage", "text": str(kw["caption"])})
        elif method == "edit_message_reply_markup":
            buttons = _inline_keyboard_to_buttons(kw.get("reply_markup"))
            if buttons:
                actions.append({"type": "inlineButtons", "buttons": buttons})
        # answer_callback_query / send_chat_action intentionally ignored
    return actions


_RUNTIME: Optional[GatewayRuntime] = None
_RUNTIME_LOCK = threading.Lock()


def get_gateway_runtime(hermes_home: str) -> GatewayRuntime:
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            _RUNTIME = GatewayRuntime(hermes_home)
            _RUNTIME.start()
        return _RUNTIME
