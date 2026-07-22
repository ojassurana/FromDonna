import concurrent.futures
import json
import sqlite3
import subprocess
import threading
import time

import pytest
from fastapi import HTTPException

import server


SECRET = "s" * 32
CAPABILITY = "capability-token"


@pytest.fixture(autouse=True)
def isolated_harness(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "HERMES_HOME", tmp_path / ".hermes")
    monkeypatch.setattr(server, "HOME", tmp_path)
    monkeypatch.setattr(server, "_worker_secret", SECRET)


def create_session(session_id="session-first", source="fromdonna"):
    server.HERMES_HOME.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(server.HERMES_HOME / "state.db") as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            "id TEXT PRIMARY KEY, source TEXT, started_at REAL)"
        )
        db.execute(
            "INSERT OR REPLACE INTO sessions (id, source, started_at) VALUES (?, ?, ?)",
            (session_id, source, time.time()),
        )


def call_turn(payload):
    return server.turn(
        payload,
        authorization=f"Bearer {SECRET}",
        x_llm_capability=CAPABILITY,
    )


def test_first_turn_creates_and_persists_then_second_turn_resumes(monkeypatch):
    calls = []

    def fake_invoke(prompt, capability, session_id, action_file, **_kwargs):
        calls.append((prompt, capability, session_id))
        if session_id is None:
            create_session()
            sid = "session-first"
        else:
            sid = session_id
        return subprocess.CompletedProcess(
            ["hermes-telegram-gateway", sid], 0, stdout="first reply\n", stderr=""
        )

    monkeypatch.setattr(server, "_invoke_hermes", fake_invoke)

    first = call_turn(server.Turn(text="first message"))
    second = call_turn(server.Turn(text="second message"))

    assert first.model_dump() == {
        "actions": [{"type": "sendMessage", "text": "first reply"}],
        "text": "first reply",
        "sessionId": "session-first",
    }
    assert second.sessionId == "session-first"
    assert calls[0][2] is None
    assert calls[1][2] == "session-first"
    assert server._load_session_id() == "session-first"


def test_normalized_event_is_rendered_as_neutral_agent_context(monkeypatch):
    received_prompts = []

    def fake_invoke(prompt, capability, session_id, action_file, **_kwargs):
        received_prompts.append(prompt)
        create_session("session-event")
        return subprocess.CompletedProcess(
            ["hermes-telegram-gateway", "session-event"], 0, stdout="done", stderr=""
        )

    monkeypatch.setattr(server, "_invoke_hermes", fake_invoke)
    response = call_turn(
        server.Turn(
            event=server.InboundEvent(
                text="Please inspect this",
                reply=server.ReplyContext(messageId="prior", text="prior text"),
                attachments=[
                    server.Attachment(
                        type="image",
                        uri="r2://private/object.png",
                        mimeType="image/png",
                    )
                ],
                callback=server.CallbackContext(id="callback-1", data="inspect"),
            )
        )
    )

    assert response.actions[0].type == "sendMessage"
    prompt = received_prompts[0]
    assert prompt.startswith("Please inspect this\n\n[Associated event context]")
    assert '"reply":{"messageId":"prior","text":"prior text"}' in prompt
    assert '"attachments":[{"uri":"r2://private/object.png"' in prompt
    assert '"callback":{"id":"callback-1","data":"inspect"}' in prompt


def test_action_contract_supports_media_and_inline_buttons():
    media = server.SendMediaAction(
        artifact=server.OutboundArtifactDescriptor(uri="r2://private/result.pdf", mimeType="application/pdf"),
        caption="Result",
    )
    buttons = server.InlineButtonsAction(
        buttons=[[server.InlineButton(text="Open", url="https://example.test")]]
    )
    response = server.TurnResponse(actions=[media, buttons], text="", sessionId="session-first")

    assert response.model_dump()["actions"] == [
        {
            "type": "sendMedia",
            "artifact": {"uri": "r2://private/result.pdf", "name": None, "mimeType": "application/pdf"},
            "caption": "Result",
        },
        {
            "type": "inlineButtons",
            "buttons": [[{"text": "Open", "callbackData": None, "url": "https://example.test"}]],
            "targetActionIndex": None,
        },
    ]


def test_turn_collects_private_plugin_actions_and_deduplicates_final_text(monkeypatch):
    observed_action_files = []

    def fake_invoke(prompt, capability, session_id, action_file, **_kwargs):
        del prompt, capability, session_id
        observed_action_files.append(action_file)
        assert action_file.parent == server.HERMES_HOME / server.ACTION_DIRECTORY_NAME
        assert action_file.stat().st_mode & 0o777 == 0o600
        action_file.write_text(
            '{"type":"sendMessage","text":"Sent deliberately"}\n'
            '{"type":"sendMedia","artifact":{"uri":"r2://private/result.pdf","mimeType":"application/pdf"},"caption":"Result"}\n'
            '{"type":"inlineButtons","buttons":[[{"text":"Open","callbackData":"open:result"}]],"targetActionIndex":1}\n',
            encoding="utf-8",
        )
        create_session("session-actions")
        return subprocess.CompletedProcess(
            ["hermes-telegram-gateway", "session-actions"], 0, stdout="Sent deliberately\n", stderr=""
        )

    monkeypatch.setattr(server, "_invoke_hermes", fake_invoke)
    response = call_turn(server.Turn(text="please send it"))

    assert response.text == "Sent deliberately"
    assert response.sessionId == "session-actions"
    assert [action.type for action in response.actions] == ["sendMessage", "sendMedia", "inlineButtons"]
    assert isinstance(response.actions[1], server.SendMediaAction)
    assert isinstance(response.actions[2], server.InlineButtonsAction)
    assert response.actions[1].artifact.uri == "r2://private/result.pdf"
    assert response.actions[2].buttons[0][0].callbackData == "open:result"
    assert not observed_action_files[0].exists()


def test_invalid_plugin_action_is_rejected_and_request_file_is_removed(monkeypatch):
    observed_action_files = []

    def fake_invoke(prompt, capability, session_id, action_file, **_kwargs):
        del prompt, capability, session_id
        observed_action_files.append(action_file)
        action_file.write_text('{"type":"sendMessage","text":"x","recipient":"leak"}\n', encoding="utf-8")
        return subprocess.CompletedProcess([], 0, stdout="ignored", stderr="")

    monkeypatch.setattr(server, "_invoke_hermes", fake_invoke)
    with pytest.raises(HTTPException) as exc:
        call_turn(server.Turn(text="bad"))

    assert exc.value.status_code == 502
    assert exc.value.detail == "agent_actions_invalid"
    assert not observed_action_files[0].exists()


def test_concurrent_turns_are_serialized(monkeypatch):
    create_session("session-existing")
    server._persist_session_id("session-existing")
    active = 0
    maximum_active = 0
    active_lock = threading.Lock()
    calls = []

    def fake_invoke(prompt, capability, session_id, action_file, **_kwargs):
        nonlocal active, maximum_active
        with active_lock:
            active += 1
            maximum_active = max(maximum_active, active)
            calls.append(session_id)
        time.sleep(0.05)
        with active_lock:
            active -= 1
        return subprocess.CompletedProcess(
            ["hermes-telegram-gateway", "session-existing"],
            0,
            stdout=f"reply: {prompt}",
            stderr="",
        )

    monkeypatch.setattr(server, "_invoke_hermes", fake_invoke)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda text: call_turn(server.Turn(text=text)),
                ["one", "two"],
            )
        )

    assert maximum_active == 1
    assert calls == ["session-existing", "session-existing"]
    assert [response.text for response in responses] == ["reply: one", "reply: two"]


def test_success_without_a_created_session_is_not_silently_continued(monkeypatch):
    monkeypatch.setattr(
        server,
        "_invoke_hermes",
        lambda prompt, capability, session_id, action_file, **_kwargs: subprocess.CompletedProcess(
            ["hermes-telegram-gateway"], 0, stdout="reply", stderr=""
        ),
    )

    with pytest.raises(HTTPException) as exc:
        call_turn(server.Turn(text="first"))

    assert exc.value.status_code == 502
    assert exc.value.detail == "agent_session_not_persisted"


def test_apply_composio_mcp_writes_official_hermes_shape(monkeypatch, tmp_path):
    """Composio is wired as stock Hermes mcp_servers.composio (env Bearer)."""
    import os

    hermes = tmp_path / ".hermes"
    hermes.mkdir()
    # Seed baked-style config like the E2B template.
    (hermes / "config.yaml").write_text(
        "model:\n  default: grok-4.5\nplatform_toolsets:\n  telegram:\n    - hermes-cli\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(server, "HERMES_HOME", hermes)
    monkeypatch.delenv("FROMDONNA_COMPOSIO_MCP_TOKEN", raising=False)
    monkeypatch.delenv("FROMDONNA_COMPOSIO_MCP_URL", raising=False)

    mcp = server.ComposioMcpBootstrap(
        url="https://fromdonna-composio-proxy.code-df4.workers.dev/mcp",
        token="t" * 32,
        toolkits=["gmail", "github"],
    )
    server._apply_composio_mcp(mcp)

    assert os.environ["FROMDONNA_COMPOSIO_MCP_TOKEN"] == "t" * 32
    assert os.environ["FROMDONNA_COMPOSIO_MCP_URL"].endswith("/mcp")
    assert os.environ["FROMDONNA_COMPOSIO_TOOLKITS"] == "gmail,github"

    import yaml

    cfg = yaml.safe_load((hermes / "config.yaml").read_text(encoding="utf-8"))
    entry = cfg["mcp_servers"]["composio"]
    # Official Hermes fields
    assert entry["url"].endswith("/mcp")
    assert entry["connect_timeout"] == 60
    assert entry["timeout"] == 180
    assert entry["skip_preflight"] is True
    # Token via ${…} interpolation (not baked into the yaml as a secret)
    assert entry["headers"]["Authorization"] == "Bearer ${FROMDONNA_COMPOSIO_MCP_TOKEN}"
    # Existing config preserved
    assert cfg["model"]["default"] == "grok-4.5"
    assert server._composio_mcp_ready() is True


def test_composio_mcp_not_ready_without_token(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "HERMES_HOME", tmp_path / ".hermes")
    monkeypatch.delenv("FROMDONNA_COMPOSIO_MCP_TOKEN", raising=False)
    monkeypatch.delenv("FROMDONNA_COMPOSIO_MCP_URL", raising=False)
    assert server._composio_mcp_ready() is False


def test_extract_instructions_from_chat_completions_and_responses():
    chat_body = {
        "model": "grok-4.5",
        "messages": [
            {"role": "system", "content": "You are Donna."},
            {"role": "user", "content": "hi"},
        ],
        "tools": [{"type": "function", "function": {"name": "web_search"}}],
    }
    assert server._extract_instructions(chat_body) == "You are Donna."

    responses_body = {
        "model": "grok-4.5",
        "instructions": "You are Chitti.",
        "input": [{"role": "user", "content": "hi"}],
        "tools": [],
    }
    assert server._extract_instructions(responses_body) == "You are Chitti."


def test_latest_api_request_returns_dump_summary(tmp_path, monkeypatch):
    hermes = tmp_path / ".hermes"
    sessions = hermes / "sessions"
    sessions.mkdir(parents=True)
    monkeypatch.setattr(server, "HERMES_HOME", hermes)
    monkeypatch.setenv("HERMES_DUMP_REQUESTS", "1")

    dump = {
        "timestamp": "2026-07-22T12:00:00",
        "session_id": "sess_abc",
        "reason": "preflight",
        "request": {
            "method": "POST",
            "url": "https://fromdonna-llm-proxy.example/v1/chat/completions",
            "headers": {"Authorization": "Bearer ***", "Content-Type": "application/json"},
            "body": {
                "model": "grok-4.5",
                "messages": [
                    {"role": "system", "content": "SOUL seed here"},
                    {"role": "user", "content": "ping"},
                ],
                "tools": [{"type": "function"}, {"type": "function"}],
            },
        },
    }
    path = sessions / "request_dump_sess_abc_20260722_120000_000000.json"
    path.write_text(json.dumps(dump), encoding="utf-8")

    listed = server.internal_list_request_dumps(authorization=f"Bearer {SECRET}")
    assert listed["ok"] is True
    assert listed["count"] == 1
    assert listed["files"][0]["filename"] == path.name

    summary = server.internal_latest_api_request(authorization=f"Bearer {SECRET}")
    assert summary["ok"] is True
    assert summary["session_id"] == "sess_abc"
    assert summary["reason"] == "preflight"
    assert summary["model"] == "grok-4.5"
    assert summary["instructions"] == "SOUL seed here"
    assert summary["instructions_chars"] == len("SOUL seed here")
    assert summary["tools_count"] == 2
    assert summary["api_shape"] == "chat_completions"

    plain = server.internal_latest_api_request(
        authorization=f"Bearer {SECRET}",
        instructions_only=True,
    )
    assert plain.body == b"SOUL seed here"

    by_name = server.internal_get_request_dump(
        path.name,
        authorization=f"Bearer {SECRET}",
    )
    assert by_name["filename"] == path.name
    assert by_name["instructions"] == "SOUL seed here"


def test_latest_api_request_404_when_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "HERMES_HOME", tmp_path / ".hermes")
    with pytest.raises(HTTPException) as exc:
        server.internal_latest_api_request(authorization=f"Bearer {SECRET}")
    assert exc.value.status_code == 404
