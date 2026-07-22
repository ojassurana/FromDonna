"""Official Hermes Telegram gateway runtime for one FromDonna sandbox.

Cloudflare Worker owns the real bot token + webhook.
This process runs the stock Hermes TelegramAdapter + GatewayRunner with:

  platforms.telegram.extra.base_url      → Worker Bot API proxy
  platforms.telegram.extra.base_file_url → Worker file proxy
  token                                  → per-user proxy token (not real TG token)

Inbound: Worker POSTs the raw Telegram Update JSON to the harness, which calls
``Application.process_update`` — the same handler graph as polling/webhook.
Outbound: adapter Bot methods hit Worker proxy → api.telegram.org.

No recording bot. No ``hermes chat -q``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("fromdonna.gateway_runtime")


@dataclass
class TelegramProxyConfig:
    token: str
    base_url: str
    base_file_url: str
    user_id: str
    chat_id: str
    gateway_user_id: str


def _adapter_fatal_detail(adapter: Any) -> str:
    """Hermes stores fatal state on ``_fatal_error_message`` / ``_fatal_error_code``."""
    if adapter is None:
        return ""
    message = (
        getattr(adapter, "fatal_error_message", None)
        or getattr(adapter, "_fatal_error_message", None)
        or getattr(adapter, "_fatal_error", None)
        or getattr(adapter, "_last_fatal_error", None)
    )
    code = getattr(adapter, "fatal_error_code", None) or getattr(adapter, "_fatal_error_code", None)
    if message and code:
        return f"{code}: {message}"
    if message:
        return str(message)
    if code:
        return str(code)
    return ""


class GatewayRuntime:
    """One long-lived official Hermes Telegram gateway for this sandbox user."""

    def __init__(self, hermes_home: str) -> None:
        self.hermes_home = hermes_home
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._runner = None
        self._adapter = None
        self._ready = threading.Event()
        self._start_error: Optional[BaseException] = None
        self._proxy: Optional[TelegramProxyConfig] = None
        self._platform_config = None

    def configure_proxy(self, proxy: TelegramProxyConfig) -> None:
        self._proxy = proxy

    def is_running(self) -> bool:
        return bool(
            self._thread
            and self._thread.is_alive()
            and self._start_error is None
            and self._ready.is_set()
            and self._adapter is not None
            and self._loop is not None
        )

    def start(self) -> None:
        if not self._proxy:
            raise RuntimeError("Telegram proxy config required before starting gateway")
        last_error: Optional[BaseException] = None
        for attempt in range(3):
            with self._lock:
                if self.is_running():
                    return
                wait_existing = bool(self._thread and self._thread.is_alive() and not self._ready.is_set())
                if not wait_existing:
                    self._hard_reset_locked()
                    self._thread = threading.Thread(
                        target=self._run_loop,
                        name="fromdonna-hermes-gateway",
                        daemon=True,
                    )
                    self._thread.start()
            if not self._ready.wait(timeout=120):
                last_error = RuntimeError("Donna gateway failed to start within 120s")
                with self._lock:
                    self._hard_reset_locked()
            elif self._start_error is not None:
                last_error = self._start_error
                with self._lock:
                    self._hard_reset_locked()
            else:
                return
            logger.warning("gateway start attempt %d failed: %s", attempt + 1, last_error)
            time.sleep(0.4 * (attempt + 1))
        raise RuntimeError(
            f"Donna gateway failed to start: {last_error}"
        ) from last_error

    def _hard_reset_locked(self) -> None:
        """Stop any previous gateway thread and drop platform locks (single-user box)."""
        loop = self._loop
        thread = self._thread
        if loop is not None:
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:
                pass
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        self._force_clear_telegram_locks()
        self._ready.clear()
        self._start_error = None
        self._runner = None
        self._adapter = None
        self._loop = None
        self._thread = None
        self._platform_config = None

    def _force_clear_telegram_locks(self) -> None:
        """FromDonna sandboxes are 1 user / 1 process — always clear local TG locks.

        Hermes platform locks are machine-local files under
        ``~/.local/state/hermes/gateway-locks``. Stale same-PID or dead-PID
        locks are the dominant cause of ``connect() returned False``.
        """
        try:
            from gateway.status import _get_scope_lock_path, release_scoped_lock
        except Exception:
            _get_scope_lock_path = None  # type: ignore[assignment]
            release_scoped_lock = None  # type: ignore[assignment]

        if self._proxy is not None and release_scoped_lock is not None:
            try:
                release_scoped_lock("telegram-bot-token", self._proxy.token)
            except Exception:
                pass
            if _get_scope_lock_path is not None:
                try:
                    lock_path = _get_scope_lock_path("telegram-bot-token", self._proxy.token)
                    lock_path.unlink(missing_ok=True)
                except Exception:
                    pass

        # Nuclear option for this single-user sandbox: wipe every TG bot lock.
        for root in (
            Path(self.hermes_home).expanduser().parent / ".local" / "state" / "hermes" / "gateway-locks",
            Path.home() / ".local" / "state" / "hermes" / "gateway-locks",
            Path("/home/user/.local/state/hermes/gateway-locks"),
        ):
            try:
                if not root.is_dir():
                    continue
                for path in root.glob("telegram-bot-token-*.lock"):
                    try:
                        path.unlink(missing_ok=True)
                        logger.warning("removed telegram platform lock %s", path)
                    except Exception:
                        logger.exception("failed removing lock %s", path)
            except Exception:
                logger.exception("failed scanning lock dir %s", root)

    def _build_adapter(self):
        """Construct a fresh TelegramAdapter + GatewayRunner for one connect attempt."""
        from gateway.config import GatewayConfig, Platform, PlatformConfig, load_gateway_config
        from gateway.run import GatewayRunner
        from plugins.platforms.telegram.adapter import TelegramAdapter

        assert self._proxy is not None
        proxy = self._proxy

        try:
            config = load_gateway_config()
        except Exception:
            config = GatewayConfig()

        # Preserve official settings from ~/.hermes/config.yaml (platforms.telegram
        # / bridged extra keys like allowed_chats, guest_mode). Runtime only
        # overlays FromDonna Worker proxy fields so template policy sticks.
        existing = config.platforms.get(Platform.TELEGRAM)
        extra: dict[str, Any] = {}
        if existing is not None and isinstance(getattr(existing, "extra", None), dict):
            extra.update(existing.extra)

        extra.update(
            {
                "group_sessions_per_user": True,
                "allow_all_users": True,
                # Official PTB/Hermes hook for local Bot API servers — we point at Worker.
                # IMPORTANT: no trailing slash. PTB concatenates `{token}/{method}`
                # so base must end with `.../bot` → `.../bot{token}/getMe`.
                "base_url": proxy.base_url.rstrip("/"),
                "base_file_url": proxy.base_file_url.rstrip("/"),
            }
        )
        # Re-apply template policy keys that must win over accidental empty overrides.
        if existing is not None and isinstance(getattr(existing, "extra", None), dict):
            for key in (
                "allowed_chats",
                "group_allowed_chats",
                "guest_mode",
                "observe_unmentioned_group_messages",
                "require_mention",
                "allow_admin_from",
                "user_allowed_commands",
                "group_allow_admin_from",
                "group_user_allowed_commands",
                "command_menu",
            ):
                if key in existing.extra:
                    extra[key] = existing.extra[key]

        # Preserve template policy from platforms.telegram (reply_to_mode etc.).
        # Building a bare PlatformConfig() defaults reply_to_mode to "first", which
        # re-quotes every user message — FromDonna sets reply_to_mode: off in config.
        existing_reply_mode = (
            getattr(existing, "reply_to_mode", None) if existing is not None else None
        )
        reply_to_mode = (
            str(existing_reply_mode).strip().lower()
            if existing_reply_mode
            else "off"
        )
        if reply_to_mode not in {"off", "first", "all"}:
            reply_to_mode = "off"

        platform_config = PlatformConfig(
            enabled=True,
            token=proxy.token,
            extra=extra,
            reply_to_mode=reply_to_mode,
            home_channel=getattr(existing, "home_channel", None) if existing else None,
            gateway_restart_notification=(
                bool(getattr(existing, "gateway_restart_notification", True))
                if existing is not None
                else True
            ),
            typing_indicator=(
                bool(getattr(existing, "typing_indicator", True))
                if existing is not None
                else True
            ),
            channel_overrides=(
                dict(getattr(existing, "channel_overrides", None) or {})
                if existing is not None
                else {}
            ),
        )
        config.platforms[Platform.TELEGRAM] = platform_config
        for plat in list(config.platforms.keys()):
            if plat != Platform.TELEGRAM:
                config.platforms[plat].enabled = False

        runner = GatewayRunner(config)
        adapter = TelegramAdapter(config.platforms[Platform.TELEGRAM])
        adapter.set_message_handler(runner._handle_message)
        if hasattr(adapter, "set_busy_session_handler") and hasattr(runner, "_handle_busy_session"):
            try:
                adapter.set_busy_session_handler(runner._handle_busy_session)
            except Exception:
                pass
        runner.adapters[Platform.TELEGRAM] = adapter
        runner._running = True

        # Skip polling/webhook transport: Worker injects raw Updates.
        async def _skip_polling(self_adapter, **_kwargs):  # type: ignore[no-untyped-def]
            logger.info(
                "[%s] FromDonna: skipping Telegram polling (Worker injects updates)",
                self_adapter.name,
            )
            return True

        adapter._start_polling_resilient = _skip_polling.__get__(adapter, type(adapter))  # type: ignore[method-assign]
        self._platform_config = platform_config
        return runner, adapter

    def _run_loop(self) -> None:
        os.environ["HERMES_HOME"] = self.hermes_home
        # Single-user sandbox: Worker already authenticated the Telegram user.
        os.environ.setdefault("TELEGRAM_ALLOW_ALL_USERS", "true")
        # Consumer DM UX: never re-quote the user's message on every bot bubble.
        # (Hermes defaults to "first"; config.yaml also sets reply_to_mode: off.)
        os.environ["TELEGRAM_REPLY_TO_MODE"] = "off"
        # Do not enable Hermès lifecycle 👀/👍/👎 reactions unless explicitly opted in.
        os.environ.setdefault("TELEGRAM_REACTIONS", "false")
        # Custom base_url points at Worker — do NOT rewrite traffic to Telegram IPs.
        os.environ["HERMES_TELEGRAM_DISABLE_FALLBACK_IPS"] = "1"
        # Fail faster on proxy errors (Worker auth / network) instead of 8×30s.
        os.environ.setdefault("HERMES_TELEGRAM_INIT_TIMEOUT", "12")
        os.environ.setdefault("HERMES_TELEGRAM_HTTP_CONNECT_TIMEOUT", "8")
        os.environ.setdefault("HERMES_TELEGRAM_HTTP_READ_TIMEOUT", "15")
        # Preflight dump of every LLM request body → ~/.hermes/sessions/request_dump_*.json
        # (same mechanism as the Chitti hermes-first-api-request explainer).
        # Image default is on (template.ts); set HERMES_DUMP_REQUESTS=0 to disable.
        os.environ.setdefault("HERMES_DUMP_REQUESTS", "1")
        # Never let the adapter open a real Telegram webhook/poll on the shared bot.
        os.environ.pop("TELEGRAM_WEBHOOK_URL", None)
        try:
            assert self._proxy is not None
            self._force_clear_telegram_locks()

            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

            async def _connect() -> None:
                last_err: Optional[BaseException] = None
                for attempt in range(3):
                    self._force_clear_telegram_locks()
                    # Fresh adapter each attempt — half-initialized adapters are poison.
                    self._runner, self._adapter = self._build_adapter()
                    assert self._adapter is not None
                    try:
                        ok = await self._adapter.connect()
                    except BaseException as exc:  # noqa: BLE001
                        last_err = exc
                        logger.exception("TelegramAdapter.connect raised (attempt %d)", attempt + 1)
                        ok = False
                        try:
                            self._adapter._release_platform_lock()
                        except Exception:
                            pass
                    if ok:
                        # Treat as webhook-like: no polling heartbeat against getUpdates.
                        self._adapter._webhook_mode = True
                        self._adapter._connected = True
                        self._adapter._running = True
                        logger.info("FromDonna Telegram gateway connected (attempt %d)", attempt + 1)
                        return
                    detail = _adapter_fatal_detail(self._adapter)
                    last_err = RuntimeError(
                        "TelegramAdapter.connect() returned False"
                        + (f" ({detail})" if detail else "")
                    )
                    logger.error("%s (attempt %d)", last_err, attempt + 1)
                    try:
                        self._adapter._release_platform_lock()
                    except Exception:
                        pass
                    self._force_clear_telegram_locks()
                    await asyncio.sleep(0.3 * (attempt + 1))
                raise last_err or RuntimeError("TelegramAdapter.connect() returned False")

            self._loop.run_until_complete(_connect())
            self._ready.set()
            self._loop.run_forever()
        except BaseException as exc:  # noqa: BLE001
            self._start_error = exc
            self._force_clear_telegram_locks()
            self._ready.set()
            logger.exception("fromdonna gateway runtime failed")
        finally:
            # If we exit run_forever (stop), release locks for a later restart.
            if self._start_error is not None:
                self._force_clear_telegram_locks()

    def inject_update(self, update: dict[str, Any], *, capability: str | None = None) -> dict[str, Any]:
        """Feed one raw Telegram Update through the official adapter Application."""
        self.start()
        if capability:
            os.environ["FROMDONNA_LLM_CAPABILITY"] = capability
        assert self._loop is not None and self._adapter is not None

        async def _run() -> dict[str, Any]:
            from telegram import Update

            app = getattr(self._adapter, "_app", None)
            bot = getattr(self._adapter, "_bot", None)
            if app is None or bot is None:
                raise RuntimeError("Telegram Application not ready")

            tg_update = Update.de_json(update, bot)
            if tg_update is None:
                raise RuntimeError("Invalid Telegram update payload")

            cq = getattr(tg_update, "callback_query", None)
            if cq is not None:
                state_keys = list(getattr(self._adapter, "_model_picker_state", {}).keys())
                logger.info(
                    "inject callback_query id=%s data=%r chat=%s picker_state_keys=%s handlers=%s",
                    getattr(cq, "id", None),
                    getattr(cq, "data", None),
                    getattr(getattr(getattr(cq, "message", None), "chat", None), "id", None),
                    state_keys,
                    len(getattr(app, "handlers", {}) or {}),
                )

            # Snapshot active session tasks before process_update.
            before = set(getattr(self._adapter, "_session_tasks", {}).keys())
            try:
                await app.process_update(tg_update)
            except Exception:
                logger.exception("Application.process_update failed for update_id=%s", update.get("update_id"))
                raise

            # Live Bot API proxy already streams outbound mid-turn. Do NOT hold the
            # Worker HTTP request for the full agent loop (CF subrequest timeouts
            # caused "Something went wrong" after long idle / slow models).
            # Wait briefly so handlers can schedule a session task, then return.
            await self._wait_for_session_schedule(before, max_wait_s=2.0)

            # After the HTTP response returns, wait for the real agent session to
            # finish, then upload a channel-agnostic R2 checkpoint (agent-home +
            # workspace). Pause/resume does not need this; replaceRuntime does.
            before_for_ckpt = set(before)
            try:
                loop = self._loop
                if loop is not None:
                    def _checkpoint_when_idle() -> None:
                        try:
                            assert loop is not None
                            fut = asyncio.run_coroutine_threadsafe(
                                self._wait_for_new_or_active_sessions(before_for_ckpt),
                                loop,
                            )
                            fut.result(timeout=900)
                        except Exception:
                            logger.exception("wait for session before checkpoint failed")
                        try:
                            import checkpoint as ckpt

                            # Stage locally; Worker pulls via GET /internal/checkpoint/export
                            # (sandbox→workers.dev POST is often blocked with CF error 1010).
                            result = ckpt.prepare_local_checkpoint(source="gateway-session")
                            logger.info("checkpoint staged after session: %s", result)
                        except Exception:
                            logger.exception("checkpoint stage failed")

                    threading.Thread(
                        target=_checkpoint_when_idle,
                        name="fromdonna-ckpt-after-turn",
                        daemon=True,
                    ).start()
            except Exception:
                logger.exception("failed to schedule post-turn checkpoint")

            if cq is not None:
                # Ensure callback spinner is cleared even if a Hermes handler forgot answer().
                try:
                    await cq.answer()
                except Exception as exc:
                    logger.info("callback answer after process_update: %s", exc)

            return {
                "ok": True,
                "kind": "callback" if cq is not None else "message",
                "callback_data": getattr(cq, "data", None) if cq is not None else None,
            }

        future = asyncio.run_coroutine_threadsafe(_run(), self._loop)
        return future.result(timeout=840)

    async def _wait_for_session_schedule(self, before_keys: set[str], max_wait_s: float = 2.0) -> None:
        """Wait briefly for handle_message to schedule a session task, then return.

        Outbound Telegram traffic already goes live via the Worker Bot API proxy,
        so the inject HTTP call must not block for the whole agent turn.
        """
        assert self._adapter is not None
        deadline = asyncio.get_event_loop().time() + max_wait_s
        while asyncio.get_event_loop().time() < deadline:
            tasks = getattr(self._adapter, "_session_tasks", {}) or {}
            active = getattr(self._adapter, "_active_sessions", {}) or {}
            if any(k not in before_keys for k in tasks.keys()) or tasks or active:
                return
            await asyncio.sleep(0.02)

    async def _wait_for_new_or_active_sessions(self, before_keys: set[str]) -> None:
        """Wait until official handle_message background work finishes."""
        assert self._adapter is not None

        # Allow handlers to schedule session tasks.
        task = None
        session_key = None
        for _ in range(150):  # up to ~3s
            tasks = getattr(self._adapter, "_session_tasks", {}) or {}
            active = getattr(self._adapter, "_active_sessions", {}) or {}
            # Prefer a newly created session key.
            new_keys = [k for k in tasks.keys() if k not in before_keys]
            if new_keys:
                session_key = new_keys[0]
                task = tasks.get(session_key)
                break
            if tasks:
                session_key = next(iter(tasks.keys()))
                task = tasks.get(session_key)
                break
            if not active and not tasks:
                # Command paths may finish inline with no session task.
                await asyncio.sleep(0.02)
                tasks = getattr(self._adapter, "_session_tasks", {}) or {}
                if not tasks and not getattr(self._adapter, "_active_sessions", {}):
                    return
            await asyncio.sleep(0.02)

        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                logger.warning("gateway session task cancelled for %s", session_key)
            except Exception:
                logger.exception("gateway session task failed for %s", session_key)
            # Drain cascaded follow-ups briefly.
            for _ in range(50):
                tasks = getattr(self._adapter, "_session_tasks", {}) or {}
                active = getattr(self._adapter, "_active_sessions", {}) or {}
                if not tasks and not active:
                    return
                if session_key and session_key in tasks:
                    try:
                        await tasks[session_key]
                    except Exception:
                        logger.exception("gateway follow-up session task failed")
                await asyncio.sleep(0.05)
            return

        deadline = asyncio.get_event_loop().time() + 840
        while getattr(self._adapter, "_active_sessions", {}):
            if asyncio.get_event_loop().time() >= deadline:
                raise TimeoutError("gateway session still active after timeout")
            await asyncio.sleep(0.05)


_RUNTIME: Optional[GatewayRuntime] = None
_RUNTIME_LOCK = threading.Lock()


def get_gateway_runtime(hermes_home: str) -> GatewayRuntime:
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            _RUNTIME = GatewayRuntime(hermes_home)
        return _RUNTIME


def reset_gateway_runtime_for_tests() -> None:
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is not None:
            try:
                with _RUNTIME._lock:
                    _RUNTIME._hard_reset_locked()
            except Exception:
                pass
        _RUNTIME = None
