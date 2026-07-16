"""FromDonna Telegram-only UX helpers (thinking-dots bubble + context reactions).

Pure, testable logic lives here. The Telegram adapter owns Bot API I/O and
wires these helpers into processing start / first real outbound / complete.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Callable, Optional

# Temporary status bubble while the agent turn is in flight.
DOTS_FRAMES: tuple[str, ...] = (".", "..", "...")
DOTS_INTERVAL_SECONDS: float = 0.55
THINKING_DOTS_METADATA_KEY = "fromdonna_thinking_dots"
THINKING_DOTS_STATUS_KEY = "fromdonna_thinking_dots"

# Context reaction set — exclusive; supersedes Hermès lifecycle 👀/👍/👎.
REACTION_EMOJIS: tuple[str, ...] = ("❤️", "🔥", "👍", "😭")
DEFAULT_REACTION_EMOJI = "👍"

# Classifier uses the same FromDonna LLM proxy path as the agent, but only
# the inbound message text (low context) and a tiny max_tokens budget.
CLASSIFIER_SYSTEM_PROMPT = (
    "Pick exactly one emoji reaction for this user message. "
    "Reply with only one of these characters and nothing else: "
    "❤️ 🔥 👍 😭\n"
    "Guide: ❤️ warm/love/thanks/affection; 🔥 exciting/impressive/hype; "
    "👍 neutral/ack/ok/questions/default; 😭 sad/frustrated/pain/sorry."
)
CLASSIFIER_MAX_TOKENS = 8
CLASSIFIER_TIMEOUT_SECONDS = 8.0


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


def constrain_reaction_emoji(raw: Any, *, default: str = DEFAULT_REACTION_EMOJI) -> str:
    """Map an arbitrary model/heuristic result onto the four-emoji allowlist."""
    if raw is None:
        return default if default in REACTION_EMOJIS else DEFAULT_REACTION_EMOJI
    text = str(raw).strip()
    if not text:
        return default if default in REACTION_EMOJIS else DEFAULT_REACTION_EMOJI
    # Prefer exact full-string match, then first allowed emoji found in the text.
    if text in REACTION_EMOJIS:
        return text
    for emoji in REACTION_EMOJIS:
        if emoji in text:
            return emoji
    # Common textual aliases models sometimes emit.
    lowered = text.lower()
    alias_map = {
        "heart": "❤️",
        "love": "❤️",
        "red_heart": "❤️",
        "fire": "🔥",
        "lit": "🔥",
        "thumbsup": "👍",
        "thumbs_up": "👍",
        "+1": "👍",
        "ok": "👍",
        "cry": "😭",
        "sad": "😭",
        "sob": "😭",
    }
    for key, emoji in alias_map.items():
        if key in lowered:
            return emoji
    return default if default in REACTION_EMOJIS else DEFAULT_REACTION_EMOJI


def heuristic_reaction_emoji(message_text: str) -> str:
    """Deterministic low-context fallback when the classifier call fails."""
    text = (message_text or "").strip().lower()
    if not text:
        return DEFAULT_REACTION_EMOJI

    love = (
        "love", "❤️", "❤", "♥️", "thank", "thanks", "ty", "appreciate",
        "miss you", "hug", "cute", "sweet", "adorable", "beautiful",
    )
    fire = (
        "fire", "🔥", "lit", "awesome", "amazing", "incredible", "legendary",
        "hype", "goated", "insane", "crushing it", "let's go", "lets go", "💪",
    )
    sad = (
        "😭", "😢", "sad", "sorry", "upset", "depressed", "lonely", "hurt",
        "pain", "cry", "crying", "missed", "failed", "fail", "broken", "hate",
        "angry", "mad", "frustrated", "terrible", "awful", "devastated",
    )
    if any(k in text for k in love):
        return "❤️"
    if any(k in text for k in fire):
        return "🔥"
    if any(k in text for k in sad):
        return "😭"
    return DEFAULT_REACTION_EMOJI


def parse_classifier_response(content: Any) -> str:
    """Extract one allowed reaction from a chat-completion content string."""
    return constrain_reaction_emoji(content)


def _llm_proxy_base_url() -> str:
    return (
        os.environ.get("FROMDONNA_LLM_PROXY_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("OPENAI_API_BASE")
        or "https://fromdonna-llm-proxy.code-df4.workers.dev/v1"
    ).rstrip("/")


def _llm_api_key() -> str:
    return (
        os.environ.get("FROMDONNA_LLM_CAPABILITY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    ).strip()


def _classifier_model() -> str:
    return (
        os.environ.get("FROMDONNA_REACTION_MODEL")
        or os.environ.get("HERMES_MODEL")
        or "grok-4.5"
    ).strip() or "grok-4.5"


def _post_chat_completion(
    *,
    base_url: str,
    api_key: str,
    model: str,
    user_text: str,
    timeout: float = CLASSIFIER_TIMEOUT_SECONDS,
) -> str:
    """Synchronous OpenAI-compatible chat completion (tiny classifier)."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": CLASSIFIER_SYSTEM_PROMPT},
            {"role": "user", "content": (user_text or "")[:500]},
        ],
        "max_tokens": CLASSIFIER_MAX_TOKENS,
        "temperature": 0,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    choices = payload.get("choices") or []
    if not choices:
        raise ValueError("classifier returned no choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if content is None:
        raise ValueError("classifier returned empty content")
    return str(content)


def classify_reaction_emoji(
    message_text: str,
    *,
    llm_call: Optional[Callable[[str], str]] = None,
) -> str:
    """Pick one of ❤️🔥👍😭 for *message_text*.

    ``llm_call`` is injectable for tests. When omitted, a low-context
    chat-completion call is attempted; any failure falls back to heuristics.
    """
    text = message_text or ""
    try:
        if llm_call is not None:
            raw = llm_call(text)
        else:
            api_key = _llm_api_key()
            if not api_key:
                raise RuntimeError("no_llm_credential")
            raw = _post_chat_completion(
                base_url=_llm_proxy_base_url(),
                api_key=api_key,
                model=_classifier_model(),
                user_text=text,
            )
        return parse_classifier_response(raw)
    except Exception:
        return heuristic_reaction_emoji(text)


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
    "CLASSIFIER_SYSTEM_PROMPT",
    "DEFAULT_REACTION_EMOJI",
    "DOTS_FRAMES",
    "DOTS_INTERVAL_SECONDS",
    "REACTION_EMOJIS",
    "THINKING_DOTS_METADATA_KEY",
    "THINKING_DOTS_STATUS_KEY",
    "classify_reaction_emoji",
    "constrain_reaction_emoji",
    "dots_sequence",
    "heuristic_reaction_emoji",
    "is_thinking_dots_metadata",
    "next_dots_frame",
    "parse_classifier_response",
    "should_clear_thinking_dots_on_outbound",
]
