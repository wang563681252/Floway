import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { SqlRepo } from '@floway-dev/gateway';

test('real Node SQLite preserves conversation ownership across restart and commits a versioned handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-native-conversation-'));
  try {
    const path = join(directory, 'floway.db');
    {
      using db = createNodeSqliteDatabase(path);
      await applyMigrations(db);
      const repo = new SqlRepo(db);
      for (const id of ['account-a', 'account-b']) {
        await repo.upstreams.insertForModels({
          id, kind: 'codex', name: id, enabled: true, sortOrder: 0,
          createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
          config: { accounts: [{ email: null, chatgptAccountId: id, chatgptUserId: null, planType: null }] },
          state: {
            accounts: [{
              chatgptAccountId: id, refresh_token: 'test-only', state: 'active',
              state_updated_at: '2026-10-08T00:00:00.000Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null,
            }],
          },
          flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 100,
        });
      }
      await repo.subscriptionPools.save({
        id: 'pool', name: 'Subscriptions', provider: 'codex', enabled: true, maxConcurrentRequests: 50,
        upstreamIds: ['account-a', 'account-b'], createdAt: '2026-10-08T00:00:00.000Z',
      });
      const now = Date.now();
      const lease = await repo.subscriptionPools.acquire({
        poolId: 'pool', token: 'first', now, expiresAt: now + 120_000, modelKey: 'model',
        candidates: [{ upstreamId: 'account-a', identity: 'account-a', utilization: null }],
      });
      if (!lease) throw new Error('Expected native account lease');
      expect(await repo.subscriptionConversations.start({
        id: 'session', poolId: 'pool', apiKeyId: 'key', upstreamId: 'account-a', identity: 'account-a',
        leaseToken: lease.token, requestToken: lease.token, now, lockUntil: lease.expiresAt,
        turnKey: 'turn-1', requestHash: 'request-proof', migration: false, expectedVersion: null,
      })).toMatchObject({ kind: 'claimed' });
      await repo.subscriptionConversations.dispatched('session', lease.token);
      await repo.subscriptionConversations.finish({
        id: 'session', token: lease.token, phase: 'completed', contextHash: 'exact-proof',
        contextLength: 2, settingsHash: 'settings-proof', modelKey: 'model', portable: true,
      });
      await repo.subscriptionPools.release(lease.token);
      await repo.subscriptionPools.setAcceptNewSessions('account-a', false);
    }
    {
      using db = createNodeSqliteDatabase(path);
      const repo = new SqlRepo(db);
      const before = await repo.subscriptionConversations.get('session');
      expect(before).toMatchObject({ upstreamId: 'account-a', phase: 'active', version: 2, contextHash: 'exact-proof' });
      expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.acceptNewSessions).toBe(false);
      if (!before) throw new Error('Expected persisted conversation');
      const now = Date.now();
      const lease = await repo.subscriptionPools.acquire({
        poolId: 'pool', token: 'handoff', now, expiresAt: now + 120_000, modelKey: 'model',
        candidates: [{ upstreamId: 'account-b', identity: 'account-b', utilization: null }],
        conversation: { id: 'session', apiKeyId: 'key', isNew: true },
      });
      if (!lease) throw new Error('Expected handoff lease');
      await repo.subscriptionConversations.start({
        id: 'session', poolId: 'pool', apiKeyId: 'key', upstreamId: 'account-b', identity: 'account-b',
        leaseToken: lease.token, requestToken: lease.token, now, lockUntil: lease.expiresAt,
        turnKey: 'turn-2', requestHash: 'second-request-proof', migration: true, expectedVersion: before.version,
      });
      await repo.subscriptionConversations.dispatched('session', lease.token);
      expect((await repo.subscriptionConversations.get('session'))?.upstreamId).toBe('account-a');
      await repo.subscriptionConversations.finish({
        id: 'session', token: lease.token, phase: 'completed', contextHash: 'second-exact-proof',
        contextLength: 4, settingsHash: 'settings-proof', modelKey: 'model', portable: true,
      });
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({ upstreamId: 'account-b', migrations: 1, version: 3 });
      expect(await repo.subscriptionConversations.history('session')).toMatchObject([{ fromUpstreamId: 'account-a', toUpstreamId: 'account-b' }]);
      const columns = await db.prepare('PRAGMA table_info(subscription_conversations)').all<{ name: string }>();
      expect(columns.results.map(column => column.name)).not.toContain('messages');
      expect(columns.results.map(column => column.name)).not.toContain('context_body');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
