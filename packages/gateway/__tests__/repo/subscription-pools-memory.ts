import type { MemorySubscriptionConversationsRepo } from './subscription-conversations-memory.ts';
import { assertSubscriptionPool, SubscriptionPoolConflictError, type SubscriptionPool, type SubscriptionPoolAccountRuntime, type SubscriptionPoolLease, type SubscriptionPoolsRepo } from '../../src/repo/subscription-pools.ts';
import type { UpstreamRepo } from '../../src/repo/types.ts';

export class MemorySubscriptionPoolsRepo implements SubscriptionPoolsRepo {
  private readonly pools = new Map<string, SubscriptionPool>();
  private readonly leases = new Map<string, SubscriptionPoolLease>();
  private readonly selections = new Map<string, number>();
  private readonly cooldowns = new Map<string, { upstreamId: string; modelKey: string; until: number; status: number; failures: number }>();
  private readonly paused = new Set<string>();
  conversations?: MemorySubscriptionConversationsRepo;

  constructor(private readonly upstreams: UpstreamRepo) {}

  private expire(now: number): void {
    for (const [token, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(token);
  }

  async list(): Promise<SubscriptionPool[]> {
    const ids = new Set((await this.upstreams.list()).map(upstream => upstream.id));
    return [...this.pools.values()].map(pool => ({ ...pool, upstreamIds: pool.upstreamIds.filter(id => ids.has(id)) }));
  }

  async get(id: string): Promise<SubscriptionPool | null> {
    return (await this.list()).find(pool => pool.id === id) ?? null;
  }

  async save(pool: SubscriptionPool): Promise<void> {
    assertSubscriptionPool(pool);
    const upstreams = await Promise.all(pool.upstreamIds.map(id => this.upstreams.getById(id)));
    if (upstreams.some(upstream => upstream === null || upstream.kind !== pool.provider)) {
      throw new SubscriptionPoolConflictError('Subscription pool provider mismatch');
    }
    this.expire(Date.now());
    const previous = this.pools.get(pool.id);
    if (previous && previous.provider !== pool.provider) throw new SubscriptionPoolConflictError('Subscription pool provider mismatch');
    for (const id of pool.upstreamIds) {
      if ([...this.pools.values()].some(other => other.id !== pool.id && other.upstreamIds.includes(id))) {
        throw new SubscriptionPoolConflictError('Upstream already belongs to another subscription pool');
      }
    }
    const removed = previous?.upstreamIds.filter(id => !pool.upstreamIds.includes(id)) ?? [];
    if ([...this.leases.values()].some(lease => removed.includes(lease.upstreamId))) {
      throw new SubscriptionPoolConflictError('Subscription pool has active requests');
    }
    this.pools.set(pool.id, { ...pool, upstreamIds: [...pool.upstreamIds] });
  }

  async delete(id: string): Promise<boolean> {
    this.expire(Date.now());
    if ([...this.leases.values()].some(lease => lease.poolId === id)) throw new SubscriptionPoolConflictError('Subscription pool has active requests');
    if ((await this.conversations?.list(id))?.some(conversation => conversation.phase !== 'closed')) throw new SubscriptionPoolConflictError('Subscription pool has open conversations');
    await this.conversations?.deletePool(id);
    return this.pools.delete(id);
  }

  async deleteAll(): Promise<void> {
    await this.conversations?.deleteAll();
    this.pools.clear();
    this.leases.clear();
    this.cooldowns.clear();
    this.selections.clear();
    this.paused.clear();
  }

  async runtime(poolId: string, now: number): Promise<SubscriptionPoolAccountRuntime[]> {
    this.expire(now);
    const pool = await this.get(poolId);
    return (pool?.upstreamIds ?? []).map(upstreamId => ({
      upstreamId,
      inFlight: [...this.leases.values()].filter(lease => lease.upstreamId === upstreamId).length,
      selections: this.selections.get(upstreamId) ?? 0,
      acceptNewSessions: !this.paused.has(upstreamId),
      cooldowns: [...this.cooldowns.values()].filter(item => item.upstreamId === upstreamId && item.until > now),
    }));
  }

  async acquire(input: Parameters<SubscriptionPoolsRepo['acquire']>[0]): Promise<SubscriptionPoolLease | null> {
    const pool = this.pools.get(input.poolId);
    if (!pool) return null;
    if (!pool.enabled) {
      const binding = input.conversation ? await this.conversations?.get(input.conversation.id) : null;
      if (!binding || binding.apiKeyId !== input.conversation?.apiKeyId || binding.poolId !== pool.id || binding.phase === 'closed') return null;
    }
    const records = await Promise.all(input.candidates.map(candidate => this.upstreams.getById(candidate.upstreamId)));
    const conversations = this.conversations;
    const bound = input.conversation?.isNew && conversations
      ? (await Promise.all([...this.pools.keys()].map(id => conversations.list(id)))).flat() : [];
    this.expire(input.now);
    const count = (identity: string) => [...this.leases.values()].filter(lease => lease.identity === identity).length;
    const candidates = input.candidates.filter((candidate, index) => {
      const upstream = records[index];
      return upstream?.enabled && upstream.kind === pool.provider && pool.upstreamIds.includes(candidate.upstreamId)
        && (!input.conversation?.isNew || !this.paused.has(candidate.upstreamId))
        && (pool.maxConcurrentRequests === null || count(candidate.identity) < pool.maxConcurrentRequests)
        && (this.cooldowns.get(JSON.stringify([candidate.upstreamId, input.modelKey]))?.until ?? 0) <= input.now;
    }).toSorted((left, right) =>
      bound.filter(session => session.accountIdentity === left.identity && session.phase !== 'closed' && session.lastSeenAt >= input.now - 30 * 60_000).length
      - bound.filter(session => session.accountIdentity === right.identity && session.phase !== 'closed' && session.lastSeenAt >= input.now - 30 * 60_000).length
      || count(left.identity) - count(right.identity)
      || (left.utilization ?? 0.5) - (right.utilization ?? 0.5)
      || (this.selections.get(left.upstreamId) ?? 0) - (this.selections.get(right.upstreamId) ?? 0)
      || left.upstreamId.localeCompare(right.upstreamId));
    const chosen = candidates[0];
    if (!chosen) return null;
    const lease = { token: input.token, poolId: input.poolId, upstreamId: chosen.upstreamId, identity: chosen.identity, expiresAt: input.expiresAt };
    this.leases.set(lease.token, lease);
    this.selections.set(chosen.upstreamId, (this.selections.get(chosen.upstreamId) ?? 0) + 1);
    return lease;
  }

  async renew(token: string, now: number, expiresAt: number): Promise<boolean> {
    this.expire(now);
    const lease = this.leases.get(token);
    if (!lease) return false;
    lease.expiresAt = expiresAt;
    return true;
  }

  async release(token: string): Promise<void> {
    this.leases.delete(token);
  }

  async isLeaseActive(token: string, now: number): Promise<boolean> {
    this.expire(now);
    return this.leases.has(token);
  }

  async setAcceptNewSessions(upstreamId: string, accept: boolean): Promise<boolean> {
    if (![...this.pools.values()].some(pool => pool.upstreamIds.includes(upstreamId))) return false;
    if (accept) this.paused.delete(upstreamId);
    else this.paused.add(upstreamId);
    return true;
  }

  async observe(input: Parameters<SubscriptionPoolsRepo['observe']>[0]): Promise<void> {
    const key = JSON.stringify([input.upstreamId, input.modelKey]);
    if (input.cooldownUntil === null) this.cooldowns.delete(key);
    else {
      const previous = this.cooldowns.get(key);
      this.cooldowns.set(key, {
        upstreamId: input.upstreamId, modelKey: input.modelKey, status: input.status,
        until: Math.max(previous?.until ?? 0, input.cooldownUntil), failures: (previous?.failures ?? 0) + 1,
      });
    }
  }

  async reset(upstreamId: string): Promise<void> {
    for (const [key, value] of this.cooldowns) if (value.upstreamId === upstreamId) this.cooldowns.delete(key);
  }
}
