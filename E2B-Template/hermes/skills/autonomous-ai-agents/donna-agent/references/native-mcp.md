# Native MCP client (Donna)

Donna can use MCP tools that are already wired into the session (for example Composio). Prefer live tools in the tool list over inventing config or upstream product docs.

## When this matters

- User wants external app capabilities already connected via MCP
- You need manage-connections / search / execute tools from an MCP server already in `mcp_servers`

## Product rules (FromDonna)

1. Connected apps go through Composio MCP only — load skill `connect-apps`.
2. Do not invent alternate OAuth or host-level MCP install instructions for the user.
3. Do not cite upstream engine product docs as the product source of truth.

## Paths (runtime)

Config and agent home may use `~/.hermes/` / `$HERMES_HOME` on disk. That is an implementation path, not a product brand name for the user.
