import type { ConversationClaimResult, SubscriptionConversation, SubscriptionConversationMigration, SubscriptionConversationsRepo } from '../../src/repo/subscription-conversations.ts';
import type { SubscriptionPoolsRepo } from '../../src/repo/subscription-pools.ts';

export class MemorySubscriptionConversationsRepo implements SubscriptionConversationsRepo {
  private readonly rows = new Map<string, SubscriptionConversation>();
  private readonly turns = new Map<string, 'completed' | 'uncertain'>();
  private readonly migrations = new Map<string, SubscriptionConversationMigration[]>();

  constructor(private readonly pools: SubscriptionPoolsRepo) {}

  private async recover(row: SubscriptionConversation): Promise<void> {
    if ((row.phase !== 'preparing' && row.phase !== 'dispatched') || row.lockUntil === null || row.lockUntil > Date.now()) return;
    // A live heartbeat still owns the conversation after the initial lock horizon.
    if (row.leaseToken && await this.pools.isLeaseActive(row.leaseToken, Date.now())) return;
    if (row.phase === 'dispatched') {
      row.phase = 'uncertain';
      row.blockedReason = 'execution_uncertain';
    } else {
      row.phase = row.blockedReason === null ? 'active' : 'blocked';
      row.requestToken = null;
      row.leaseToken = null;
      row.targetIdentity = null;
      row.targetUpstreamId = null;
      row.lockUntil = null;
      row.turnKey = null;
      row.requestHash = null;
    }
  }

  async get(id: string): Promise<SubscriptionConversation | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    await this.recover(row);
    return { ...row };
  }

  async list(poolId: string): Promise<SubscriptionConversation[]> {
    const output: SubscriptionConversation[] = [];
    for (const row of this.rows.values()) {
      if (row.poolId !== poolId) continue;
      await this.recover(row);
      output.push({ ...row });
    }
    return output.toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  async start(input: Parameters<SubscriptionConversationsRepo['start']>[0]): Promise<ConversationClaimResult> {
    if (!await this.pools.isLeaseActive(input.leaseToken, input.now)) return { kind: 'conflict' };
    const previous = await this.get(input.id);
    if (input.turnKey) {
      const turn = this.turns.get(JSON.stringify([input.id, input.turnKey]));
      if (turn) return { kind: turn === 'completed' ? 'repeated' : 'uncertain' };
    }
    const row = this.rows.get(input.id);
    if (row?.phase === 'uncertain') return { kind: 'uncertain' };
    if (row?.requestToken !== null && row?.requestToken !== undefined) return { kind: 'busy' };
    if (input.expectedVersion === null) {
      if (previous) return { kind: 'conflict' };
      this.rows.set(input.id, {
        id: input.id, poolId: input.poolId, apiKeyId: input.apiKeyId, upstreamId: input.upstreamId,
        accountIdentity: input.identity, version: 1, phase: 'preparing', lastSeenAt: input.now,
        contextHash: null, contextLength: 0, settingsHash: null, modelKey: null, portable: false, blockedReason: null,
        targetUpstreamId: input.upstreamId, targetIdentity: input.identity, requestToken: input.requestToken,
        leaseToken: input.leaseToken, turnKey: input.turnKey, requestHash: input.requestHash, lockUntil: input.lockUntil, migrations: 0, migrationRequested: false,
      });
    } else {
      if (!row || row.version !== input.expectedVersion || row.apiKeyId !== input.apiKeyId || row.poolId !== input.poolId
        || !['active', 'blocked'].includes(row.phase)
        || (!input.migration && (row.upstreamId !== input.upstreamId || row.accountIdentity !== input.identity))) return { kind: 'conflict' };
      row.phase = 'preparing';
      row.targetUpstreamId = input.upstreamId;
      row.targetIdentity = input.identity;
      row.requestToken = input.requestToken;
      row.leaseToken = input.leaseToken;
      row.turnKey = input.turnKey;
      row.requestHash = input.requestHash;
      row.lockUntil = input.lockUntil;
      row.lastSeenAt = input.now;
    }
    const claimed = this.rows.get(input.id);
    if (!claimed) throw new Error('Conversation disappeared after being claimed');
    return { kind: 'claimed', claim: { conversation: { ...claimed }, migration: input.migration, leaseToken: input.leaseToken } };
  }

  async history(id: string): Promise<SubscriptionConversationMigration[]> {
    return [...this.migrations.get(id) ?? []].toReversed().map(migration => ({ ...migration }));
  }

  async dispatched(id: string, token: string): Promise<void> {
    const row = this.rows.get(id);
    if (row?.requestToken !== token || row.phase !== 'preparing') throw new Error('Conversation dispatch lost its owner');
    if (row.leaseToken === null || !await this.pools.isLeaseActive(row.leaseToken, Date.now())) throw new Error('Conversation dispatch lost its account lease');
    row.phase = 'dispatched';
  }

  async finish(input: Parameters<SubscriptionConversationsRepo['finish']>[0]): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row || row.requestToken !== input.token) throw new Error('Conversation completion lost its owner');
    if (input.phase === 'completed') {
      if (input.contextHash === undefined || input.contextLength === undefined || input.settingsHash === undefined || input.modelKey === undefined || input.portable === undefined) {
        throw new Error('Completed conversation is missing its exact context proof');
      }
      if (row.targetUpstreamId === null || row.targetIdentity === null) throw new Error('Conversation completion has no target account');
      if (row.upstreamId !== row.targetUpstreamId || row.accountIdentity !== row.targetIdentity) {
        row.migrations++;
        const history = this.migrations.get(row.id) ?? [];
        history.push({
          conversationId: row.id, version: row.version + 1, fromUpstreamId: row.upstreamId,
          toUpstreamId: row.targetUpstreamId, occurredAt: Date.now(),
        });
        this.migrations.set(row.id, history);
      }
      row.upstreamId = row.targetUpstreamId;
      row.accountIdentity = row.targetIdentity;
      row.version++;
      row.phase = 'active';
      row.contextHash = input.contextHash;
      row.contextLength = input.contextLength;
      row.settingsHash = input.settingsHash;
      row.modelKey = input.modelKey;
      row.lastSeenAt = Date.now();
      row.portable = input.portable;
      row.blockedReason = null;
      row.migrationRequested = false;
    } else {
      row.phase = input.phase === 'uncertain' ? 'uncertain' : 'blocked';
      row.blockedReason = input.reason ?? (input.phase === 'uncertain' ? 'execution_uncertain' : 'upstream_rejected');
    }
    if (row.turnKey && (input.phase === 'completed' || input.phase === 'uncertain')) {
      this.turns.set(JSON.stringify([row.id, row.turnKey]), input.phase);
    }
    if (input.phase !== 'uncertain') {
      row.requestToken = null;
      row.leaseToken = null;
      row.targetUpstreamId = null;
      row.targetIdentity = null;
      row.lockUntil = null;
    }
  }

  async block(id: string, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && ['active', 'blocked'].includes(row.phase) && row.requestToken === null) {
      row.phase = 'blocked';
      row.blockedReason = reason;
      row.version++;
    }
  }

  async requestMigration(id: string, expectedVersion: number): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.version !== expectedVersion || !['active', 'blocked'].includes(row.phase) || row.requestToken !== null || !row.portable || row.contextHash === null) return false;
    await this.block(id, 'migration_requested');
    row.migrationRequested = true;
    return true;
  }

  async cancelMigration(id: string, expectedVersion: number): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.version !== expectedVersion || !['active', 'blocked'].includes(row.phase) || row.requestToken !== null || !row.migrationRequested) return false;
    row.phase = 'active';
    row.blockedReason = null;
    row.migrationRequested = false;
    row.version++;
    return true;
  }

  async close(id: string, expectedVersion: number, acknowledgeUncertain = false): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.version !== expectedVersion) return false;
    if (!(row.phase === 'uncertain' && acknowledgeUncertain) && (!['active', 'blocked'].includes(row.phase) || row.requestToken !== null)) return false;
    if (row.leaseToken !== null && await this.pools.isLeaseActive(row.leaseToken, Date.now())) return false;
    row.phase = 'closed';
    row.version++;
    row.migrationRequested = false;
    row.requestToken = null;
    row.leaseToken = null;
    row.lockUntil = null;
    return true;
  }

  async deleteAll(): Promise<void> {
    this.rows.clear();
    this.turns.clear();
    this.migrations.clear();
  }

  async deletePool(poolId: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.poolId !== poolId) continue;
      this.rows.delete(row.id);
      this.migrations.delete(row.id);
      for (const key of this.turns.keys()) if (JSON.parse(key)[0] === row.id) this.turns.delete(key);
    }
  }
}
