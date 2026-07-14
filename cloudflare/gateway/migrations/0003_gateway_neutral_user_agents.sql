-- Gateway-neutral routing: an agent belongs to a product user, while a gateway
-- supplies the external identity and current conversation/delivery target.
-- Runtime fields deliberately describe an implementation, not a channel.

CREATE TABLE user_agents (
  user_id TEXT PRIMARY KEY,
  gateway TEXT NOT NULL,
  gateway_user_id TEXT NOT NULL,
  gateway_conversation_id TEXT NOT NULL,
  runtime_provider TEXT NOT NULL DEFAULT 'e2b',
  runtime_id TEXT NOT NULL,
  runtime_domain TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('provisioning', 'ready', 'failed')),
  provisioning_started_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (gateway, gateway_user_id)
);

-- Preserve every existing Telegram route as a gateway identity; subsequent
-- gateways use the same neutral columns with their own gateway value.
INSERT INTO user_agents (
  user_id,
  gateway,
  gateway_user_id,
  gateway_conversation_id,
  runtime_provider,
  runtime_id,
  runtime_domain,
  status,
  provisioning_started_at,
  created_at,
  updated_at
)
SELECT
  user_id,
  'telegram',
  telegram_user_id,
  telegram_chat_id,
  'e2b',
  e2b_sandbox_id,
  e2b_sandbox_domain,
  status,
  provisioning_started_at,
  created_at,
  updated_at
FROM telegram_user_sandboxes;

DROP TABLE telegram_user_sandboxes;

CREATE INDEX idx_user_agents_gateway_conversation
  ON user_agents (gateway, gateway_conversation_id);
