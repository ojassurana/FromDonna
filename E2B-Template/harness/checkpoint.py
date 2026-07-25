"""Channel-agnostic runtime checkpoint pack/upload/restore for FromDonna.

Packs filtered agent-home (~/.hermes) + workspace into a gzip tar and uploads
to the Worker (R2). Used when a runtime is replaced — not for normal E2B pause.

Secrets (keys, .env, auth.json, capability tokens) are never included.
"""
from __future__ import annotations

import contextlib
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger("fromdonna.checkpoint")

HOME = Path.home()
HERMES_HOME = HOME / ".hermes"
WORKSPACE = HOME / "workspace"

# Hard cap aligned with Worker MAX_CHECKPOINT_BYTES
MAX_CHECKPOINT_BYTES = 40 * 1024 * 1024

# Directory / file name components to skip under agent-home
_EXCLUDED_DIR_NAMES = frozenset({
    "node_modules",
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
    ".cache",
    "cache",
    "checkpoints",
    "backups",
    "state-snapshots",
    ".git",
    "fromdonna-turn-actions",
    "browser_screenshots",
    "image_cache",
    "audio_cache",
    "document_cache",
})

_EXCLUDED_FILE_NAMES = frozenset({
    ".env",
    "auth.json",
    "gateway.pid",
    "cron.pid",
    "gateway.lock",
    "fromdonna-turn.lock",
    "processes.json",
    "gateway_state.json",  # machine-local runtime; recreated on start
    "fromdonna-checkpoint-latest.tar.gz",
    "fromdonna-checkpoint-ready.json",
    "fromdonna-checkpoint-packing.json",
    "fromdonna-checkpoint-failed.json",
})

_EXCLUDED_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".db-wal",
    ".db-shm",
    ".db-journal",
)

_upload_lock = threading.Lock()
_last_upload_error: Optional[str] = None

_LATEST_NAME = "fromdonna-checkpoint-latest.tar.gz"
_READY_NAME = "fromdonna-checkpoint-ready.json"
_PACKING_NAME = "fromdonna-checkpoint-packing.json"
_FAILED_NAME = "fromdonna-checkpoint-failed.json"


def _worker_base_url() -> Optional[str]:
    explicit = (os.environ.get("FROMDONNA_WORKER_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    # Derive from Bot API proxy base when bootstrap configured it.
    bot = (os.environ.get("FROMDONNA_TELEGRAM_BASE_URL") or "").strip()
    if "/telegram-bot-api/" in bot:
        return bot.split("/telegram-bot-api/", 1)[0].rstrip("/")
    return None


def _harness_secret() -> Optional[str]:
    return (os.environ.get("WORKER_TO_HARNESS_SECRET") or "").strip() or None


def _user_id() -> Optional[str]:
    return (os.environ.get("FROMDONNA_USER_ID") or "").strip() or None


def _should_skip(rel: Path) -> bool:
    parts = rel.parts
    for part in parts:
        if part in _EXCLUDED_DIR_NAMES:
            return True
    name = rel.name
    if name in _EXCLUDED_FILE_NAMES:
        return True
    if name.endswith(_EXCLUDED_SUFFIXES):
        return True
    # Never pack capability / proxy material if dropped on disk by mistake.
    lower = name.lower()
    if lower.endswith(".pem") or lower.endswith(".key"):
        return True
    if "token" in lower and name.endswith((".json", ".txt", ".env")):
        return True
    return False


def _snapshot_sqlite(src: Path, dest: Path) -> bool:
    """Consistent copy of a SQLite DB via backup API (ignores live WAL)."""
    if not src.is_file():
        return False
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as src_db:
            with sqlite3.connect(dest) as dst_db:
                src_db.backup(dst_db)
        return True
    except sqlite3.Error as exc:
        logger.warning("sqlite snapshot failed for %s: %s", src, exc)
        return False


def build_checkpoint_archive(dest: Path) -> int:
    """Write a filtered tar.gz of agent-home + workspace to *dest*. Returns size."""
    with tempfile.TemporaryDirectory(prefix="fromdonna-ckpt-") as tmp:
        root = Path(tmp)
        agent_staging = root / "agent-home"
        workspace_staging = root / "workspace"
        agent_staging.mkdir(parents=True)
        workspace_staging.mkdir(parents=True)

        hermes = Path(os.environ.get("HERMES_HOME") or HERMES_HOME)
        workspace = hermes.parent / "workspace"

        # Agent home — selective copy
        if hermes.is_dir():
            for path in hermes.rglob("*"):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    rel = path.relative_to(hermes)
                except ValueError:
                    continue
                if _should_skip(rel):
                    continue
                target = agent_staging / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                # Prefer consistent DB snapshot for *.db
                if path.suffix == ".db":
                    if not _snapshot_sqlite(path, target):
                        shutil.copy2(path, target)
                else:
                    shutil.copy2(path, target)

        # Workspace — copy tree minus junk
        if workspace.is_dir():
            for path in workspace.rglob("*"):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    rel = path.relative_to(workspace)
                except ValueError:
                    continue
                if _should_skip(rel):
                    continue
                target = workspace_staging / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)

        # Create tar.gz from staging root (paths: agent-home/..., workspace/...)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        subprocess.run(
            ["tar", "-czf", str(dest), "-C", str(root), "agent-home", "workspace"],
            check=True,
            capture_output=True,
        )
        size = dest.stat().st_size
        if size > MAX_CHECKPOINT_BYTES:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"checkpoint_too_large:{size}")
        return size


def restore_checkpoint_archive(archive: Path, *, hermes_home: Optional[Path] = None) -> None:
    """Extract checkpoint tar.gz into the live user home."""
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    # Workspace is sibling of ~/.hermes under the same home root.
    workspace = hermes.parent / "workspace"

    with tempfile.TemporaryDirectory(prefix="fromdonna-restore-") as tmp:
        root = Path(tmp)
        subprocess.run(
            ["tar", "-xzf", str(archive), "-C", str(root)],
            check=True,
            capture_output=True,
        )
        staged_home = root / "agent-home"
        staged_ws = root / "workspace"

        if staged_home.is_dir():
            hermes.mkdir(parents=True, exist_ok=True)
            # Overlay files from staging into hermes home
            for path in staged_home.rglob("*"):
                if not path.is_file():
                    continue
                rel = path.relative_to(staged_home)
                if _should_skip(rel):
                    continue
                target = hermes / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)

        if staged_ws.is_dir():
            workspace.mkdir(parents=True, exist_ok=True)
            for path in staged_ws.rglob("*"):
                if not path.is_file():
                    continue
                rel = path.relative_to(staged_ws)
                if _should_skip(rel):
                    continue
                target = workspace / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)

        # Ensure workspace exists even if empty in archive
        workspace.mkdir(parents=True, exist_ok=True)
        hermes.mkdir(parents=True, exist_ok=True)


# Local staging for Worker-pull (sandbox→Worker HTTPS is often blocked by CF 1010).
# State machine: idle → packing → ready | failed. Worker polls GET status, then export.


def latest_archive_path(hermes_home: Optional[Path] = None) -> Path:
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    return hermes / _LATEST_NAME


def ready_marker_path(hermes_home: Optional[Path] = None) -> Path:
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    return hermes / _READY_NAME


def packing_marker_path(hermes_home: Optional[Path] = None) -> Path:
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    return hermes / _PACKING_NAME


def failed_marker_path(hermes_home: Optional[Path] = None) -> Path:
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    return hermes / _FAILED_NAME


def mark_checkpoint_packing(*, source: str = "turn", hermes_home: Optional[Path] = None) -> None:
    """Signal that a pack is about to start (Worker can wait instead of spinning)."""
    import json
    import time

    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    hermes.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        failed_marker_path(hermes).unlink()
    with contextlib.suppress(OSError):
        ready_marker_path(hermes).unlink()
    packing_marker_path(hermes).write_text(
        json.dumps({"state": "packing", "source": source, "startedAt": time.time()}) + "\n",
        encoding="utf-8",
    )


def mark_checkpoint_failed(error: str, *, hermes_home: Optional[Path] = None) -> None:
    """Signal pack failure so Worker can stop polling early."""
    import json
    import time

    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    hermes.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        packing_marker_path(hermes).unlink()
    # Drop incomplete/stale archive so it cannot be mistaken for a fresh pack.
    with contextlib.suppress(OSError):
        latest_archive_path(hermes).unlink()
    failed_marker_path(hermes).write_text(
        json.dumps(
            {
                "state": "failed",
                "error": (error or "pack_failed")[:500],
                "failedAt": time.time(),
                "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        + "\n",
        encoding="utf-8",
    )


def local_checkpoint_status(*, hermes_home: Optional[Path] = None) -> dict:
    """Non-consuming status for Worker harvest handshake.

    States: ready | packing | failed | idle

    Ready requires the **ready marker** (not leftover tar alone). Tar left after
    a previous export must not look like a fresh post-session pack — otherwise
    the Worker harvests stale state and may pause mid-turn.
    """
    import json

    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    archive = latest_archive_path(hermes)
    ready = ready_marker_path(hermes)
    packing = packing_marker_path(hermes)
    failed = failed_marker_path(hermes)

    if ready.is_file() and archive.is_file() and archive.stat().st_size > 0:
        meta: dict = {}
        try:
            loaded = json.loads(ready.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, json.JSONDecodeError):
            meta = {}
        return {
            "state": "ready",
            "bytes": int(meta.get("bytes") or archive.stat().st_size),
            "source": meta.get("source"),
            "savedAt": meta.get("savedAt"),
            "readyAt": meta.get("readyAt"),
        }

    if packing.is_file():
        meta = {}
        try:
            loaded = json.loads(packing.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, json.JSONDecodeError):
            meta = {}
        return {
            "state": "packing",
            "source": meta.get("source"),
            "startedAt": meta.get("startedAt"),
        }

    if failed.is_file():
        meta = {}
        try:
            loaded = json.loads(failed.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, json.JSONDecodeError):
            meta = {}
        return {
            "state": "failed",
            "error": meta.get("error") or last_upload_error() or "pack_failed",
            "savedAt": meta.get("savedAt"),
            "failedAt": meta.get("failedAt"),
        }

    # Leftover tar without ready marker = previous export residue, not a new pack.
    out: dict = {"state": "idle"}
    if archive.is_file() and archive.stat().st_size > 0:
        out["staleTar"] = True
        out["staleTarBytes"] = archive.stat().st_size
    if _last_upload_error:
        out["lastError"] = _last_upload_error
    return out


def prepare_local_checkpoint(*, source: str = "turn", hermes_home: Optional[Path] = None) -> dict:
    """Pack checkpoint to a known path under HERMES_HOME for the Worker to pull.

    Sandbox outbound POSTs to workers.dev often fail with Cloudflare error 1010
    (bot fight). Worker→harness already works, so we stage locally and let the
    Worker GET /internal/checkpoint/export.
    """
    import json
    import time

    global _last_upload_error
    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    hermes.mkdir(parents=True, exist_ok=True)
    archive = latest_archive_path(hermes)
    ready = ready_marker_path(hermes)

    with _upload_lock:
        try:
            # Ensure status observers see packing even if caller forgot mark_*.
            if not packing_marker_path(hermes).is_file():
                mark_checkpoint_packing(source=source, hermes_home=hermes)
            size = build_checkpoint_archive(archive)
            meta = {
                "version": 1,
                "readyAt": time.time(),
                "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "bytes": size,
                "source": source,
            }
            ready.write_text(json.dumps(meta) + "\n", encoding="utf-8")
            with contextlib.suppress(OSError):
                packing_marker_path(hermes).unlink()
            with contextlib.suppress(OSError):
                failed_marker_path(hermes).unlink()
            _last_upload_error = None
            logger.info("local checkpoint ready: %s bytes source=%s", size, source)
            return {"ok": True, **meta}
        except Exception as exc:
            _last_upload_error = str(exc)
            logger.warning("local checkpoint prepare failed: %s", exc)
            mark_checkpoint_failed(str(exc), hermes_home=hermes)
            raise


def read_local_checkpoint(*, consume: bool = False, hermes_home: Optional[Path] = None) -> Optional[tuple[bytes, dict]]:
    """Return (tar_bytes, meta) if a **fresh staged** checkpoint exists.

    Requires ready marker + archive. Leftover tar after a prior export is ignored
    so harvest cannot re-upload a previous turn and then pause mid-session.
    Holds the upload lock so we never export a half-written gzip.
    """
    import json

    hermes = Path(hermes_home or os.environ.get("HERMES_HOME") or HERMES_HOME)
    archive = latest_archive_path(hermes)
    ready = ready_marker_path(hermes)

    with _upload_lock:
        if packing_marker_path(hermes).is_file():
            # Pack in progress — refuse partial reads.
            return None
        if not ready.is_file() or not archive.is_file():
            return None
        meta: dict = {}
        try:
            loaded = json.loads(ready.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, json.JSONDecodeError):
            meta = {}
        data = archive.read_bytes()
        if not data:
            return None
        if consume:
            # Fully consume: drop ready + tar so next turn cannot see stale ready.
            with contextlib.suppress(OSError):
                ready.unlink()
            with contextlib.suppress(OSError):
                archive.unlink()
            with contextlib.suppress(OSError):
                packing_marker_path(hermes).unlink()
            with contextlib.suppress(OSError):
                failed_marker_path(hermes).unlink()
        return data, meta


def schedule_checkpoint_upload(**kwargs) -> None:
    """Fire-and-forget local pack after a turn (Worker pulls later)."""

    def _run() -> None:
        try:
            source = kwargs.get("source") or "turn"
            mark_checkpoint_packing(source=str(source))
            result = prepare_local_checkpoint(source=str(source))
            logger.info("checkpoint staged for worker pull: %s", result)
        except Exception as exc:
            logger.warning("checkpoint stage failed: %s", exc)
            # prepare_local_checkpoint already marks failed; keep belt-and-braces.
            with contextlib.suppress(Exception):
                mark_checkpoint_failed(str(exc))

    threading.Thread(target=_run, name="fromdonna-checkpoint", daemon=True).start()


def last_upload_error() -> Optional[str]:
    return _last_upload_error
