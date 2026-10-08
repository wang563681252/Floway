ALTER TABLE subscription_pool_members ADD COLUMN accept_new_sessions INTEGER NOT NULL DEFAULT 1
  CHECK (accept_new_sessions IN (0, 1));

CREATE TABLE subscription_conversations (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES subscription_pools(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  account_identity TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  phase TEXT NOT NULL CHECK (phase IN ('active', 'preparing', 'dispatched', 'uncertain', 'blocked', 'closed')),
  last_seen_at INTEGER NOT NULL,
  context_hash TEXT,
  context_length INTEGER NOT NULL DEFAULT 0 CHECK (context_length >= 0),
  settings_hash TEXT,
  model_key TEXT,
  portable INTEGER NOT NULL DEFAULT 0 CHECK (portable IN (0, 1)),
  blocked_reason TEXT,
  target_upstream_id TEXT,
  target_identity TEXT,
  request_token TEXT,
  lease_token TEXT,
  turn_key TEXT,
  request_hash TEXT,
  lock_until INTEGER,
  migrations INTEGER NOT NULL DEFAULT 0
    CHECK (migrations >= 0),
  migration_requested INTEGER NOT NULL DEFAULT 0 CHECK (migration_requested IN (0, 1))
);
CREATE INDEX subscription_conversations_pool ON subscription_conversations(pool_id, last_seen_at);
CREATE INDEX subscription_conversations_account ON subscription_conversations(account_identity, last_seen_at);

CREATE TABLE subscription_conversation_turns (
  conversation_id TEXT NOT NULL REFERENCES subscription_conversations(id) ON DELETE CASCADE,
  turn_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('completed', 'uncertain')),
  PRIMARY KEY (conversation_id, turn_key)
);

CREATE TABLE subscription_conversation_migrations (
  conversation_id TEXT NOT NULL REFERENCES subscription_conversations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  from_upstream_id TEXT NOT NULL,
  to_upstream_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, version)
);

CREATE TRIGGER subscription_conversation_pool_busy
BEFORE DELETE ON subscription_pools
WHEN EXISTS (SELECT 1 FROM subscription_conversations WHERE pool_id = OLD.id AND phase <> 'closed')
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool has open conversations');
END;

CREATE TRIGGER subscription_conversation_owner_busy
BEFORE DELETE ON subscription_conversations
WHEN OLD.phase IN ('preparing', 'dispatched') OR (OLD.phase = 'uncertain' AND OLD.request_token IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Conversation has active or uncertain execution');
END;
