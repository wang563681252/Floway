import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { SubscriptionPoolConflictError, type SubscriptionPool } from '../../src/repo/subscription-pools.ts';
import type { Repo } from '../../src/repo/types.ts';
import { buildCodexUpstreamRecord } from '../test-utils/app.ts';

for (const [label, create] of [
  ['SQLite', async () => new SqlRepo(await createSqliteTestDb())],
  ['memory', async () => new InMemoryRepo()],
] as const) {
  describe(`${label} subscription pools`, () => {
    const setup = async (limit: number | null = 50): Promise<{ repo: Repo; pool: SubscriptionPool }> => {
      const repo = await create();
      for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(repo.upstreams, buildCodexUpstreamRecord({ id, name: id }));
      const pool: SubscriptionPool = {
        id: 'pool', name: 'Subscriptions', provider: 'codex', enabled: true, maxConcurrentRequests: limit,
        upstreamIds: ['account-a', 'account-b'], createdAt: '2026-10-08T00:00:00.000Z',
      };
      await repo.subscriptionPools.save(pool);
      return { repo, pool };
    };
    const acquire = (repo: Repo, token: string, now = Date.now(), sameIdentity = false) => repo.subscriptionPools.acquire({
      token, poolId: 'pool', modelKey: 'model', now, expiresAt: now + 120_000,
      candidates: [
        { upstreamId: 'account-a', identity: 'identity-a', utilization: 0.2 },
        { upstreamId: 'account-b', identity: sameIdentity ? 'identity-a' : 'identity-b', utilization: 0.8 },
      ],
    });

    test('enforces exactly 50 simultaneous requests per actual account across 105 competing acquisitions', async () => {
      const { repo } = await setup();
      const results = await Promise.all(Array.from({ length: 105 }, (_unused, index) => acquire(repo, `request-${index}`)));
      expect(results.filter(Boolean)).toHaveLength(100);
      expect(results.filter(lease => lease?.upstreamId === 'account-a')).toHaveLength(50);
      expect(results.filter(lease => lease?.upstreamId === 'account-b')).toHaveLength(50);
      const first = results.find(lease => lease !== null)!;
      await repo.subscriptionPools.release(first.token);
      expect(await acquire(repo, 'after-release')).not.toBeNull();
    });

    test('unlimited mode accepts more than 50 per account and still records actual load', async () => {
      const { repo } = await setup(null);
      const results = await Promise.all(Array.from({ length: 122 }, (_unused, index) => acquire(repo, `unlimited-${index}`)));
      expect(results.filter(Boolean)).toHaveLength(122);
      expect((await repo.subscriptionPools.runtime('pool', Date.now())).map(account => account.inFlight)).toEqual([61, 61]);
    });

    test('duplicate imports of the same actual account cannot multiply its 50-request limit', async () => {
      const { repo } = await setup();
      const results = await Promise.all(Array.from({ length: 55 }, (_unused, index) => acquire(repo, `duplicate-${index}`, Date.now(), true)));
      expect(results.filter(Boolean)).toHaveLength(50);
    });

    test('caller candidate scope cannot acquire a hidden account even when it has more capacity', async () => {
      const { repo } = await setup(1);
      const input = {
        poolId: 'pool', modelKey: 'model', now: Date.now(), expiresAt: Date.now() + 120_000,
        candidates: [{ upstreamId: 'account-a', identity: 'identity-a', utilization: 1 }],
      };
      expect((await repo.subscriptionPools.acquire({ ...input, token: 'visible' }))?.upstreamId).toBe('account-a');
      expect(await repo.subscriptionPools.acquire({ ...input, token: 'hidden-must-not-be-used' })).toBeNull();
    });

    test('known model cooldowns skip only their own model and reset explicitly', async () => {
      const { repo } = await setup();
      const now = Date.now();
      await repo.subscriptionPools.observe({ upstreamId: 'account-a', modelKey: 'model', status: 429, cooldownUntil: now + 60_000 });
      expect((await acquire(repo, 'cooldown'))?.upstreamId).toBe('account-b');
      await repo.subscriptionPools.reset('account-a');
      expect((await acquire(repo, 'reset'))?.upstreamId).toBe('account-a');
    });

    test('renewal preserves a long-running claim and expired owners cannot resurrect it', async () => {
      const { repo } = await setup(1);
      const now = Date.now();
      const first = await acquire(repo, 'long', now);
      expect(first).not.toBeNull();
      expect(await repo.subscriptionPools.renew('long', now + 30_000, now + 150_000)).toBe(true);
      expect(await repo.subscriptionPools.renew('long', now + 150_001, now + 200_000)).toBe(false);
      expect(await acquire(repo, 'after-expiry', now + 150_001)).not.toBeNull();
    });

    test('busy membership and deletion changes fail without partially modifying configuration', async () => {
      const { repo, pool } = await setup();
      await acquire(repo, 'active');
      await expect(repo.subscriptionPools.save({ ...pool, name: 'must-not-save', upstreamIds: ['account-b'] })).rejects.toBeInstanceOf(SubscriptionPoolConflictError);
      expect((await repo.subscriptionPools.get(pool.id))?.name).toBe(pool.name);
      await expect(repo.subscriptionPools.delete(pool.id)).rejects.toBeInstanceOf(SubscriptionPoolConflictError);
      await repo.subscriptionPools.release('active');
      expect(await repo.subscriptionPools.delete(pool.id)).toBe(true);
    });

    test('an account cannot be enrolled into two pools and wrong providers cannot be stored', async () => {
      const { repo, pool } = await setup();
      await expect(repo.subscriptionPools.save({ ...pool, id: 'other' })).rejects.toBeInstanceOf(SubscriptionPoolConflictError);
      expect(await repo.subscriptionPools.get('other')).toBeNull();
      await expect(repo.subscriptionPools.save({ ...pool, id: 'claude', provider: 'claude-code' })).rejects.toBeInstanceOf(SubscriptionPoolConflictError);
      expect(await repo.subscriptionPools.get('claude')).toBeNull();
    });
  });
}
