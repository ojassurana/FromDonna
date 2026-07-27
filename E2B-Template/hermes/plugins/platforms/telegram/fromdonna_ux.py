"""FromDonna Telegram thinking-dots bubble helpers.

Pure, testable logic lives here. The Telegram adapter owns Bot API I/O and
wires these helpers into processing start / first real outbound / complete.

Modes (adapter chooses at runtime):
- **draft** — Bot API ``sendMessageDraft`` with animated ``.`` → ``..`` → ``...``
  (DM-only; ephemeral; same ``draft_id`` animates client-side).
- **message** — real silent status message + ``editMessageText`` loop, deleted
  when the first real assistant reply lands (works in groups too).

Both paths are scheduled with ``asyncio.create_task`` so they never block the
agent main runtime.
"""
from __future__ import annotations

import re
from typing import Any, Optional

# Temporary status bubble while the agent turn is in flight.
# Frames stay the product-requested ". → .. → ..." cycle.
DOTS_FRAMES: tuple[str, ...] = (".", "..", "...")
# Snappy first phase: full cycle ~0.45s when API is local; real feel is
# interval-only because the adapter pipelines sleep || edit (not sleep+edit).
# Telegram allows short bursts faster than 1 edit/s; we back off on flood.
DOTS_INTERVAL_SECONDS: float = 0.15
# After DOTS_SLOW_AFTER_SECONDS of animating, drop to this interval so long
# agent turns do not burn Bot API quota / trip flood control.
DOTS_SLOW_INTERVAL_SECONDS: float = 0.40
DOTS_SLOW_AFTER_SECONDS: float = 20.0
# Stop issuing edits after this many seconds; leave a static "..." until the
# real reply clears the bubble. Caps worst-case API cost per turn.
DOTS_MAX_ANIMATE_SECONDS: float = 90.0
THINKING_DOTS_METADATA_KEY = "fromdonna_thinking_dots"
THINKING_DOTS_STATUS_KEY = "fromdonna_thinking_dots"


def next_dots_frame(index: int) -> tuple[str, int]:
    """Return (frame_text, next_index) for the thinking-dots cycle."""
    if not DOTS_FRAMES:
        return ".", 0
    i = int(index) % len(DOTS_FRAMES)
    return DOTS_FRAMES[i], (i + 1) % len(DOTS_FRAMES)


def dots_sequence(length: int = 6) -> list[str]:
    """Generate ``length`` frames of the dots cycle starting at ``.``."""
    out: list[str] = []
    idx = 0
    for _ in range(max(0, int(length))):
        frame, idx = next_dots_frame(idx)
        out.append(frame)
    return out


def dots_edit_interval(elapsed_seconds: float) -> Optional[float]:
    """Return sleep seconds before the next edit, or ``None`` to freeze.

    Adaptive schedule used by the adapter animate loop:
    - fast for the first ~10s (feels snappy)
    - slow after that (long tool runs)
    - ``None`` after the max animate window (static final frame, zero API)
    """
    try:
        elapsed = float(elapsed_seconds)
    except (TypeError, ValueError):
        elapsed = 0.0
    if elapsed < 0:
        elapsed = 0.0
    if elapsed >= DOTS_MAX_ANIMATE_SECONDS:
        return None
    if elapsed >= DOTS_SLOW_AFTER_SECONDS:
        return DOTS_SLOW_INTERVAL_SECONDS
    return DOTS_INTERVAL_SECONDS


def dots_retry_after_seconds(exc: BaseException, *, default: float = 1.0) -> float:
    """Extract Telegram flood ``retry_after`` from an exception when present."""
    retry = getattr(exc, "retry_after", None)
    if retry is None:
        cause = getattr(exc, "__cause__", None)
        retry = getattr(cause, "retry_after", None) if cause is not None else None
    if retry is not None:
        try:
            return max(0.1, float(retry))
        except (TypeError, ValueError):
            pass
    text = str(exc).lower()
    if "retry after" in text:
        m = re.search(r"retry after\s+(\d+(?:\.\d+)?)", text)
        if m:
            try:
                return max(0.1, float(m.group(1)))
            except ValueError:
                pass
    try:
        return max(0.1, float(default))
    except (TypeError, ValueError):
        return 1.0


def thinking_draft_id(*, chat_id: str, message_id: Optional[str] = None) -> int:
    """Stable non-zero draft_id for one inbound turn (Bot API requires != 0)."""
    mid = (message_id or "").strip()
    if mid:
        try:
            n = abs(int(mid)) % (2**31 - 1)
            if n:
                return n
        except (TypeError, ValueError):
            pass
    # Stable hash fallback for non-numeric ids.
    material = f"{chat_id}:{mid}".encode("utf-8", errors="ignore")
    h = 0
    for b in material:
        h = (h * 131 + b) & 0x7FFFFFFF
    return h or 1


def is_thinking_dots_metadata(metadata: Optional[dict]) -> bool:
    """True when this outbound send is the FromDonna thinking-dots bubble."""
    if not metadata:
        return False
    return bool(metadata.get(THINKING_DOTS_METADATA_KEY))


def should_clear_thinking_dots_on_outbound(
    *,
    success: bool,
    metadata: Optional[dict],
) -> bool:
    """Real assistant outbound (not the dots bubble itself) clears the bubble."""
    return bool(success) and not is_thinking_dots_metadata(metadata)


__all__ = [
    "DOTS_FRAMES",
    "DOTS_INTERVAL_SECONDS",
    "DOTS_MAX_ANIMATE_SECONDS",
    "DOTS_SLOW_AFTER_SECONDS",
    "DOTS_SLOW_INTERVAL_SECONDS",
    "THINKING_DOTS_METADATA_KEY",
    "THINKING_DOTS_STATUS_KEY",
    "dots_edit_interval",
    "dots_retry_after_seconds",
    "dots_sequence",
    "is_thinking_dots_metadata",
    "next_dots_frame",
    "should_clear_thinking_dots_on_outbound",
    "thinking_draft_id",
]
