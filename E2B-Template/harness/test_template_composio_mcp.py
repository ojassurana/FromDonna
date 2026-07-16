"""Structural tests: E2B template installs Hermes MCP client for Composio."""
from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

# Product allowlist mirrored in the connect-apps skill (proxy toolkits.ts is SoT).
_EXPECTED_TOOLKIT_SLUGS = (
    "gmail",
    "googledrive",
    "googlecalendar",
    "googlesheets",
    "googledocs",
    "github",
    "notion",
    "linkedin",
    "dropbox",
    "splitwise",
    "outlook",
    "dropbox_sign",
)

_CONNECT_SKILL = (
    ROOT / "extensions/skills/productivity/connect-apps/SKILL.md"
)
_SOUL = ROOT / "config/hermes/SOUL.md"
_MEMORY = ROOT / "config/hermes/memories/MEMORY.md"
_CONFIG = ROOT / "config/hermes/config.yaml"
_TEMPLATE = ROOT / "template.ts"


def test_template_installs_hermes_mcp_extra():
    """Without hermes[mcp], discover_mcp_tools is a no-op and Composio tools never load."""
    template = _TEMPLATE.read_text(encoding="utf-8")
    assert "messaging,exa,mcp" in template, (
        "template.ts must install hermes[messaging,exa,mcp] so Composio MCP tools load"
    )


def test_baked_config_has_official_composio_mcp_block():
    cfg = yaml.safe_load(_CONFIG.read_text(encoding="utf-8"))
    composio = cfg["mcp_servers"]["composio"]
    assert composio["url"].endswith("/mcp")
    assert "FROMDONNA_COMPOSIO_MCP_TOKEN" in composio["headers"]["Authorization"]
    assert composio["connect_timeout"] == 60
    assert composio["timeout"] == 180
    assert composio.get("skip_preflight") is True


def test_gateway_runtime_preserves_reply_to_mode_off():
    src = (ROOT / "harness/gateway_runtime.py").read_text(encoding="utf-8")
    assert "reply_to_mode" in src
    assert "TELEGRAM_REPLY_TO_MODE" in src
    assert 'reply_to_mode = "off"' in src or "TELEGRAM_REPLY_TO_MODE\"] = \"off\"" in src


def test_no_fromdonna_thinking_dots_module():
    assert not (ROOT / "hermes/plugins/platforms/telegram/fromdonna_ux.py").exists()


def test_soul_has_no_composio_oauth_procedure():
    """SOUL stays persona-only — connect procedure lives in the skill."""
    text = _SOUL.read_text(encoding="utf-8")
    lowered = text.lower()
    banned = (
        "composio",
        "mcp_servers",
        "manage_connections",
        "manage-connections",
        "connect.composio",
        "oauth",
        "fromdonna-composio",
        "tool router",
        "redirect_url",
    )
    hits = [b for b in banned if b in lowered]
    assert hits == [], f"SOUL.md must not contain Composio/OAuth procedure text: {hits}"


def _parse_skill_frontmatter(content: str) -> dict:
    assert content.startswith("---"), "SKILL.md must start with YAML frontmatter ---"
    m = re.search(r"\n---\s*\n", content[3:])
    assert m, "SKILL.md frontmatter must close with ---"
    fm = yaml.safe_load(content[3 : m.start() + 3])
    assert isinstance(fm, dict)
    # m.end() is relative to content[3:]; absolute end of frontmatter close.
    body = content[3 + m.end() :]
    assert body.strip(), "SKILL.md body must be non-empty"
    return fm


def test_connect_apps_skill_hermes_shape_and_policy():
    """Product skill: Hermes layout + allowlist + one-shot + no other connectors."""
    assert _CONNECT_SKILL.is_file(), f"missing {_CONNECT_SKILL}"
    content = _CONNECT_SKILL.read_text(encoding="utf-8")
    fm = _parse_skill_frontmatter(content)
    assert fm.get("name") == "connect-apps"
    desc = fm.get("description") or ""
    assert desc.strip(), "description required"
    assert len(desc) <= 1024

    body_lower = content.lower()
    for slug in _EXPECTED_TOOLKIT_SLUGS:
        assert slug in body_lower, f"skill body missing allowlist slug {slug}"

    assert "manage" in body_lower and "connection" in body_lower, (
        "skill must instruct Composio manage-connections flow"
    )
    assert "one-shot" in body_lower or "one shot" in body_lower or "send once" in body_lower
    assert (
        "no other connector" in body_lower
        or "only the allowlist" in body_lower
        or "allowlist only" in body_lower
    ), "skill must refuse non-allowlisted connectors"


def test_template_bakes_skills_and_memory_into_hermes_home():
    """Image recipe must copy product skills + MEMORY seed into ~/.hermes paths."""
    template = _TEMPLATE.read_text(encoding="utf-8")
    assert 'copy("extensions/skills"' in template or "copy('extensions/skills'" in template
    assert "/home/user/.hermes/skills" in template
    assert "config/hermes/memories/MEMORY.md" in template
    assert "/home/user/.hermes/memories/MEMORY.md" in template
    # product_memory helper ships in the harness image tree.
    assert (ROOT / "harness/product_memory.py").is_file()

def test_memory_seed_points_at_connect_apps_skill():
    text = _MEMORY.read_text(encoding="utf-8")
    assert "connect-apps" in text
    # Pointer only — not a full OAuth runbook dump.
    assert "skill" in text.lower()
    assert "skill_view" in text.lower()
    assert "redirect_url" not in text.lower()
    assert "manage_connections" not in text.lower()
    # Keep short so it fits MEMORY budget as a single durable note.
    assert len(text) < 800
    # Seed text must match harness re-assert entry (system-level product policy).
    from product_memory import CONNECT_APPS_MEMORY_ENTRY

    assert text.strip() == CONNECT_APPS_MEMORY_ENTRY.strip()


def test_ensure_connect_apps_memory_pointer_is_idempotent(tmp_path):
    """System ensure: write once, no-op when present, restore after wipe."""
    from product_memory import (
        CONNECT_APPS_MARKER,
        ensure_connect_apps_memory_pointer,
        memory_path,
    )

    hermes = tmp_path / ".hermes"
    assert ensure_connect_apps_memory_pointer(hermes_home=hermes) is True
    path = memory_path(hermes)
    first = path.read_text(encoding="utf-8")
    assert CONNECT_APPS_MARKER in first
    assert "skill_view" in first

    assert ensure_connect_apps_memory_pointer(hermes_home=hermes) is False
    assert path.read_text(encoding="utf-8") == first

    # User/agent notes without the product marker get the pointer prepended.
    path.write_text("User prefers short answers\n", encoding="utf-8")
    assert ensure_connect_apps_memory_pointer(hermes_home=hermes) is True
    merged = path.read_text(encoding="utf-8")
    assert CONNECT_APPS_MARKER in merged
    assert "User prefers short answers" in merged
    assert merged.index(CONNECT_APPS_MARKER) < merged.index("User prefers")


def test_template_and_harness_wire_product_memory_ensure():
    """Bootstrap + restore must re-assert the MEMORY pointer (system level)."""
    server_src = (ROOT / "harness/server.py").read_text(encoding="utf-8")
    assert "ensure_connect_apps_memory_pointer" in server_src
    assert "product_memory" in server_src
    # Called in both bootstrap and restore paths.
    assert server_src.count("ensure_connect_apps_memory_pointer") >= 2

def test_display_quiet_no_tool_skill_progress_spam():
    cfg = yaml.safe_load(_CONFIG.read_text(encoding="utf-8"))
    display = cfg["display"]
    tp = display.get("tool_progress")
    assert tp is False or tp in ("off", "false", False)
    assert display.get("show_reasoning") is False
    telegram = (display.get("platforms") or {}).get("telegram") or {}
    tg_tp = telegram.get("tool_progress", tp)
    assert tg_tp is False or tg_tp in ("off", "false", False)
    assert telegram.get("show_reasoning", display.get("show_reasoning")) is False
