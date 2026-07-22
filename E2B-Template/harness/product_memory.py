"""System-level product MEMORY notes for FromDonna sandboxes.

Hermes injects ``~/.hermes/memories/MEMORY.md`` into every session (volatile
tier of the system prompt). Skills hold procedures; MEMORY holds a short
pointer so the agent loads the right skill when the user wants app connect.

The template bakes a seed file. This module **re-asserts** the product
pointer on bootstrap and after R2 restore so:
  - agent memory edits cannot permanently drop product policy
  - old checkpoints without the note still get it after recreate/restore
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

# Stable marker: presence means the system note is already in MEMORY.md.
CONNECT_APPS_MARKER = "connect-apps"

# Single §-style entry (Hermes memory delimiter is "\\n§\\n" between entries).
# Keep compact — MEMORY has a ~2200 char budget and is injected every turn.
CONNECT_APPS_MEMORY_ENTRY = (
    "App connect (Google: Gmail/Drive/Calendar/Sheets/Docs/Slides/Meet/"
    "Tasks/Contacts/Forms/Photos/Chat; Microsoft: Outlook/OneDrive/Excel/"
    "Teams/OneNote/SharePoint; plus GitHub, LinkedIn, Dropbox, Dropbox Sign): "
    "always load skill `connect-apps` with skill_view and follow it. "
    "Composio MCP allowlist only — no other OAuth connectors for this Hermes."
)

ENTRY_DELIMITER = "\n§\n"


def memory_path(hermes_home: Path) -> Path:
    return Path(hermes_home) / "memories" / "MEMORY.md"


def ensure_connect_apps_memory_pointer(
    *,
    hermes_home: Path,
    entry: str = CONNECT_APPS_MEMORY_ENTRY,
    marker: str = CONNECT_APPS_MARKER,
) -> bool:
    """Ensure the connect-apps skill pointer exists in MEMORY.md.

    Returns True if the file was created or updated; False if already present.
    """
    path = memory_path(hermes_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if marker in text:
        return False

    entry_clean = entry.strip()
    if not entry_clean:
        return False

    existing = text.strip()
    if existing:
        new_text = entry_clean + ENTRY_DELIMITER + existing + "\n"
    else:
        new_text = entry_clean + "\n"
    path.write_text(new_text, encoding="utf-8")
    return True
