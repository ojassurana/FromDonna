-- Sticky Composio tool-router session per Donna user (reuse across E2B recreate).
-- Hermes capability Bearer (30d default) is still re-minted on bootstrap; composio_session_id
-- and composio_mcp_url (upstream Composio hosted MCP target, not product /mcp) persist.

ALTER TABLE user_composio ADD COLUMN composio_session_id TEXT;
ALTER TABLE user_composio ADD COLUMN composio_mcp_url TEXT;
