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
from dataclasses import dataclass
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

    def configure_proxy(self, proxy: TelegramProxyConfig) -> None:
        self._proxy = proxy

    def start(self) -> None:
        if not self._proxy:
            raise RuntimeError("Telegram proxy config required before starting gateway")
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
        if not self._ready.wait(timeout=120):
            raise RuntimeError("Hermes Telegram gateway failed to start within 120s")
        if self._start_error is not None:
            raise RuntimeError(f"Hermes Telegram gateway failed to start: {self._start_error}") from self._start_error

    def _run_loop(self) -> None:
        os.environ["HERMES_HOME"] = self.hermes_home
        # Single-user sandbox: Worker already authenticated the Telegram user.
        os.environ.setdefault("TELEGRAM_ALLOW_ALL_USERS", "true")
        # Custom base_url points at Worker — do NOT rewrite traffic to Telegram IPs.
        os.environ["HERMES_TELEGRAM_DISABLE_FALLBACK_IPS"] = "1"
        # Never let the adapter open a real Telegram webhook/poll on the shared bot.
        os.environ.pop("TELEGRAM_WEBHOOK_URL", None)
        try:
            from gateway.config import GatewayConfig, Platform, PlatformConfig, load_gateway_config
            from gateway.run import GatewayRunner
            from plugins.platforms.telegram.adapter import TelegramAdapter

            assert self._proxy is not None
            proxy = self._proxy

            try:
                config = load_gateway_config()
            except Exception:
                config = GatewayConfig()

            config.platforms[Platform.TELEGRAM] = PlatformConfig(
                enabled=True,
                token=proxy.token,
                extra={
                    "group_sessions_per_user": True,
                    "allow_all_users": True,
                    # Official PTB/Hermes hook for local Bot API servers — we point at Worker.
                    "base_url": proxy.base_url if proxy.base_url.endswith("/") else proxy.base_url,
                    "base_file_url": proxy.base_file_url if proxy.base_file_url.endswith("/") else proxy.base_file_url,
                },
            )
            for plat in list(config.platforms.keys()):
                if plat != Platform.TELEGRAM:
                    config.platforms[plat].enabled = False

            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)

            self._runner = GatewayRunner(config)
            self._adapter = TelegramAdapter(config.platforms[Platform.TELEGRAM])
            self._adapter.set_message_handler(self._runner._handle_message)
            if hasattr(self._adapter, "set_busy_session_handler") and hasattr(self._runner, "_handle_busy_session"):
                try:
                    self._adapter.set_busy_session_handler(self._runner._handle_busy_session)
                except Exception:
                    pass
            self._runner.adapters[Platform.TELEGRAM] = self._adapter
            self._runner._running = True

            # Skip polling/webhook transport: Worker injects raw Updates.
            # Still run official Application.initialize/start + handlers via connect().
            async def _skip_polling(self_adapter, **_kwargs):  # type: ignore[no-untyped-def]
                logger.info("[%s] FromDonna: skipping Telegram polling (Worker injects updates)", self_adapter.name)
                return True

            self._adapter._start_polling_resilient = _skip_polling.__get__(self._adapter, type(self._adapter))  # type: ignore[method-assign]

            async def _connect() -> None:
                ok = await self._adapter.connect()
                if not ok:
                    raise RuntimeError("TelegramAdapter.connect() returned False")
                # Treat as webhook-like: no polling heartbeat needed against getUpdates.
                self._adapter._webhook_mode = True
                self._adapter._connected = True
                self._adapter._running = True

            self._loop.run_until_complete(_connect())
            self._ready.set()
            self._loop.run_forever()
        except BaseException as exc:  # noqa: BLE001
            self._start_error = exc
            self._ready.set()
            logger.exception("fromdonna gateway runtime failed")

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

            # Snapshot active session tasks before process_update.
            before = set(getattr(self._adapter, "_session_tasks", {}).keys())
            await app.process_update(tg_update)
            await self._wait_for_new_or_active_sessions(before)
            return {"ok": True}

        future = asyncio.run_coroutine_threadsafe(_run(), self._loop)
        return future.result(timeout=840)

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
        _RUNTIME = None
