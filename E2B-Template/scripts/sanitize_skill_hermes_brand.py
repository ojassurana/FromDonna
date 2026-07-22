#!/usr/bin/env python3
"""Sanitize Hermes product branding from model-visible skill SKILL.md trees.

Preserves runtime contracts (HERMES_* env, ~/.hermes paths, metadata.hermes key,
toolset ids, python modules, etc.) via protect/restore placeholders.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOTS = [
    Path("/home/ubuntu/FromDonna/E2B-Template/hermes/skills"),
    Path("/home/ubuntu/FromDonna/E2B-Template/hermes/optional-skills"),
    Path("/home/ubuntu/FromDonna/E2B-Template/extensions/skills"),
]

# Placeholders must not contain brand substrings after restore-sensitive replaces.
PH = "\x00PROT{}"


def protect(text: str) -> tuple[str, list[str]]:
    stored: list[str] = []

    def stash(m: re.Match[str]) -> str:
        stored.append(m.group(0))
        return PH.format(len(stored) - 1)

    patterns = [
        # Env expansions and env var names (HERMES_HOME, HERMES_SKILL_DIR, etc.)
        r"\$\{HERMES_[A-Z0-9_]+(?:[:-][^}]*)?\}",
        r"\$HERMES_[A-Z0-9_]+",
        r"\bHERMES_[A-Z0-9_]+\b",
        # Paths
        r"~/\.hermes\b(?:/[^\s`'\"\)\]\},;:]*)?",
        r"\$HOME/\.hermes\b(?:/[^\s`'\"\)\]\},;:]*)?",
        r"/opt/hermes\b(?:/[^\s`'\"\)\]\},;:]*)?",
        r"/opt/data(?:/home)?/\.hermes\b(?:/[^\s`'\"\)\]\},;:]*)?",
        # Workspace-relative plan path convention
        r"\.hermes/plans\b(?:/[^\s`'\"\)\]\},;:]*)?",
        r"\.hermes\.md\b",
        # YAML structural key (indent-tolerant line that is only the key)
        r"(?m)^([ \t]*)hermes:([ \t]*)$",
        # Toolset ids
        r"\bhermes-cli\b",
        r"\bhermes-api-server\b",
        # Python modules / symbols
        r"\bhermes_constants\b",
        r"\bhermes_cli\b(?:\.[A-Za-z0-9_\.]+)?",
        r"\bhermes_state\b",
        r"\bhermes_logging\b",
        r"\bhermes_time\b",
        r"\bhermes_bootstrap\b",
        r"\bget_hermes_home\b",
        r"\b_hermes_home\.py\b",
        r"\b_hermes_env\b",
        r"\b_hermes_home\b",
        # systemd unit etc that is literally the service name
        r"\bhermes-gateway\b",
        # docker user / setuid targets that are system usernames
        r"\bs6-setuidgid hermes\b",
        r"\b--user hermes\b",
        r"\bto hermes\b(?= via|\b|\.|\,)",
        # package paths that are real filesystem contracts
        r"/etc/s6-overlay/s6-rc\.d/main-hermes\b(?:/[^\s`'\"\)\]\},;:]*)?",
        r"main-hermes/run",
        r"01-hermes-setup",
        # CLI binary invocations: keep `hermes` command tokens when clearly CLI
        # Protect backtick-wrapped hermes command lines fragments carefully:
        r"`hermes(?:\s+[^`]*)?`",
        r"(?m)^hermes(?:\s+\S+.*)?$",
        r"(?m)^\s+hermes(?:\s+\S+.*)?$",
        # Common shell: hermes subcommand in free text after prompt-like markers
        r"(?<=\s)hermes(?=\s+(?:pets|teams-pipeline|gateway|skills|setup|cron|honcho|webhook|profile|dashboard|--tui|-p|-q|--toolsets)\b)",
        # JSON / code identifiers with hermes_ prefix that aren't product brand
        r"\bhermes_[a-z][a-z0-9_]*\b",
    ]

    for pat in patterns:
        text = re.sub(pat, stash, text)
    return text, stored


def restore(text: str, stored: list[str]) -> str:
    def unstash(m: re.Match[str]) -> str:
        idx = int(m.group(1))
        return stored[idx]

    return re.sub(r"\x00PROT(\d+)", unstash, text)


def sanitize_body(text: str) -> str:
    """Apply brand replacements on unprotected text."""
    # Skill name renames (product-facing skill ids)
    text = re.sub(r"\bhermes-agent-skill-authoring\b", "skill-authoring", text)
    text = re.sub(r"\bhermes-s6-container-supervision\b", "s6-container-supervision", text)
    text = re.sub(r"\bhermes-agent-dev\b", "donna-agent-dev", text)
    text = re.sub(r"skill_view\(name=['\"]hermes-agent['\"]\)", "skill_view(name='donna-agent')", text)
    text = re.sub(r"\bhermes-agent\b", "donna-agent", text)

    # Authors
    text = re.sub(
        r"author:\s*Hermes Agent(\s*\([^)]*\))?",
        lambda m: f"author: Donna{m.group(1) or ''}",
        text,
    )
    text = re.sub(r"author:\s*hermes-agent\b", "author: Donna", text)
    text = re.sub(r",\s*Hermes Agent\b", ", Donna", text)
    text = re.sub(r"\benhanced by Hermes Agent\b", "enhanced by Donna", text)
    text = re.sub(r"\bported into hermes-agent\b", "ported into Donna", text)
    text = re.sub(r"\bHermes Agent \+ ", "Donna + ", text)
    text = re.sub(r"\+ Hermes Agent\b", "+ Donna", text)

    # Multi-word product brand first
    text = re.sub(r"\bHermes-Agent\b", "Donna", text)
    text = re.sub(r"\bHermes Agent's\b", "Donna's", text)
    text = re.sub(r"\bHermes Agent\b", "Donna", text)
    text = re.sub(r"\bHermes's\b", "Donna's", text)
    text = re.sub(r"\bHermes'\b", "Donna's", text)

    # Section titles / workflow phrases
    text = re.sub(r"\bTypical Hermes Workflow\b", "Typical Workflow", text)
    text = re.sub(r"\bImportant Notes for Hermes\b", "Important Notes", text)
    text = re.sub(r"\bHermes Agent Integration\b", "Agent Integration", text)
    text = re.sub(r"\bHermes Tool Patterns\b", "Tool Patterns", text)
    text = re.sub(r"\bHermes-specific\b", "Agent-specific", text)
    text = re.sub(r"\bHermes-managed\b", "agent-managed", text)
    text = re.sub(r"\bHermes-compatible\b", "agent-compatible", text)
    text = re.sub(r"\bHermes-run\b", "agent-run", text)
    text = re.sub(r"\bHermes-tool\b", "agent-tool", text)
    text = re.sub(r"\bfor Hermes Agents\b", "for Agents", text)
    text = re.sub(r"\bfor Hermes\b", "for the agent", text)
    text = re.sub(r"\bwith Hermes\b", "with the agent", text)
    text = re.sub(r"\bto Hermes\b", "to the agent", text)
    text = re.sub(r"\binto Hermes\b", "into the agent", text)
    text = re.sub(r"\bin Hermes\b", "in the agent", text)
    text = re.sub(r"\bvia Hermes\b", "via the agent", text)
    text = re.sub(r"\bon Hermes\b", "on the agent", text)
    text = re.sub(r"\bfrom Hermes\b", "from the agent", text)
    text = re.sub(r"\bof Hermes\b", "of the agent", text)
    text = re.sub(r"\bby Hermes\b", "by the agent", text)

    # Upstream docs URLs — neutralize product branding in prose about them
    text = re.sub(
        r"https?://hermes-agent\.nousresearch\.com[^\s\)\]`'\"\,]*",
        "(product docs — internal)",
        text,
    )
    text = re.sub(
        r"https?://github\.com/NousResearch/hermes-agent[^\s\)\]`'\"\,]*",
        "(upstream source — internal)",
        text,
    )
    text = re.sub(
        r"NousResearch/hermes-agent",
        "product-repo",
        text,
    )

    # Remaining capitalized Hermes as product
    text = re.sub(r"\bHermes\b", "Donna", text)

    # Lowercase leftover product phrases that aren't protected contracts
    # e.g. "ship with hermes-agent" already handled; "restart hermes" if not protected
    text = re.sub(r"\brestart hermes\b", "restart the agent", text, flags=re.I)
    text = re.sub(r"\bRestart Hermes\b", "Restart the agent", text)

    # Example emails / usernames that brand hermes-agent
    text = re.sub(r"\bhermes-agent@agentmail\.to\b", "donna@agentmail.to", text)
    text = re.sub(r'username:\s*"hermes-agent"', 'username: "donna"', text)
    text = re.sub(r"\(e\.g\.\s*`hermes-agent`\)", "(e.g. `donna`)", text)
    text = re.sub(r"e\.g\.\s*hermes-agent@agentmail\.to", "e.g. donna@agentmail.to", text)
    text = re.sub(r"hermes-outreach", "donna-outreach", text)
    text = re.sub(r"--client hermes\b", "--client donna", text)
    text = re.sub(r"\(e\.g\.\s*`hermes`\)", "(e.g. `donna`)", text)
    text = re.sub(r'"Hermes"', '"Donna"', text)
    text = re.sub(r'"generator":\s*"donna-agent code-wiki', '"generator": "donna code-wiki', text)

    # Docker image tag examples that brand hermes-agent
    text = re.sub(r"\bhermes-agent-harness\b", "donna-agent-harness", text)

    # Local dev path examples
    text = re.sub(r"/home/bb/donna-agent\b", "/path/to/repo", text)
    text = re.sub(r"/home/bb/hermes-agent\b", "/path/to/repo", text)

    # Tags containing hermes-agent already renamed; clean tag lists like hermes-agent in tags
    text = re.sub(r"tags:\s*\[([^\]]*)]", lambda m: "tags: [" + m.group(1).replace("hermes-agent", "donna-agent").replace("hermes", "donna") + "]", text)

    # related_skills lists: hermes-agent already → donna-agent

    # CLI note phrases
    text = re.sub(r"\bImportant Donna CLI note\b", "Important CLI note", text)

    # "this Hermes" phrasing
    text = re.sub(r"\bthis Donna\b", "this agent", text)
    text = re.sub(r"\bthis Hermes\b", "this agent", text)

    # Vendor example "vendor":"Hermes" already → Donna via Hermes→Donna

    # Fix double Donna from author lines that had "Hermes Agent + X" already handled
    # Clean awkward "Donna / FromDonna" if created from "Hermes / FromDonna"
    text = re.sub(r"\bthis Donna / FromDonna\b", "this FromDonna", text)
    text = re.sub(r"\bthis agent / FromDonna\b", "this FromDonna", text)

    # "Give Donna phone" is fine; "Connect Donna to" is fine

    # Avoid turning Docker username leftovers: if "user hermes" slipped, leave via protect

    # "official Donna Docker" is ok

    # Fix "Donna tools" which is fine; "Donna memory" fine

    # skill name field for skill-authoring example frontmatter
    text = re.sub(r"author: Hermes Agent\n", "author: Donna\n", text)

    # homepage fields that still mention brand after URL replace
    text = re.sub(
        r"homepage:\s*\(upstream source — internal\)\S*",
        "homepage: https://fromdonna.ai",
        text,
    )
    text = re.sub(
        r"homepage:\s*\(product docs — internal\)\S*",
        "homepage: https://fromdonna.ai",
        text,
    )

    # "debugging-hermes-tui-commands" related skill name — product skill id
    text = re.sub(r"\bdebugging-hermes-tui-commands\b", "debugging-tui-commands", text)

    # "Attach to Hermes" already → "Attach to Donna"

    # Remaining lowercase bare `hermes` in prose that is product, not CLI:
    # be conservative — only clear product phrases
    text = re.sub(r"\bship with hermes\b", "ship with the agent", text)
    text = re.sub(r"\bhermes users\b", "agent users", text)
    text = re.sub(r"\bdonna-agent users\b", "Donna users", text)

    return text


def process_file(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    protected, stored = protect(original)
    sanitized = sanitize_body(protected)
    result = restore(sanitized, stored)

    # Safety: never leave protect placeholders
    if "\x00PROT" in result:
        # try restore again for nested edge cases
        result = restore(result, stored)
    if "\x00PROT" in result:
        print(f"ERROR: leftover placeholders in {path}", file=sys.stderr)
        return False

    if result != original:
        path.write_text(result, encoding="utf-8")
        return True
    return False


def main() -> int:
    updated = 0
    total = 0
    for root in ROOTS:
        if not root.exists():
            print(f"skip missing root {root}")
            continue
        for path in sorted(root.rglob("SKILL.md")):
            total += 1
            if process_file(path):
                updated += 1
                print(f"updated: {path}")
    print(f"\nDone: {updated}/{total} SKILL.md files updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
