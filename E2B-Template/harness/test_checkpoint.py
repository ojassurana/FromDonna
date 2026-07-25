"""Unit tests for channel-agnostic runtime checkpoint pack/restore."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import checkpoint as ckpt


def test_pack_restore_roundtrip(tmp_path, monkeypatch):
    home = tmp_path / "user"
    hermes = home / ".hermes"
    workspace = home / "workspace"
    hermes.mkdir(parents=True)
    workspace.mkdir(parents=True)

    (hermes / "config.yaml").write_text("model: test\n", encoding="utf-8")
    memories = hermes / "memories"
    memories.mkdir()
    (memories / "MEMORY.md").write_text("remember this\n", encoding="utf-8")
    (hermes / ".env").write_text("SECRET=should-not-pack\n", encoding="utf-8")
    (hermes / "auth.json").write_text('{"token":"nope"}\n', encoding="utf-8")
    cache = hermes / "cache"
    cache.mkdir()
    (cache / "junk.bin").write_bytes(b"\x00\x01")
    (workspace / "notes.txt").write_text("workspace file\n", encoding="utf-8")

    db_path = hermes / "state.db"
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
        db.execute("INSERT INTO sessions (id) VALUES ('s1')")

    monkeypatch.setenv("HERMES_HOME", str(hermes))
    archive = tmp_path / "ckpt.tar.gz"
    size = ckpt.build_checkpoint_archive(archive)
    assert size > 0
    assert archive.is_file()

    # Restore into a clean home
    dest_home = tmp_path / "restored"
    dest_hermes = dest_home / ".hermes"
    dest_ws = dest_home / "workspace"
    dest_hermes.mkdir(parents=True)
    ckpt.restore_checkpoint_archive(archive, hermes_home=dest_hermes)

    assert (dest_hermes / "config.yaml").read_text(encoding="utf-8") == "model: test\n"
    assert (dest_hermes / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "remember this\n"
    assert (dest_ws / "notes.txt").read_text(encoding="utf-8") == "workspace file\n"
    # Secrets and caches must not round-trip
    assert not (dest_hermes / ".env").exists()
    assert not (dest_hermes / "auth.json").exists()
    assert not (dest_hermes / "cache" / "junk.bin").exists()
    # DB restored
    with sqlite3.connect(dest_hermes / "state.db") as db:
        row = db.execute("SELECT id FROM sessions").fetchone()
        assert row == ("s1",)


def test_upload_requires_config(monkeypatch, tmp_path):
    monkeypatch.delenv("FROMDONNA_USER_ID", raising=False)
    monkeypatch.delenv("FROMDONNA_WORKER_URL", raising=False)
    monkeypatch.delenv("WORKER_TO_HARNESS_SECRET", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    (tmp_path / ".hermes").mkdir()
    try:
        ckpt.upload_checkpoint()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "checkpoint_not_configured" in str(exc)


def test_local_checkpoint_status_handshake(tmp_path, monkeypatch):
    hermes = tmp_path / ".hermes"
    hermes.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes))
    (tmp_path / "workspace").mkdir(exist_ok=True)

    assert ckpt.local_checkpoint_status(hermes_home=hermes)["state"] == "idle"

    ckpt.mark_checkpoint_packing(source="test", hermes_home=hermes)
    assert ckpt.local_checkpoint_status(hermes_home=hermes)["state"] == "packing"

    # Minimal pack: empty-ish home still produces an archive.
    (hermes / "SOUL.md").write_text("hi\n", encoding="utf-8")
    result = ckpt.prepare_local_checkpoint(source="test", hermes_home=hermes)
    assert result["ok"] is True
    status = ckpt.local_checkpoint_status(hermes_home=hermes)
    assert status["state"] == "ready"
    assert status["bytes"] > 0
    assert status.get("readyAt") is not None

    packed = ckpt.read_local_checkpoint(consume=True, hermes_home=hermes)
    assert packed is not None
    # After consume: ready + tar removed — must NOT look ready (stale harvest race).
    post = ckpt.local_checkpoint_status(hermes_home=hermes)
    assert post["state"] == "idle"
    assert not (hermes / "fromdonna-checkpoint-ready.json").exists()
    assert not (hermes / "fromdonna-checkpoint-latest.tar.gz").exists()

    # Tar-only leftover must not report ready.
    (hermes / "fromdonna-checkpoint-latest.tar.gz").write_bytes(b"not-a-real-tar")
    assert ckpt.local_checkpoint_status(hermes_home=hermes)["state"] == "idle"
    assert ckpt.read_local_checkpoint(consume=True, hermes_home=hermes) is None

    # Failed marker without a ready archive.
    for name in (
        "fromdonna-checkpoint-latest.tar.gz",
        "fromdonna-checkpoint-ready.json",
        "fromdonna-checkpoint-packing.json",
    ):
        p = hermes / name
        if p.exists():
            p.unlink()
    ckpt.mark_checkpoint_failed("boom", hermes_home=hermes)
    failed = ckpt.local_checkpoint_status(hermes_home=hermes)
    assert failed["state"] == "failed"
    assert "boom" in str(failed.get("error") or "")
    assert failed.get("failedAt") is not None
