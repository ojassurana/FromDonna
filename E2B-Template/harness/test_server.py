import concurrent.futures
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
