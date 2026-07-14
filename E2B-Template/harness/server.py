"""Private Worker -> Hermes HTTP handoff for one FromDonna E2B sandbox.

Each sandbox belongs to exactly one person.  The harness therefore owns one
Hermes conversation, persists its id under that sandbox's ``~/.hermes``, and
serializes turns before invoking the normal Hermes chat CLI.

Secrets policy:
- No Telegram / Codex / provider credentials live here.
- Worker authenticates with a shared harness secret (injected once via
  /bootstrap because template warm-start freezes process env at image-build
  time).
- Per-turn LLM access is only a short-lived capability token that Hermes sends
  as OPENAI_API_KEY to the existing FromDonna LLM proxy Worker. Real provider
  credentials stay on Cloudflare / the Codex relay.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import secrets
import sqlite3
import stat
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Annotated, Iterator, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

app = FastAPI()
HOME = Path.home()
HERMES_HOME = HOME / ".hermes"
HERMES_BINARY = "/home/user/venv/bin/hermes"
HERMES_MODEL = "gpt-5.6-terra"
LLM_PROXY_BASE_URL = os.environ.get(
    "FROMDONNA_LLM_PROXY_BASE_URL",
    "https://fromdonna-llm-proxy.code-df4.workers.dev/v1",
)
SESSION_STATE_FILENAME = "fromdonna-session.json"
TURN_LOCK_FILENAME = "fromdonna-turn.lock"
ACTION_DIRECTORY_NAME = "fromdonna-turn-actions"
ACTION_FILE_ENV = "FROMDONNA_ACTIONS_FILE"
MAX_ACTION_FILE_BYTES = 1_000_000
MAX_ACTIONS_PER_TURN = 50

# Populated either from create-time env (if process is restarted) or /bootstrap.
_state_lock = threading.Lock()
_turn_lock = threading.Lock()
_worker_secret: str | None = os.environ.get("WORKER_TO_HARNESS_SECRET") or None


class ReplyContext(BaseModel):
    """Channel-neutral context for the message this event replies to."""

    messageId: str | None = None
    text: str | None = None


class ArtifactDescriptor(BaseModel):
    """A Worker-addressable artifact, never a channel-specific file id."""

    model_config = ConfigDict(extra="allow")

    uri: str | None = None
    name: str | None = None
    mimeType: str | None = None


class Attachment(ArtifactDescriptor):
    """An inbound artifact associated with the user event."""

    type: str = "file"
    caption: str | None = None


class CallbackContext(BaseModel):
    """A callback/button event without any Telegram-specific fields."""

    id: str | None = None
    data: str | None = None
    messageId: str | None = None


class InboundEvent(BaseModel):
    """The transport-neutral representation of one inbound user event."""

    text: str = ""
    reply: ReplyContext | None = None
    attachments: list[Attachment] = Field(default_factory=list)
    callback: CallbackContext | None = None

    def has_content(self) -> bool:
        return bool(
            self.text.strip()
            or self.reply is not None
            or self.attachments
            or self.callback is not None
        )


class Turn(BaseModel):
    """Turn envelope.

    ``text`` and the gateway fields remain accepted for the current Worker while
    it migrates. New callers should send ``event`` and need not expose channel
    metadata to the sandbox.
    """

    event: InboundEvent | None = None
    text: str | None = None
    userId: str | None = None
    gateway: str | None = None
    gatewayChatId: str | None = None
    gatewayMessageId: str | None = None

    def normalized_event(self) -> InboundEvent:
        if self.event is None:
            return InboundEvent(text=self.text or "")
        if not self.event.text and self.text:
            # Accept mixed old/new payloads during the Worker migration without
            # dropping the legacy text value.
            return self.event.model_copy(update={"text": self.text})
        return self.event


class InlineButton(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    text: str = Field(min_length=1, max_length=128)
    callbackData: str | None = Field(default=None, max_length=256)
    url: str | None = Field(default=None, max_length=2048)


class OutboundArtifactDescriptor(BaseModel):
    """A deliberately small Worker-addressable outbound artifact reference."""

    model_config = ConfigDict(extra="forbid", strict=True)

    uri: str = Field(min_length=1, max_length=2048)
    name: str | None = Field(default=None, max_length=255)
    mimeType: str | None = Field(default=None, max_length=255)


class SendMessageAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["sendMessage"] = "sendMessage"
    text: str = Field(min_length=1, max_length=16_000)


class SendMediaAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["sendMedia"] = "sendMedia"
    artifact: OutboundArtifactDescriptor
    caption: str | None = Field(default=None, max_length=4096)


class InlineButtonsAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["inlineButtons"] = "inlineButtons"
    buttons: list[list[InlineButton]] = Field(min_length=1, max_length=16)
    targetActionIndex: int | None = Field(default=None, ge=0, le=49)


OutboundAction = Annotated[
    SendMessageAction | SendMediaAction | InlineButtonsAction,
    Field(discriminator="type"),
]


class TurnResponse(BaseModel):
    """Worker-renderable response. ``text`` remains as a legacy convenience."""

    actions: list[OutboundAction] = Field(default_factory=list)
    text: str = ""
    sessionId: str | None = None


def _session_state_path() -> Path:
    return HERMES_HOME / SESSION_STATE_FILENAME


def _turn_lock_path() -> Path:
    return HERMES_HOME / TURN_LOCK_FILENAME


def _action_directory() -> Path:
    """Return the owner-only directory used for one-shot action files."""
    directory = HERMES_HOME / ACTION_DIRECTORY_NAME
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    details = directory.lstat()
    if (
        not stat.S_ISDIR(details.st_mode)
        or details.st_uid != os.getuid()
        or details.st_mode & 0o077
    ):
        raise RuntimeError("action directory is not private")
    return directory


@contextlib.contextmanager
def _request_action_file() -> Iterator[Path]:
    """Create an unguessable, private action file for exactly one child turn."""
    directory = _action_directory()
    fd, raw_path = tempfile.mkstemp(prefix="turn-", suffix=".jsonl", dir=directory)
    path = Path(raw_path)
    try:
        os.fchmod(fd, 0o600)
        os.close(fd)
        yield path
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def _validate_action(raw: object) -> OutboundAction:
    """Validate the plugin's untrusted JSONL payload before it reaches Worker."""
    if not isinstance(raw, dict):
        raise ValueError("action must be an object")
    action_type = raw.get("type")
    if action_type == "sendMessage":
        action: OutboundAction = SendMessageAction.model_validate(raw, strict=True)
    elif action_type == "sendMedia":
        media = SendMediaAction.model_validate(raw, strict=True)
        parsed = urlparse(media.artifact.uri)
        if parsed.scheme not in {"r2", "https"} or not parsed.netloc:
            raise ValueError("outbound artifact URI must be r2:// or https://")
        action = media
    elif action_type == "inlineButtons":
        buttons = InlineButtonsAction.model_validate(raw, strict=True)
        if sum(len(row) for row in buttons.buttons) > 100 or any(not row or len(row) > 16 for row in buttons.buttons):
            raise ValueError("invalid inline button layout")
        for row in buttons.buttons:
            for button in row:
                has_callback = bool(button.callbackData)
                has_url = bool(button.url)
                if has_callback == has_url:
                    raise ValueError("each button needs exactly one callbackData or URL")
                if button.url:
                    parsed = urlparse(button.url)
                    if parsed.scheme != "https" or not parsed.netloc:
                        raise ValueError("button URL must be HTTPS")
        action = buttons
    else:
        raise ValueError("unknown action type")
    return action


def _collect_actions(path: Path) -> list[OutboundAction]:
    """Read the child-only action file through a checked descriptor, not a path."""
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ValueError("action file is unavailable") from exc
    try:
        details = os.fstat(fd)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_mode & 0o077
            or details.st_nlink != 1
            or details.st_size > MAX_ACTION_FILE_BYTES
        ):
            raise ValueError("action file failed safety checks")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            payload = handle.read(MAX_ACTION_FILE_BYTES + 1)
        if len(payload) > MAX_ACTION_FILE_BYTES:
            raise ValueError("action file is too large")
    finally:
        os.close(fd)

    actions: list[OutboundAction] = []
    for raw_line in payload.splitlines():
        if not raw_line.strip():
            continue
        if len(raw_line) > 32_768:
            raise ValueError("action is too large")
        try:
            raw = json.loads(raw_line)
            action = _validate_action(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError("invalid recorded action") from exc
        actions.append(action)
        if len(actions) > MAX_ACTIONS_PER_TURN:
            raise ValueError("too many recorded actions")
    return actions


def _authorized(authorization: str | None) -> bool:
    with _state_lock:
        expected = _worker_secret
    supplied = authorization or ""
    return bool(expected) and secrets.compare_digest(supplied, f"Bearer {expected}")


def _valid_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 256 or any(character.isspace() for character in value):
        return None
    return value


def _load_session_id() -> str | None:
    try:
        raw = json.loads(_session_state_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return _valid_session_id(raw.get("sessionId") if isinstance(raw, dict) else None)


def _persist_session_id(session_id: str) -> None:
    """Atomically persist only the stable Hermes session id with owner-only mode."""
    session_id = _valid_session_id(session_id) or ""
    if not session_id:
        raise ValueError("invalid session id")

    HERMES_HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = _session_state_path()
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{SESSION_STATE_FILENAME}.",
        suffix=".tmp",
        dir=HERMES_HOME,
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "sessionId": session_id}, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)
        raise


@contextlib.contextmanager
def _serialized_turns():
    """Serialize harness threads and separate uvicorn workers/processes."""
    HERMES_HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    with _turn_lock:
        fd = os.open(_turn_lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def _sessions(*, source: str | None = None) -> list[str]:
    """Read Hermes' public session index without mutating it.

    Hermes owns the database schema. The harness only needs the documented
    ``sessions.id``, ``sessions.source``, and ``sessions.started_at`` columns to
    discover the first normal ``hermes chat --query`` session.
    """
    db_path = HERMES_HOME / "state.db"
    if not db_path.exists():
        return []
    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
            if source is None:
                rows = db.execute(
                    "SELECT id FROM sessions ORDER BY started_at DESC, rowid DESC"
                ).fetchall()
            else:
                rows = db.execute(
                    "SELECT id FROM sessions WHERE source = ? "
                    "ORDER BY started_at DESC, rowid DESC",
                    (source,),
                ).fetchall()
    except sqlite3.Error:
        return []
    return [str(row[0]) for row in rows if _valid_session_id(row[0])]


def _recover_prior_session() -> str | None:
    """Recover a marker lost during an upgrade without selecting another source."""
    sessions = _sessions(source="fromdonna")
    if not sessions:
        return None
    session_id = sessions[0]
    _persist_session_id(session_id)
    return session_id


def _agent_prompt(event: InboundEvent) -> str:
    """Represent non-text transport data to Hermes without leaking a channel API."""
    context: dict[str, object] = {}
    if event.reply is not None:
        context["reply"] = event.reply.model_dump(exclude_none=True)
    if event.attachments:
        context["attachments"] = [
            attachment.model_dump(exclude_none=True) for attachment in event.attachments
        ]
    if event.callback is not None:
        context["callback"] = event.callback.model_dump(exclude_none=True)

    if not context:
        return event.text
    metadata = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if event.text:
        return f"{event.text}\n\n[Associated event context]\n{metadata}"
    return f"[Associated event context]\n{metadata}"


def _hermes_command(prompt: str, session_id: str | None) -> list[str]:
    command = [
        HERMES_BINARY,
        "chat",
        "--query",
        prompt,
        "--quiet",
        "--provider",
        "custom",
        "--model",
        HERMES_MODEL,
        "--source",
        "fromdonna",
    ]
    if session_id:
        # Do not use --continue: this is an explicit persisted session id.
        command.extend(["--resume", session_id])
    return command


def _invoke_hermes(
    prompt: str,
    capability: str,
    session_id: str | None,
    action_file: Path,
) -> subprocess.CompletedProcess[str]:
    """Run one non-interactive Hermes chat turn using the persisted session."""
    env = os.environ | {
        "HERMES_HOME": str(HERMES_HOME),
        # The named custom provider resolves only this per-turn capability;
        # never route it through OPENAI_API_KEY to a non-OpenAI host.
        "FROMDONNA_LLM_CAPABILITY": capability,
        # The template-packaged plugin can only record actions in this fresh,
        # harness-selected file. It contains no recipient or channel secrets.
        ACTION_FILE_ENV: str(action_file),
    }
    return subprocess.run(
        _hermes_command(prompt, session_id),
        cwd=str(HOME / "workspace"),
        env=env,
        text=True,
        capture_output=True,
        timeout=840,
        check=False,
    )


def _new_session_since(before: set[str]) -> str | None:
    # The source tag makes recovery deterministic. The all-session fallback
    # keeps first-turn persistence working on older Hermes builds that omit it.
    for candidates in (_sessions(source="fromdonna"), _sessions()):
        for session_id in candidates:
            if session_id not in before:
                return session_id
    return None


def _clean_stdout(stdout: str, session_id: str | None) -> str:
    """Do not expose the CLI's quiet-mode session footer as a user message."""
    text = stdout.strip()
    if not session_id or not text:
        return text
    lines = []
    for line in text.splitlines():
        compact = line.strip()
        if compact in {f"Session ID: {session_id}", f"Session: {session_id}"}:
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def _run_turn(event: InboundEvent, capability: str) -> tuple[str, str | None, list[OutboundAction]]:
    """Run an ordered turn and return its text, session id, and emitted actions."""
    with _serialized_turns():
        session_id = _load_session_id() or _recover_prior_session()
        before = set(_sessions()) if session_id is None else set()
        try:
            with _request_action_file() as action_file:
                try:
                    completed = _invoke_hermes(
                        _agent_prompt(event), capability, session_id, action_file
                    )
                except subprocess.TimeoutExpired as exc:
                    raise HTTPException(status_code=504, detail="agent_turn_timed_out") from exc

                if completed.returncode != 0:
                    # Do not return stderr: it can contain runtime details.
                    raise HTTPException(status_code=502, detail="agent_turn_failed")
                try:
                    actions = _collect_actions(action_file)
                except ValueError as exc:
                    raise HTTPException(status_code=502, detail="agent_actions_invalid") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail="agent_actions_unavailable") from exc

        if session_id is None:
            session_id = _new_session_since(before)
            if session_id is None:
                # Never silently fall back to --continue: preserving the exact
                # one-user conversation is more important than a partial reply.
                raise HTTPException(status_code=502, detail="agent_session_not_persisted")
            _persist_session_id(session_id)

        return _clean_stdout(completed.stdout, session_id), session_id, actions


def _response(
    text: str,
    session_id: str | None,
    emitted_actions: list[OutboundAction] | None = None,
) -> TurnResponse:
    """Keep final text and tool actions together; Worker renders actions once."""
    actions = list(emitted_actions or [])
    # A model commonly calls the deliberate send-message tool and then repeats
    # the same sentence as its ordinary final response. Keep that final text
    # for legacy callers, but never ask the Worker to send it twice.
    if text and not any(
        isinstance(action, SendMessageAction) and action.text == text for action in actions
    ):
        actions.append(SendMessageAction(text=text))
    return TurnResponse(actions=actions, text=text, sessionId=session_id)


@app.get("/health")
def health():
    with _state_lock:
        ready = bool(_worker_secret)
    return {"ok": True, "service": "fromdonna-harness", "auth_ready": ready}


class Bootstrap(BaseModel):
    secret: str = Field(min_length=16, max_length=256)


@app.post("/bootstrap")
def bootstrap(body: Bootstrap):
    """One-time auth setup after sandbox create. Template warm-start cannot see create envVars."""
    global _worker_secret
    secret = body.secret.strip()
    if len(secret) < 16:
        raise HTTPException(status_code=400, detail="invalid_secret")
    with _state_lock:
        if _worker_secret is not None:
            # Idempotent if the same secret is re-sent; reject secret rotation attempts.
            if secrets.compare_digest(_worker_secret, secret):
                return {"ok": True, "already": True}
            raise HTTPException(status_code=409, detail="already_bootstrapped")
        _worker_secret = secret
    return {"ok": True, "already": False}


@app.post("/turn", response_model=TurnResponse)
def turn(
    turn: Turn,
    authorization: str | None = Header(default=None),
    x_llm_capability: str | None = Header(default=None),
):
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="unauthorized")

    event = turn.normalized_event()
    if not event.has_content():
        return _response("", _load_session_id())
    if not x_llm_capability or not x_llm_capability.strip():
        raise HTTPException(status_code=401, detail="missing_llm_capability")

    text, session_id, actions = _run_turn(event, x_llm_capability.strip())
    return _response(text, session_id, actions)
