"""Private Worker -> Hermes HTTP handoff for one FromDonna E2B sandbox."""
import os
import subprocess
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
HOME = Path.home()


class Turn(BaseModel):
    userId: str
    gateway: str
    gatewayChatId: str
    gatewayMessageId: str
    text: str


@app.get("/health")
def health():
    return {"ok": True, "service": "fromdonna-harness"}


@app.post("/turn")
def turn(turn: Turn, authorization: str | None = Header(default=None), x_llm_capability: str | None = Header(default=None)):
    expected = os.environ.get("WORKER_TO_HARNESS_SECRET", "")
    if not expected or authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized")
    if not turn.text.strip():
        return {"text": ""}
    if not x_llm_capability:
        raise HTTPException(status_code=401, detail="missing_llm_capability")

    # The capability is injected only into this Hermes child invocation, never
    # written to ~/.hermes or the image. The proxy will enforce it once its
    # verifier is enabled.
    env = os.environ | {
        "HERMES_HOME": str(HOME / ".hermes"),
        "OPENAI_API_KEY": x_llm_capability,
    }
    try:
        completed = subprocess.run(
            ["/home/user/venv/bin/hermes", "--oneshot", turn.text, "--provider", "custom", "--model", "gpt-5.6-terra", "--continue", "fromdonna"],
            cwd=str(HOME / "workspace"),
            env=env,
            text=True,
            capture_output=True,
            timeout=840,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="agent_turn_timed_out")

    if completed.returncode != 0:
        # Do not return stderr: it can contain runtime details or credentials.
        raise HTTPException(status_code=502, detail="agent_turn_failed")
    return {"text": completed.stdout.strip()}
