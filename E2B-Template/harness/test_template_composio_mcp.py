"""Structural tests: E2B template installs Hermes MCP client for Composio."""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_template_installs_hermes_mcp_extra():
    """Without hermes[mcp], discover_mcp_tools is a no-op and Composio tools never load."""
    template = (ROOT / "template.ts").read_text(encoding="utf-8")
    assert "messaging,exa,mcp" in template, (
        "template.ts must install hermes[messaging,exa,mcp] so Composio MCP tools load"
    )


def test_baked_config_has_official_composio_mcp_block():
    cfg = yaml.safe_load((ROOT / "config/hermes/config.yaml").read_text(encoding="utf-8"))
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
