import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { SqlRepo } from '@floway-dev/gateway';

test('real Node SQLite atomically enforces 50 claims per account and persists unlimited configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-native-subscription-pool-'));
  try {
    using db = createNodeSqliteDatabase(join(directory, 'floway.db'));
    await applyMigrations(db);
    const repo = new SqlRepo(db);
    for (const id of ['account-a', 'account-b']) {
      await repo.upstreams.insertForModels({
        id, kind: 'codex', name: id, enabled: true, sortOrder: 0,
        createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
        config: { accounts: [{ email: null, chatgptAccountId: id, chatgptUserId: null, planType: null }] },
        state: {
          accounts: [{
            chatgptAccountId: id, refresh_token: 'test-refresh', state: 'active',
            state_updated_at: '2026-10-08T00:00:00.000Z',
            openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null,
          }],
        },
        flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 100,
      });
    }
    const pool = {
      id: 'pool', name: 'Subscriptions', provider: 'codex' as const, enabled: true, maxConcurrentRequests: 50,
      upstreamIds: ['account-a', 'account-b'], createdAt: '2026-10-08T00:00:00.000Z',
    };
    await repo.subscriptionPools.save(pool);
    const now = Date.now();
    const acquire = (token: string) => repo.subscriptionPools.acquire({
      poolId: 'pool', token, now, expiresAt: now + 120_000, modelKey: 'model',
      candidates: pool.upstreamIds.map(upstreamId => ({ upstreamId, identity: upstreamId, utilization: null })),
    });
    const claimed = await Promise.all(Array.from({ length: 105 }, (_unused, index) => acquire(`request-${  index}`)));
    expect(claimed.filter(Boolean)).toHaveLength(100);
    expect((await repo.subscriptionPools.runtime('pool', now)).map(account => account.inFlight)).toEqual([50, 50]);
    await repo.subscriptionPools.save({ ...pool, maxConcurrentRequests: null });
    expect((await repo.subscriptionPools.get('pool'))?.maxConcurrentRequests).toBeNull();
    expect(await acquire('unlimited-extra')).not.toBeNull();
    await expect(repo.subscriptionPools.delete('pool')).rejects.toThrow('active requests');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
