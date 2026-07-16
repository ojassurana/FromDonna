"""Telegram reactions: FromDonna supersedes Hermès lifecycle 👀/👍/👎.

FromDonna owns inbound reactions (❤️🔥👍😭 via a parallel classifier) and a
thinking-dots bubble. The old TELEGRAM_REACTIONS lifecycle is disabled so one
inbound message never gets two competing reaction schemes.

``_set_reaction`` / ``_clear_reactions`` remain as Bot API helpers for the
context-reaction path.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType, ProcessingOutcome
from gateway.session import SessionSource


def _make_adapter(**_extra):
    from plugins.platforms.telegram.adapter import TelegramAdapter

    adapter = object.__new__(TelegramAdapter)
    adapter.platform = Platform.TELEGRAM
    adapter.config = PlatformConfig(enabled=True, token="fake-token")
    adapter._bot = AsyncMock()
    adapter._bot.set_message_reaction = AsyncMock()
    adapter._bot.edit_message_text = AsyncMock()
    adapter._fromdonna_thinking = {}
    return adapter


def _make_event(
    chat_id: str = "123",
    message_id: str = "456",
    text: str = "hello",
) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=Platform.TELEGRAM,
            chat_id=chat_id,
            chat_type="private",
            user_id="42",
            user_name="TestUser",
        ),
        message_id=message_id,
    )


# ── _reactions_enabled (legacy lifecycle — always off for FromDonna) ─


def test_reactions_disabled_by_default(monkeypatch):
    """Legacy Hermès lifecycle reactions stay off even without env."""
    monkeypatch.delenv("TELEGRAM_REACTIONS", raising=False)
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


def test_reactions_enabled_when_set_true(monkeypatch):
    """TELEGRAM_REACTIONS=true no longer enables 👀/👍/👎 lifecycle."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "true")
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


def test_reactions_enabled_with_1(monkeypatch):
    """TELEGRAM_REACTIONS=1 is superseded by FromDonna UX."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "1")
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


def test_reactions_disabled_with_false(monkeypatch):
    """TELEGRAM_REACTIONS=false remains disabled (lifecycle never on)."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "false")
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


def test_reactions_disabled_with_0(monkeypatch):
    """TELEGRAM_REACTIONS=0 remains disabled (lifecycle never on)."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "0")
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


def test_reactions_disabled_with_no(monkeypatch):
    """TELEGRAM_REACTIONS=no remains disabled (lifecycle never on)."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "no")
    adapter = _make_adapter()
    assert adapter._reactions_enabled() is False


# ── _set_reaction ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_reaction_calls_bot_api(monkeypatch):
    """_set_reaction should call bot.set_message_reaction with correct args."""
    adapter = _make_adapter()

    result = await adapter._set_reaction("123", "456", "\U0001f440")

    assert result is True
    adapter._bot.set_message_reaction.assert_awaited_once_with(
        chat_id=123,
        message_id=456,
        reaction="\U0001f440",
    )


@pytest.mark.asyncio
async def test_set_reaction_returns_false_without_bot(monkeypatch):
    """_set_reaction should return False when bot is not available."""
    adapter = _make_adapter()
    adapter._bot = None

    result = await adapter._set_reaction("123", "456", "\U0001f440")
    assert result is False


@pytest.mark.asyncio
async def test_set_reaction_handles_api_error_gracefully(monkeypatch):
    """API errors during reaction should not propagate."""
    adapter = _make_adapter()
    adapter._bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("no perms"))

    result = await adapter._set_reaction("123", "456", "\U0001f440")
    assert result is False


# ── on_processing_start (FromDonna: context react + dots, not 👀) ────


@pytest.mark.asyncio
async def test_on_processing_start_does_not_set_eyes_lifecycle(monkeypatch):
    """FromDonna must not apply Hermès 👀 lifecycle reaction."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "true")
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    adapter._bot.send_message = AsyncMock(
        return_value=SimpleNamespace(message_id=900)
    )
    adapter._disable_link_previews = False
    event = _make_event(text="this is amazing")

    with patch(
        "plugins.platforms.telegram.fromdonna_ux.classify_reaction_emoji",
        return_value="🔥",
    ):
        await adapter.on_processing_start(event)
        await asyncio.sleep(0.05)

    # No 👀 lifecycle reaction.
    for call in adapter._bot.set_message_reaction.await_args_list:
        assert call.kwargs.get("reaction") != "\U0001f440"
        assert call.kwargs.get("reaction") != "👀"
    await adapter._fromdonna_clear_thinking_dots("123")


@pytest.mark.asyncio
async def test_on_processing_start_applies_context_emoji(monkeypatch):
    """Processing start fires parallel context reaction from the four-emoji set."""
    from plugins.platforms.telegram.fromdonna_ux import REACTION_EMOJIS

    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    adapter._bot.send_message = AsyncMock(
        return_value=SimpleNamespace(message_id=900)
    )
    adapter._disable_link_previews = False
    event = _make_event(text="thank you so much")

    with patch(
        "plugins.platforms.telegram.fromdonna_ux.classify_reaction_emoji",
        return_value="❤️",
    ):
        await adapter.on_processing_start(event)
        await asyncio.sleep(0.05)

    assert adapter._bot.set_message_reaction.await_count >= 1
    reaction = adapter._bot.set_message_reaction.await_args.kwargs.get("reaction")
    assert reaction in REACTION_EMOJIS
    assert reaction == "❤️"
    await adapter._fromdonna_clear_thinking_dots("123")


@pytest.mark.asyncio
async def test_on_processing_start_skipped_when_fromdonna_ux_disabled(monkeypatch):
    """When FromDonna UX is off, start is a no-op (no lifecycle either)."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "false")
    monkeypatch.setenv("TELEGRAM_REACTIONS", "true")
    adapter = _make_adapter()
    adapter._bot.send_message = AsyncMock()
    event = _make_event()

    await adapter.on_processing_start(event)

    adapter._bot.send_message.assert_not_awaited()
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_processing_start_handles_missing_ids(monkeypatch):
    """Should handle events without chat_id or message_id gracefully."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    adapter._bot.send_message = AsyncMock()
    event = MessageEvent(
        text="hello",
        message_type=MessageType.TEXT,
        source=SimpleNamespace(chat_id=None),
        message_id=None,
    )

    await adapter.on_processing_start(event)
    await asyncio.sleep(0.02)

    adapter._bot.send_message.assert_not_awaited()
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_processing_complete_safe_without_thinking_state(monkeypatch):
    """Partial adapters missing _fromdonna_thinking must not AttributeError."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    del adapter._fromdonna_thinking
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)
    # No lifecycle 👍 either.
    adapter._bot.set_message_reaction.assert_not_awaited()


# ── on_processing_complete (clears dots; no 👍/👎) ───────────────────


@pytest.mark.asyncio
async def test_on_processing_complete_success(monkeypatch):
    """Successful processing must not set thumbs-up; only clear thinking-dots."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "true")
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    adapter.delete_message = AsyncMock(return_value=True)
    stop = asyncio.Event()
    adapter._fromdonna_thinking["123"] = {
        "message_id": "900",
        "stop_event": stop,
        "frame_index": 1,
        "task": None,
    }
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)

    assert "123" not in adapter._fromdonna_thinking
    assert stop.is_set()
    adapter.delete_message.assert_awaited_once_with("123", "900")
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_processing_complete_failure(monkeypatch):
    """Failed processing must not set thumbs-down lifecycle reaction."""
    monkeypatch.setenv("TELEGRAM_REACTIONS", "true")
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.FAILURE)

    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_processing_complete_skipped_when_disabled(monkeypatch):
    """Processing complete is a no-op when FromDonna UX is off."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "false")
    adapter = _make_adapter()
    adapter.delete_message = AsyncMock()
    adapter._fromdonna_thinking["123"] = {
        "message_id": "900",
        "stop_event": asyncio.Event(),
        "frame_index": 0,
        "task": None,
    }
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.SUCCESS)

    adapter.delete_message.assert_not_awaited()
    assert "123" in adapter._fromdonna_thinking
    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_processing_complete_cancelled_clears_thinking_dots(monkeypatch):
    """Cancelled turn clears thinking-dots bubble; no reaction clear API."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "true")
    adapter = _make_adapter()
    adapter.delete_message = AsyncMock(return_value=True)
    stop = asyncio.Event()
    adapter._fromdonna_thinking["123"] = {
        "message_id": "900",
        "stop_event": stop,
        "frame_index": 0,
        "task": None,
    }
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.CANCELLED)

    assert "123" not in adapter._fromdonna_thinking
    assert stop.is_set()
    # Must NOT call set_message_reaction(reaction=None) lifecycle clear.
    adapter._bot.set_message_reaction.assert_not_awaited()
    adapter.delete_message.assert_awaited_once_with("123", "900")


@pytest.mark.asyncio
async def test_on_processing_complete_cancelled_skipped_when_disabled(monkeypatch):
    """Cancelled processing should not call the API when FromDonna UX is off."""
    monkeypatch.setenv("FROMDONNA_TELEGRAM_UX", "false")
    adapter = _make_adapter()
    event = _make_event()

    await adapter.on_processing_complete(event, ProcessingOutcome.CANCELLED)

    adapter._bot.set_message_reaction.assert_not_awaited()


@pytest.mark.asyncio
async def test_clear_reactions_handles_api_error_gracefully(monkeypatch):
    """API errors during clear should not propagate."""
    adapter = _make_adapter()
    adapter._bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("no perms"))

    result = await adapter._clear_reactions("123", "456")
    assert result is False


@pytest.mark.asyncio
async def test_clear_reactions_returns_false_without_bot(monkeypatch):
    """_clear_reactions should return False when bot is not available."""
    adapter = _make_adapter()
    adapter._bot = None

    result = await adapter._clear_reactions("123", "456")
    assert result is False


# ── config.py bridging ───────────────────────────────────────────────


def test_config_bridges_telegram_reactions(monkeypatch, tmp_path):
    """gateway/config.py bridges telegram.reactions to TELEGRAM_REACTIONS env var."""
    import yaml
    config_file = tmp_path / "config.yaml"
    config_file.write_text(yaml.dump({
        "telegram": {
            "reactions": True,
        },
    }))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Use setenv (not delenv) so monkeypatch registers cleanup even when
    # the var doesn't exist yet — load_gateway_config will overwrite it.
    monkeypatch.setenv("TELEGRAM_REACTIONS", "")

    from gateway.config import load_gateway_config
    load_gateway_config()

    import os
    assert os.getenv("TELEGRAM_REACTIONS") == "true"


def test_config_reactions_env_takes_precedence(monkeypatch, tmp_path):
    """Env var should take precedence over config.yaml for reactions."""
    import yaml
    config_file = tmp_path / "config.yaml"
    config_file.write_text(yaml.dump({
        "telegram": {
            "reactions": True,
        },
    }))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TELEGRAM_REACTIONS", "false")

    from gateway.config import load_gateway_config
    load_gateway_config()

    import os
    assert os.getenv("TELEGRAM_REACTIONS") == "false"
