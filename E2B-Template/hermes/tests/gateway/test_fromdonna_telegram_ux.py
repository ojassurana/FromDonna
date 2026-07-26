"""FromDonna Telegram UX: thinking-dots bubble (parallel, non-blocking).

Exercises pure helpers in ``plugins.platforms.telegram.fromdonna_ux`` and the
TelegramAdapter hooks that schedule them fire-and-forget on processing start /
clear on first real outbound / complete. Bot API I/O is mocked at the boundary.
"""
from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType, ProcessingOutcome
from gateway.session import SessionSource


def _install_fake_telegram(monkeypatch):
    fake_telegram = types.ModuleType("telegram")
    fake_telegram.Update = SimpleNamespace(ALL_TYPES=())
    fake_telegram.Bot = object
    fake_telegram.Message = object
    fake_telegram.InlineKeyboardButton = object
    fake_telegram.InlineKeyboardMarkup = object

    fake_error = types.ModuleType("telegram.error")
    fake_error.NetworkError = type("NetworkError", (Exception,), {})
    fake_error.BadRequest = type("BadRequest", (Exception,), {})
    fake_error.TimedOut = type("TimedOut", (Exception,), {})
    fake_telegram.error = fake_error

    fake_constants = types.ModuleType("telegram.constants")
    fake_constants.ParseMode = SimpleNamespace(MARKDOWN_V2="MarkdownV2")
    fake_constants.ChatType = SimpleNamespace(
        GROUP="group",
        SUPERGROUP="supergroup",
        CHANNEL="channel",
        PRIVATE="private",
    )
    fake_telegram.constants = fake_constants

    fake_ext = types.ModuleType("telegram.ext")
    fake_ext.Application = object
    fake_ext.CommandHandler = object
    fake_ext.CallbackQueryHandler = object
    fake_ext.MessageHandler = object
    fake_ext.ContextTypes = SimpleNamespace(DEFAULT_TYPE=object)
    fake_ext.filters = object

    fake_request = types.ModuleType("telegram.request")
    fake_request.HTTPXRequest = object

    monkeypatch.setitem(sys.modules, "telegram", fake_telegram)
    monkeypatch.setitem(sys.modules, "telegram.error", fake_error)
    monkeypatch.setitem(sys.modules, "telegram.constants", fake_constants)
    monkeypatch.setitem(sys.modules, "telegram.ext", fake_ext)
    monkeypatch.setitem(sys.modules, "telegram.request", fake_request)


@pytest.fixture
def adapter(monkeypatch):
    _install_fake_telegram(monkeypatch)
    from plugins.platforms.telegram.adapter import TelegramAdapter

    a = TelegramAdapter(PlatformConfig(enabled=True, token="fake-token"))
    a._bot = MagicMock()
    a._bot.edit_message_text = AsyncMock()
    a._bot.set_message_reaction = AsyncMock()
    a._bot.delete_message = AsyncMock()
    a._bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=500))
    a._bot.send_message_draft = AsyncMock(return_value=True)
    a._disable_link_previews = False
    return a


def _make_event(
    text: str = "hello there",
    chat_id: str = "42",
    message_id: str = "99",
    chat_type: str = "dm",
) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=Platform.TELEGRAM,
            chat_id=chat_id,
            chat_type=chat_type,
            user_id="7",
            user_name="alice",
        ),
        message_id=message_id,
    )


# ── Pure helpers ──────────────────────────────────────────────────────────


def test_dots_cycle_sequence():
    from plugins.platforms.telegram.fromdonna_ux import DOTS_FRAMES, dots_sequence, next_dots_frame

    assert DOTS_FRAMES == (".", "..", "...")
    assert dots_sequence(6) == [".", "..", "...", ".", "..", "..."]
    frame0, i1 = next_dots_frame(0)
    frame1, i2 = next_dots_frame(i1)
    frame2, i3 = next_dots_frame(i2)
    assert (frame0, frame1, frame2) == (".", "..", "...")
    assert i3 == 0


def test_dots_edit_interval_adaptive():
    from plugins.platforms.telegram.fromdonna_ux import (
        DOTS_INTERVAL_SECONDS,
        DOTS_MAX_ANIMATE_SECONDS,
        DOTS_SLOW_AFTER_SECONDS,
        DOTS_SLOW_INTERVAL_SECONDS,
        dots_edit_interval,
        dots_retry_after_seconds,
    )

    assert DOTS_INTERVAL_SECONDS < 0.4
    assert dots_edit_interval(0.0) == DOTS_INTERVAL_SECONDS
    assert dots_edit_interval(DOTS_SLOW_AFTER_SECONDS) == DOTS_SLOW_INTERVAL_SECONDS
    assert dots_edit_interval(DOTS_MAX_ANIMATE_SECONDS) is None
    assert dots_edit_interval(DOTS_MAX_ANIMATE_SECONDS + 5) is None

    class _Flood(Exception):
        retry_after = 2.5

    assert dots_retry_after_seconds(_Flood()) == 2.5
    assert dots_retry_after_seconds(RuntimeError("retry after 3"), default=1.0) == 3.0


def test_thinking_draft_id_nonzero():
    from plugins.platforms.telegram.fromdonna_ux import thinking_draft_id

    assert thinking_draft_id(chat_id="42", message_id="99") == 99
    assert thinking_draft_id(chat_id="42", message_id="0") != 0
    assert thinking_draft_id(chat_id="abc", message_id="xyz") != 0


def test_should_clear_thinking_dots_on_outbound():
    from plugins.platforms.telegram.fromdonna_ux import (
        THINKING_DOTS_METADATA_KEY,
        should_clear_thinking_dots_on_outbound,
    )

    assert should_clear_thinking_dots_on_outbound(success=True, metadata=None) is True
    assert should_clear_thinking_dots_on_outbound(
        success=True, metadata={THINKING_DOTS_METADATA_KEY: True},
    ) is False
    assert should_clear_thinking_dots_on_outbound(success=False, metadata=None) is False


# ── Adapter wiring ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_processing_start_schedules_without_blocking(adapter):
    """on_processing_start must return without awaiting Bot API send."""
    event = _make_event(chat_type="dm")
    # Slow draft send would hang the agent if awaited on the start hook.
    gate = asyncio.Event()

    async def _slow_draft(**_kwargs):
        await gate.wait()
        return True

    adapter._bot.send_message_draft = AsyncMock(side_effect=_slow_draft)

    # Must return promptly even though draft I/O is blocked.
    await asyncio.wait_for(adapter.on_processing_start(event), timeout=0.5)

    # Let the background task finish.
    gate.set()
    await asyncio.sleep(0.05)
    await adapter._fromdonna_clear_thinking_dots("42")


@pytest.mark.asyncio
async def test_processing_start_uses_draft_in_dm(adapter):
    event = _make_event(chat_type="dm")
    await adapter._fromdonna_start_thinking_dots(event)
    await asyncio.sleep(0.02)

    adapter._bot.send_message_draft.assert_awaited()
    kwargs = adapter._bot.send_message_draft.await_args.kwargs
    assert kwargs.get("text") == "."
    assert kwargs.get("draft_id") == 99
    assert "42" in adapter._fromdonna_thinking
    assert adapter._fromdonna_thinking["42"]["mode"] == "draft"
    adapter._bot.send_message.assert_not_awaited()

    await adapter._fromdonna_clear_thinking_dots("42")


@pytest.mark.asyncio
async def test_processing_start_message_fallback_in_group(adapter):
    event = _make_event(chat_type="group")
    await adapter._fromdonna_start_thinking_dots(event)
    await asyncio.sleep(0.02)

    adapter._bot.send_message.assert_awaited()
    send_kwargs = adapter._bot.send_message.await_args.kwargs
    assert send_kwargs.get("text") == "."
    assert send_kwargs.get("disable_notification") is True
    assert adapter._fromdonna_thinking["42"]["mode"] == "message"
    assert adapter._fromdonna_thinking["42"]["message_id"] == "500"
    adapter._bot.send_message_draft.assert_not_awaited()

    await adapter._fromdonna_clear_thinking_dots("42")
    adapter.delete_message = AsyncMock(return_value=True)
    # clear already ran; second clear is no-op
    await adapter._fromdonna_clear_thinking_dots("42")


@pytest.mark.asyncio
async def test_real_outbound_deletes_message_mode_dots(adapter):
    from plugins.platforms.telegram.fromdonna_ux import THINKING_DOTS_METADATA_KEY

    stop = asyncio.Event()
    adapter._fromdonna_thinking["42"] = {
        "mode": "message",
        "message_id": "500",
        "stop_event": stop,
        "frame_index": 1,
        "task": None,
    }
    adapter.delete_message = AsyncMock(return_value=True)

    await adapter._fromdonna_maybe_clear_thinking_dots(
        "42", metadata=None, success=True,
    )
    assert "42" not in adapter._fromdonna_thinking
    assert stop.is_set()
    adapter.delete_message.assert_awaited_with("42", "500")

    # Own dots outbound must not clear.
    adapter._fromdonna_thinking["42"] = {
        "mode": "message",
        "message_id": "501",
        "stop_event": asyncio.Event(),
        "task": None,
    }
    await adapter._fromdonna_maybe_clear_thinking_dots(
        "42",
        metadata={THINKING_DOTS_METADATA_KEY: True},
        success=True,
    )
    assert "42" in adapter._fromdonna_thinking


@pytest.mark.asyncio
async def test_processing_complete_clears_in_parallel(adapter):
    stop = asyncio.Event()
    adapter._fromdonna_thinking["42"] = {
        "mode": "draft",
        "message_id": None,
        "draft_id": 99,
        "stop_event": stop,
        "task": None,
    }
    event = _make_event()
    await asyncio.wait_for(
        adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS),
        timeout=0.5,
    )
    # Background clear may still be settling.
    for _ in range(20):
        if "42" not in adapter._fromdonna_thinking:
            break
        await asyncio.sleep(0.01)
    assert "42" not in adapter._fromdonna_thinking
    assert stop.is_set()
