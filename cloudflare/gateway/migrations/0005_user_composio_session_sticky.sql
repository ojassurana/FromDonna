-- Sticky Composio tool-router session per Donna user (reuse across E2B recreate).
-- Short-lived Hermes Bearer is still re-minted; composio_session_id/mcp_url persist.

ALTER TABLE user_composio ADD COLUMN composio_session_id TEXT;
ALTER TABLE user_composio ADD COLUMN composio_mcp_url TEXT;
