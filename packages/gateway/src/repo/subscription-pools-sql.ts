import { assertSubscriptionPool, SubscriptionPoolConflictError, type SubscriptionPool, type SubscriptionPoolAccountRuntime, type SubscriptionPoolLease, type SubscriptionPoolsRepo } from './subscription-pools.ts';
import type { SqlDatabase } from '@floway-dev/platform';

interface PoolRow {
  id: string;
  name: string;
  provider: SubscriptionPool['provider'];
  enabled: number;
  max_concurrent_requests: number | null;
  created_at: string;
}

const conflicts = [
  'Subscription pool provider mismatch',
  'Subscription pool has active requests',
  'Subscription pool has open conversations',
  'UNIQUE constraint failed: subscription_pool_members.upstream_id',
];

export class SqlSubscriptionPoolsRepo implements SubscriptionPoolsRepo {
  constructor(private readonly db: SqlDatabase) {}

  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Error && conflicts.some(message => error.message.includes(message))) {
        throw new SubscriptionPoolConflictError(error.message, error);
      }
      throw error;
    }
  }

  async list(): Promise<SubscriptionPool[]> {
    const { results: rows } = await this.db.prepare('SELECT * FROM subscription_pools ORDER BY created_at, id').all<PoolRow>();
    const { results: members } = await this.db.prepare('SELECT pool_id, upstream_id FROM subscription_pool_members ORDER BY upstream_id').all<{ pool_id: string; upstream_id: string }>();
    return rows.map(row => ({
      id: row.id, name: row.name, provider: row.provider, enabled: row.enabled === 1,
      maxConcurrentRequests: row.max_concurrent_requests, createdAt: row.created_at,
      upstreamIds: members.filter(member => member.pool_id === row.id).map(member => member.upstream_id),
    }));
  }

  async get(id: string): Promise<SubscriptionPool | null> {
    return (await this.list()).find(pool => pool.id === id) ?? null;
  }

  async save(pool: SubscriptionPool): Promise<void> {
    assertSubscriptionPool(pool);
    if (!this.db.batch) throw new Error('Subscription pool configuration requires atomic database batches');
    await this.guarded(async () => {
      await this.db.batch!([
        this.db.prepare('DELETE FROM subscription_pool_leases WHERE expires_at <= ?').bind(Date.now()),
        this.db.prepare(`INSERT INTO subscription_pools (id, name, provider, enabled, max_concurrent_requests, created_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, provider = excluded.provider, enabled = excluded.enabled,
          max_concurrent_requests = excluded.max_concurrent_requests`).bind(
          pool.id, pool.name, pool.provider, pool.enabled ? 1 : 0, pool.maxConcurrentRequests, pool.createdAt,
        ),
        this.db.prepare(`DELETE FROM subscription_pool_members WHERE pool_id = ?
          AND upstream_id NOT IN (SELECT value FROM json_each(?))`).bind(pool.id, JSON.stringify(pool.upstreamIds)),
        this.db.prepare(`INSERT INTO subscription_pool_members (pool_id, upstream_id)
          SELECT ?, incoming.value FROM json_each(?) AS incoming
          WHERE NOT EXISTS (SELECT 1 FROM subscription_pool_members WHERE upstream_id = incoming.value AND pool_id = ?)`)
          .bind(pool.id, JSON.stringify(pool.upstreamIds), pool.id),
      ]);
    });
  }

  async delete(id: string): Promise<boolean> {
    await this.db.prepare('DELETE FROM subscription_pool_leases WHERE expires_at <= ?').bind(Date.now()).run();
    return await this.guarded(async () => {
      const result = await this.db.prepare('DELETE FROM subscription_pools WHERE id = ?').bind(id).run();
      return (result.meta.changes ?? 0) > 0;
    });
  }

  async deleteAll(): Promise<void> {
    if (!this.db.batch) throw new Error('Subscription pool replacement requires atomic database batches');
    await this.db.batch([
      this.db.prepare('DELETE FROM subscription_conversation_turns'),
      this.db.prepare('DELETE FROM subscription_conversation_migrations'),
      this.db.prepare('DELETE FROM subscription_conversations'),
      this.db.prepare('DELETE FROM subscription_pool_leases'),
      this.db.prepare('DELETE FROM subscription_pools'),
    ]);
  }

  async runtime(poolId: string, now: number): Promise<SubscriptionPoolAccountRuntime[]> {
    const { results: members } = await this.db.prepare(`SELECT m.upstream_id, m.selections, m.accept_new_sessions,
      (SELECT count(*) FROM subscription_pool_leases AS l WHERE l.upstream_id = m.upstream_id AND l.expires_at > ?) AS in_flight
      FROM subscription_pool_members AS m WHERE m.pool_id = ? ORDER BY m.upstream_id`).bind(now, poolId)
      .all<{ upstream_id: string; selections: number; in_flight: number; accept_new_sessions: number }>();
    const { results: cooldowns } = await this.db.prepare(`SELECT c.upstream_id, c.model_key, c.until_at, c.status, c.failures
      FROM subscription_pool_cooldowns AS c JOIN subscription_pool_members AS m ON m.upstream_id = c.upstream_id
      WHERE m.pool_id = ? AND c.until_at > ?`).bind(poolId, now)
      .all<{ upstream_id: string; model_key: string; until_at: number; status: number; failures: number }>();
    return members.map(member => ({
      upstreamId: member.upstream_id, selections: member.selections, inFlight: member.in_flight, acceptNewSessions: member.accept_new_sessions === 1,
      cooldowns: cooldowns.filter(item => item.upstream_id === member.upstream_id)
        .map(item => ({ modelKey: item.model_key, until: item.until_at, status: item.status, failures: item.failures })),
    }));
  }

  async acquire(input: Parameters<SubscriptionPoolsRepo['acquire']>[0]): Promise<SubscriptionPoolLease | null> {
    await this.db.prepare('DELETE FROM subscription_pool_leases WHERE pool_id = ? AND expires_at <= ?').bind(input.poolId, input.now).run();
    const row = await this.db.prepare(`INSERT INTO subscription_pool_leases (token, pool_id, upstream_id, account_identity, expires_at)
      SELECT ?, p.id, m.upstream_id, json_extract(candidate.value, '$.identity'), ?
      FROM subscription_pool_members AS m JOIN subscription_pools AS p ON p.id = m.pool_id
      JOIN upstreams AS u ON u.id = m.upstream_id
      JOIN json_each(?) AS candidate ON json_extract(candidate.value, '$.upstreamId') = m.upstream_id
      WHERE p.id = ? AND (p.enabled = 1 OR EXISTS (
          SELECT 1 FROM subscription_conversations AS bound WHERE bound.id = ? AND bound.pool_id = p.id
            AND bound.api_key_id = ? AND bound.phase <> 'closed'))
        AND u.enabled = 1 AND u.provider = p.provider
        AND (? = 0 OR m.accept_new_sessions = 1)
        AND NOT EXISTS (SELECT 1 FROM subscription_pool_cooldowns AS c
          WHERE c.upstream_id = m.upstream_id AND c.model_key = ? AND c.until_at > ?)
        AND (p.max_concurrent_requests IS NULL OR
          (SELECT count(*) FROM subscription_pool_leases AS l WHERE l.account_identity = json_extract(candidate.value, '$.identity') AND l.expires_at > ?) < p.max_concurrent_requests)
      ORDER BY
        CASE WHEN ? = 1 THEN (
          SELECT count(*) FROM subscription_conversations AS bound
          WHERE bound.account_identity = json_extract(candidate.value, '$.identity')
            AND bound.phase <> 'closed' AND bound.last_seen_at >= ?) ELSE 0 END,
        (SELECT count(*) FROM subscription_pool_leases AS l WHERE l.account_identity = json_extract(candidate.value, '$.identity') AND l.expires_at > ?),
        COALESCE(json_extract(candidate.value, '$.utilization'), 0.5),
        m.selections, m.upstream_id
      LIMIT 1 RETURNING upstream_id, account_identity`).bind(
      input.token, input.expiresAt, JSON.stringify(input.candidates), input.poolId,
      input.conversation?.id ?? null, input.conversation?.apiKeyId ?? null, input.conversation?.isNew ? 1 : 0,
      input.modelKey, input.now, input.now, input.conversation?.isNew ? 1 : 0, input.now - 30 * 60_000, input.now,
    ).first<{ upstream_id: string; account_identity: string }>();
    if (row === null) return null;
    await this.db.prepare('UPDATE subscription_pool_members SET selections = selections + 1 WHERE upstream_id = ?').bind(row.upstream_id).run();
    return { token: input.token, poolId: input.poolId, upstreamId: row.upstream_id, identity: row.account_identity, expiresAt: input.expiresAt };
  }

  async renew(token: string, now: number, expiresAt: number): Promise<boolean> {
    const result = await this.db.prepare('UPDATE subscription_pool_leases SET expires_at = ? WHERE token = ? AND expires_at > ?')
      .bind(expiresAt, token, now).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async release(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM subscription_pool_leases WHERE token = ?').bind(token).run();
  }

  async isLeaseActive(token: string, now: number): Promise<boolean> {
    return await this.db.prepare('SELECT token FROM subscription_pool_leases WHERE token = ? AND expires_at > ?')
      .bind(token, now).first() !== null;
  }

  async setAcceptNewSessions(upstreamId: string, accept: boolean): Promise<boolean> {
    const result = await this.db.prepare('UPDATE subscription_pool_members SET accept_new_sessions = ? WHERE upstream_id = ?')
      .bind(accept ? 1 : 0, upstreamId).run();
    return result.meta.changes === 1;
  }

  async observe(input: Parameters<SubscriptionPoolsRepo['observe']>[0]): Promise<void> {
    if (input.cooldownUntil === null) {
      await this.db.prepare('DELETE FROM subscription_pool_cooldowns WHERE upstream_id = ? AND model_key = ?').bind(input.upstreamId, input.modelKey).run();
      return;
    }
    await this.db.prepare(`INSERT INTO subscription_pool_cooldowns (upstream_id, model_key, until_at, status, failures)
      VALUES (?, ?, ?, ?, 1) ON CONFLICT(upstream_id, model_key) DO UPDATE SET
      until_at = max(subscription_pool_cooldowns.until_at, excluded.until_at),
      status = excluded.status, failures = subscription_pool_cooldowns.failures + 1`)
      .bind(input.upstreamId, input.modelKey, input.cooldownUntil, input.status).run();
  }

  async reset(upstreamId: string): Promise<void> {
    await this.db.prepare('DELETE FROM subscription_pool_cooldowns WHERE upstream_id = ?').bind(upstreamId).run();
  }
}
