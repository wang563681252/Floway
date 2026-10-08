CREATE TABLE subscription_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude-code')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  max_concurrent_requests INTEGER CHECK (
    max_concurrent_requests IS NULL OR
    (typeof(max_concurrent_requests) = 'integer' AND max_concurrent_requests > 0)
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE subscription_pool_members (
  upstream_id TEXT PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL REFERENCES subscription_pools(id) ON DELETE CASCADE,
  selections INTEGER NOT NULL DEFAULT 0 CHECK (selections >= 0)
);
CREATE INDEX subscription_pool_members_pool ON subscription_pool_members(pool_id);

CREATE TABLE subscription_pool_leases (
  token TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES subscription_pools(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES subscription_pool_members(upstream_id) ON DELETE CASCADE,
  account_identity TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX subscription_pool_leases_account_expiry ON subscription_pool_leases(upstream_id, expires_at);
CREATE INDEX subscription_pool_leases_identity_expiry ON subscription_pool_leases(account_identity, expires_at);

CREATE TABLE subscription_pool_cooldowns (
  upstream_id TEXT NOT NULL REFERENCES subscription_pool_members(upstream_id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  until_at INTEGER NOT NULL,
  status INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, model_key)
);

CREATE TRIGGER subscription_pool_provider_insert
BEFORE INSERT ON subscription_pool_members
WHEN (SELECT provider FROM upstreams WHERE id = NEW.upstream_id)
  IS NOT (SELECT provider FROM subscription_pools WHERE id = NEW.pool_id)
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool provider mismatch');
END;

CREATE TRIGGER subscription_pool_upstream_provider_update
BEFORE UPDATE OF provider ON upstreams
WHEN EXISTS (
  SELECT 1 FROM subscription_pool_members AS m
  JOIN subscription_pools AS p ON p.id = m.pool_id
  WHERE m.upstream_id = NEW.id AND p.provider IS NOT NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool provider mismatch');
END;

CREATE TRIGGER subscription_pool_provider_update
BEFORE UPDATE OF provider ON subscription_pools
WHEN EXISTS (SELECT 1 FROM subscription_pool_members WHERE pool_id = OLD.id)
  AND NEW.provider IS NOT OLD.provider
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool provider mismatch');
END;

CREATE TRIGGER subscription_pool_member_busy
BEFORE DELETE ON subscription_pool_members
WHEN EXISTS (SELECT 1 FROM subscription_pool_leases WHERE upstream_id = OLD.upstream_id)
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool has active requests');
END;

CREATE TRIGGER subscription_pool_delete_busy
BEFORE DELETE ON subscription_pools
WHEN EXISTS (SELECT 1 FROM subscription_pool_leases WHERE pool_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Subscription pool has active requests');
END;
