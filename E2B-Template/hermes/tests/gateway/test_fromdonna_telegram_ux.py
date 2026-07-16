"""FromDonna Telegram UX: thinking-dots bubble + context emoji reactions.

Exercises the shipped helpers in
``plugins.platforms.telegram.fromdonna_ux`` and the TelegramAdapter hooks that
wire them (processing start → dots + parallel reaction; first real outbound /
processing complete → delete dots). Bot API I/O is mocked at the boundary.
"""
from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

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
    return a


def _make_event(text: str = "hello there", chat_id: str = "42", message_id: str = "99") -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=Platform.TELEGRAM,
            chat_id=chat_id,
            chat_type="dm",
            user_id="7",
            user_name="alice",
        ),
        message_id=message_id,
    )


# ── Pure helpers (shipped module) ─────────────────────────────────────────


def test_dots_cycle_sequence():
    from plugins.platforms.telegram.fromdonna_ux import DOTS_FRAMES, dots_sequence, next_dots_frame

    assert DOTS_FRAMES == (".", "..", "...")
    assert dots_sequence(6) == [".", "..", "...", ".", "..", "..."]
    frame0, i1 = next_dots_frame(0)
    frame1, i2 = next_dots_frame(i1)
    frame2, i3 = next_dots_frame(i2)
    assert (frame0, frame1, frame2) == (".", "..", "...")
    assert i3 == 0


def test_reaction_allowlist_and_constraint():
    from plugins.platforms.telegram.fromdonna_ux import (
        REACTION_EMOJIS,
        constrain_reaction_emoji,
        parse_classifier_response,
    )

    assert REACTION_EMOJIS == ("❤️", "🔥", "👍", "😭")
    assert constrain_reaction_emoji("🔥") == "🔥"
    assert constrain_reaction_emoji("I pick 😭 ok") == "😭"
    assert constrain_reaction_emoji("fire") == "🔥"
    assert constrain_reaction_emoji("garbage") == "👍"
    assert parse_classifier_response("  ❤️  ") == "❤️"
    # Must never leave the four-emoji set
    for raw in ("👀", "👎", "🎉", "", None, "xxx"):
        assert constrain_reaction_emoji(raw) in REACTION_EMOJIS


def test_heuristic_fallback_context():
    from plugins.platforms.telegram.fromdonna_ux import heuristic_reaction_emoji

    assert heuristic_reaction_emoji("I love this, thank you!") == "❤️"
    assert heuristic_reaction_emoji("this is fire 🔥") == "🔥"
    assert heuristic_reaction_emoji("I'm so sad and frustrated") == "😭"
    assert heuristic_reaction_emoji("what time is it?") == "👍"


def test_classify_uses_llm_then_constrains():
    from plugins.platforms.telegram.fromdonna_ux import classify_reaction_emoji

    assert classify_reaction_emoji("anything", llm_call=lambda _t: "🔥") == "🔥"
    assert classify_reaction_emoji("thanks so much", llm_call=lambda _t: "nope") == "👍"
    # LLM failure → heuristic
    def boom(_t):
        raise RuntimeError("network")

    assert classify_reaction_emoji("thank you friend", llm_call=boom) == "❤️"


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
async def test_legacy_lifecycle_reactions_disabled(adapter):
    """FromDonna supersedes TELEGRAM_REACTIONS 👀/👍/👎."""
    assert adapter._reactions_enabled() is False
    event = _make_event()
    # Even with env set, lifecycle scheme must not fire (method returns False).
    with patch.dict("os.environ", {"TELEGRAM_REACTIONS": "true"}):
        assert adapter._reactions_enabled() is False
        await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_processing_start_posts_dots_and_reacts(adapter, monkeypatch):
    from plugins.platforms.telegram.fromdonna_ux import (
        REACTION_EMOJIS,
        THINKING_DOTS_METADATA_KEY,
    )
    from gateway.platforms.base import SendResult

    sent = {}

    async def fake_send(chat_id, content, reply_to=None, metadata=None):
        sent["chat_id"] = chat_id
        sent["content"] = content
        sent["metadata"] = metadata
        return SendResult(success=True, message_id="500")

    adapter.send = AsyncMock(side_effect=fake_send)

    # Deterministic classifier path (no network).
    monkeypatch.setattr(
        "plugins.platforms.telegram.fromdonna_ux.classify_reaction_emoji",
        lambda text, **kwargs: "🔥",
    )

    event = _make_event(text="this is amazing!")
    await adapter.on_processing_start(event)
    # Allow parallel react task to finish.
    await asyncio.sleep(0.05)

    assert sent["content"] == "."
    assert sent["metadata"].get(THINKING_DOTS_METADATA_KEY) is True
    assert "42" in adapter._fromdonna_thinking
    assert adapter._fromdonna_thinking["42"]["message_id"] == "500"

    # Reaction applied with allowed emoji only.
    assert adapter._bot.set_message_reaction.await_count >= 1
    _, kwargs = adapter._bot.set_message_reaction.call_args
    reaction = kwargs.get("reaction")
    assert reaction in REACTION_EMOJIS
    assert reaction == "🔥"

    # Cleanup animate task
    await adapter._fromdonna_clear_thinking_dots("42")


@pytest.mark.asyncio
async def test_real_outbound_deletes_thinking_dots(adapter):
    from plugins.platforms.telegram.fromdonna_ux import THINKING_DOTS_METADATA_KEY

    stop = asyncio.Event()
    adapter._fromdonna_thinking["42"] = {
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
    adapter.delete_message.assert_awaited_once_with("42", "500")

    # Dots bubble own send must NOT clear (would delete itself).
    adapter._fromdonna_thinking["42"] = {
        "message_id": "501",
        "stop_event": asyncio.Event(),
        "frame_index": 0,
        "task": None,
    }
    adapter.delete_message.reset_mock()
    await adapter._fromdonna_maybe_clear_thinking_dots(
        "42",
        metadata={THINKING_DOTS_METADATA_KEY: True},
        success=True,
    )
    assert "42" in adapter._fromdonna_thinking
    adapter.delete_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_processing_complete_deletes_thinking_dots(adapter):
    stop = asyncio.Event()
    adapter._fromdonna_thinking["42"] = {
        "message_id": "777",
        "stop_event": stop,
        "frame_index": 2,
        "task": None,
    }
    adapter.delete_message = AsyncMock(return_value=True)

    await adapter.on_processing_complete(_make_event(), ProcessingOutcome.SUCCESS)

    assert "42" not in adapter._fromdonna_thinking
    assert stop.is_set()
    adapter.delete_message.assert_awaited_once_with("42", "777")
    # Must not apply lifecycle 👍/👎
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_dots_animation_cycles_frames(adapter, monkeypatch):
    from plugins.platforms.telegram.fromdonna_ux import DOTS_FRAMES
    from gateway.platforms.base import SendResult

    # Speed up animation for the test.
    monkeypatch.setattr(
        "plugins.platforms.telegram.fromdonna_ux.DOTS_INTERVAL_SECONDS",
        0.02,
    )

    adapter.send = AsyncMock(return_value=SendResult(success=True, message_id="900"))
    adapter.delete_message = AsyncMock(return_value=True)

    await adapter._fromdonna_start_thinking_dots(_make_event())
    # Wait for a few animation ticks.
    await asyncio.sleep(0.12)

    texts = [
        call.kwargs.get("text") or (call.args[0] if call.args else None)
        for call in adapter._bot.edit_message_text.await_args_list
    ]
    # edit_message_text is called as keyword text=...
    edited = []
    for call in adapter._bot.edit_message_text.await_args_list:
        if call.kwargs.get("text") is not None:
            edited.append(call.kwargs["text"])
        elif call.args:
            # positional form not expected, but tolerate
            edited.append(call.args[-1] if call.args else None)

    assert any(t in DOTS_FRAMES for t in edited), f"expected dots edits, got {edited}"
    # Must have progressed beyond the initial "."
    assert any(t in ("..", "...") for t in edited), f"cycle incomplete: {edited}"

    await adapter._fromdonna_clear_thinking_dots("42")


@pytest.mark.asyncio
async def test_ux_can_be_disabled(adapter, monkeypatch):
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "false")
    adapter.send = AsyncMock()
    await adapter.on_processing_start(_make_event())
    adapter.send.assert_not_awaited()
    assert adapter._fromdonna_thinking == {}
