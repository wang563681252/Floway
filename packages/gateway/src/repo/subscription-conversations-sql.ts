import type { ConversationClaimResult, SubscriptionConversation, SubscriptionConversationMigration, SubscriptionConversationsRepo } from './subscription-conversations.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';

interface ConversationRow {
  id: string; pool_id: string; api_key_id: string; upstream_id: string; account_identity: string;
  version: number; phase: SubscriptionConversation['phase']; last_seen_at: number;
  context_hash: string | null; context_length: number; settings_hash: string | null; model_key: string | null; portable: number;
  blocked_reason: string | null; target_upstream_id: string | null; target_identity: string | null;
  request_token: string | null; lease_token: string | null; turn_key: string | null; request_hash: string | null;
  lock_until: number | null; migrations: number; migration_requested: number;
}

const decode = (row: ConversationRow): SubscriptionConversation => ({
  id: row.id, poolId: row.pool_id, apiKeyId: row.api_key_id, upstreamId: row.upstream_id,
  accountIdentity: row.account_identity, version: row.version, phase: row.phase,
  lastSeenAt: row.last_seen_at, contextHash: row.context_hash, contextLength: row.context_length,
  settingsHash: row.settings_hash, portable: row.portable === 1, blockedReason: row.blocked_reason,
  modelKey: row.model_key,
  targetUpstreamId: row.target_upstream_id, targetIdentity: row.target_identity, requestToken: row.request_token,
  leaseToken: row.lease_token,
  turnKey: row.turn_key, requestHash: row.request_hash, lockUntil: row.lock_until, migrations: row.migrations,
  migrationRequested: row.migration_requested === 1,
});

export class SqlSubscriptionConversationsRepo implements SubscriptionConversationsRepo {
  constructor(private readonly db: SqlDatabase) {}

  private async batch(statements: SqlPreparedStatement[]): Promise<void> {
    if (!this.db.batch) throw new Error('Conversation state requires atomic database batches');
    await this.db.batch(statements);
  }

  private async recover(id: string, now = Date.now()): Promise<void> {
    await this.batch([
      this.db.prepare(`UPDATE subscription_conversations SET
        phase = CASE WHEN blocked_reason IS NULL THEN 'active' ELSE 'blocked' END,
        request_token = NULL, lease_token = NULL, target_upstream_id = NULL, target_identity = NULL, lock_until = NULL,
        turn_key = NULL, request_hash = NULL
        WHERE id = ? AND phase = 'preparing' AND lock_until <= ?
          AND NOT EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = subscription_conversations.lease_token AND expires_at > ?)`).bind(id, now, now),
      this.db.prepare(`UPDATE subscription_conversations SET phase = 'uncertain',
        blocked_reason = 'execution_uncertain'
        WHERE id = ? AND phase = 'dispatched' AND lock_until <= ?
          AND NOT EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = subscription_conversations.lease_token AND expires_at > ?)`).bind(id, now, now),
    ]);
  }

  async get(id: string): Promise<SubscriptionConversation | null> {
    await this.recover(id);
    const row = await this.db.prepare('SELECT * FROM subscription_conversations WHERE id = ?').bind(id).first<ConversationRow>();
    return row ? decode(row) : null;
  }

  async list(poolId: string): Promise<SubscriptionConversation[]> {
    const { results } = await this.db.prepare('SELECT * FROM subscription_conversations WHERE pool_id = ? ORDER BY last_seen_at DESC').bind(poolId).all<ConversationRow>();
    for (const row of results) await this.recover(row.id);
    const refreshed = await this.db.prepare('SELECT * FROM subscription_conversations WHERE pool_id = ? ORDER BY last_seen_at DESC').bind(poolId).all<ConversationRow>();
    return refreshed.results.map(decode);
  }

  async history(id: string): Promise<SubscriptionConversationMigration[]> {
    const { results } = await this.db.prepare(`SELECT conversation_id, version, from_upstream_id, to_upstream_id, occurred_at
      FROM subscription_conversation_migrations WHERE conversation_id = ? ORDER BY version DESC`).bind(id)
      .all<{ conversation_id: string; version: number; from_upstream_id: string; to_upstream_id: string; occurred_at: number }>();
    return results.map(row => ({
      conversationId: row.conversation_id, version: row.version,
      fromUpstreamId: row.from_upstream_id, toUpstreamId: row.to_upstream_id, occurredAt: row.occurred_at,
    }));
  }

  async start(input: Parameters<SubscriptionConversationsRepo['start']>[0]): Promise<ConversationClaimResult> {
    await this.recover(input.id, input.now);
    if (input.turnKey !== null) {
      const previous = await this.db.prepare('SELECT phase FROM subscription_conversation_turns WHERE conversation_id = ? AND turn_key = ?')
        .bind(input.id, input.turnKey).first<{ phase: string }>();
      if (previous) return { kind: previous.phase === 'completed' ? 'repeated' : 'uncertain' };
    }
    if (input.expectedVersion === null) {
      await this.db.prepare(`INSERT INTO subscription_conversations (
        id, pool_id, api_key_id, upstream_id, account_identity, phase, last_seen_at,
        target_upstream_id, target_identity, request_token, lease_token, turn_key, request_hash, lock_until
      ) SELECT ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = ? AND pool_id = ? AND upstream_id = ? AND account_identity = ? AND expires_at > ?)
        ON CONFLICT(id) DO NOTHING`).bind(
        input.id, input.poolId, input.apiKeyId, input.upstreamId, input.identity, input.now,
        input.upstreamId, input.identity, input.requestToken, input.leaseToken, input.turnKey, input.requestHash, input.lockUntil,
        input.leaseToken, input.poolId, input.upstreamId, input.identity, input.now,
      ).run();
    } else {
      await this.db.prepare(`UPDATE subscription_conversations SET phase = 'preparing',
        target_upstream_id = ?, target_identity = ?, request_token = ?, lease_token = ?, turn_key = ?, request_hash = ?,
        lock_until = ?, last_seen_at = ?
        WHERE id = ? AND version = ? AND api_key_id = ? AND pool_id = ?
          AND phase IN ('active', 'blocked') AND request_token IS NULL
          AND (? = 1 OR (upstream_id = ? AND account_identity = ?))
          AND EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = ? AND pool_id = ? AND upstream_id = ? AND account_identity = ? AND expires_at > ?)`)
        .bind(input.upstreamId, input.identity, input.requestToken, input.leaseToken, input.turnKey, input.requestHash,
          input.lockUntil, input.now, input.id, input.expectedVersion, input.apiKeyId, input.poolId,
          input.migration ? 1 : 0, input.upstreamId, input.identity,
          input.leaseToken, input.poolId, input.upstreamId, input.identity, input.now).run();
    }
    const row = await this.get(input.id);
    if (row?.requestToken === input.requestToken) return { kind: 'claimed', claim: { conversation: row, migration: input.migration, leaseToken: input.leaseToken } };
    if (row?.phase === 'uncertain') return { kind: 'uncertain' };
    if (row?.phase === 'preparing' || row?.phase === 'dispatched') return { kind: 'busy' };
    return { kind: 'conflict' };
  }

  async dispatched(id: string, token: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE subscription_conversations SET phase = 'dispatched'
      WHERE id = ? AND request_token = ? AND phase = 'preparing'
        AND EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = subscription_conversations.lease_token AND expires_at > ?)`).bind(id, token, Date.now()).run();
    if (result.meta.changes !== 1) throw new Error('Conversation dispatch lost its owner');
  }

  async finish(input: Parameters<SubscriptionConversationsRepo['finish']>[0]): Promise<void> {
    const row = await this.get(input.id);
    if (!row || row.requestToken !== input.token) throw new Error('Conversation completion lost its owner');
    if (input.phase === 'completed' && (input.contextHash === undefined || input.contextLength === undefined || input.settingsHash === undefined || input.modelKey === undefined || input.portable === undefined)) {
      throw new Error('Completed conversation is missing its exact context proof');
    }
    const statements: SqlPreparedStatement[] = [];
    if (row.turnKey !== null && input.phase !== 'rejected' && input.phase !== 'blocked') {
      statements.push(this.db.prepare(`INSERT INTO subscription_conversation_turns (conversation_id, turn_key, request_hash, phase)
        SELECT id, turn_key, request_hash, ? FROM subscription_conversations WHERE id = ? AND request_token = ?
        ON CONFLICT(conversation_id, turn_key) DO UPDATE SET phase = excluded.phase`)
        .bind(input.phase, input.id, input.token));
    }
    if (input.phase === 'completed' && input.contextHash !== undefined && input.contextLength !== undefined && input.settingsHash !== undefined && input.modelKey !== undefined) {
      if (row.targetUpstreamId === null || row.targetIdentity === null) throw new Error('Conversation completion has no target account');
      statements.push(this.db.prepare(`INSERT INTO subscription_conversation_migrations
        (conversation_id, version, from_upstream_id, to_upstream_id, occurred_at)
        SELECT id, version + 1, upstream_id, target_upstream_id, ? FROM subscription_conversations
        WHERE id = ? AND request_token = ? AND (upstream_id <> target_upstream_id OR account_identity <> target_identity)`)
        .bind(Date.now(), input.id, input.token));
      statements.push(this.db.prepare(`UPDATE subscription_conversations SET
        migrations = migrations + CASE WHEN upstream_id <> target_upstream_id OR account_identity <> target_identity THEN 1 ELSE 0 END,
        upstream_id = target_upstream_id, account_identity = target_identity, version = version + 1,
        phase = 'active', context_hash = ?, context_length = ?, settings_hash = ?, model_key = ?, portable = ?, last_seen_at = ?,
        blocked_reason = NULL, migration_requested = 0, request_token = NULL, lease_token = NULL, target_upstream_id = NULL, target_identity = NULL, lock_until = NULL
        WHERE id = ? AND request_token = ?`).bind(
        input.contextHash, input.contextLength, input.settingsHash, input.modelKey, input.portable ? 1 : 0, Date.now(), input.id, input.token,
      ));
    } else if (input.phase === 'uncertain') {
      statements.push(this.db.prepare(`UPDATE subscription_conversations SET phase = 'uncertain', blocked_reason = ?
        WHERE id = ? AND request_token = ?`).bind(input.reason ?? 'execution_uncertain', input.id, input.token));
    } else {
      statements.push(this.db.prepare(`UPDATE subscription_conversations SET phase = 'blocked', blocked_reason = ?,
        request_token = NULL, lease_token = NULL, target_upstream_id = NULL, target_identity = NULL, lock_until = NULL
        WHERE id = ? AND request_token = ?`).bind(input.reason ?? 'upstream_rejected', input.id, input.token));
    }
    await this.batch(statements);
  }

  async block(id: string, reason: string): Promise<void> {
    await this.db.prepare(`UPDATE subscription_conversations SET phase = 'blocked', blocked_reason = ?, version = version + 1
      WHERE id = ? AND phase IN ('active', 'blocked') AND request_token IS NULL`).bind(reason, id).run();
  }

  async requestMigration(id: string, expectedVersion: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE subscription_conversations SET phase = 'blocked', blocked_reason = 'migration_requested',
      migration_requested = 1, version = version + 1
      WHERE id = ? AND version = ? AND phase IN ('active', 'blocked') AND request_token IS NULL AND portable = 1 AND context_hash IS NOT NULL`)
      .bind(id, expectedVersion).run();
    return result.meta.changes === 1;
  }

  async cancelMigration(id: string, expectedVersion: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE subscription_conversations SET phase = 'active', blocked_reason = NULL,
      migration_requested = 0, version = version + 1
      WHERE id = ? AND version = ? AND phase IN ('active', 'blocked') AND request_token IS NULL AND migration_requested = 1`)
      .bind(id, expectedVersion).run();
    return result.meta.changes === 1;
  }

  async close(id: string, expectedVersion: number, acknowledgeUncertain = false): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE subscription_conversations SET phase = 'closed', version = version + 1,
      migration_requested = 0, request_token = NULL, lease_token = NULL, lock_until = NULL
      WHERE id = ? AND version = ?
        AND ((phase IN ('active', 'blocked') AND request_token IS NULL) OR (phase = 'uncertain' AND ? = 1))
        AND NOT EXISTS (SELECT 1 FROM subscription_pool_leases WHERE token = subscription_conversations.lease_token AND expires_at > ?)`)
      .bind(id, expectedVersion, acknowledgeUncertain ? 1 : 0, Date.now()).run();
    return result.meta.changes === 1;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM subscription_conversations').run();
  }
}
