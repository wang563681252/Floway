import { afterEach, describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { codexPoolUpstream, subscriptionPoolFixture } from '../test-utils/subscription-pools.ts';

afterEach(() => vi.useRealTimers());

for (const [label, create] of [
  ['SQLite', async () => new SqlRepo(await createSqliteTestDb())],
  ['memory', async () => new InMemoryRepo()],
] as const) {
  describe(`${label} durable subscription conversations`, () => {
    const setup = async () => {
      const repo = await create();
      for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(repo.upstreams, codexPoolUpstream(id));
      await repo.subscriptionPools.save(subscriptionPoolFixture());
      return repo;
    };
    const claim = async (repo: Repo, id: string, token: string, upstreamId = 'account-a', version: number | null = null, turnKey: string | null = null) => {
      const now = Date.now();
      const lease = await repo.subscriptionPools.acquire({
        poolId: 'pool', modelKey: 'model', token, now, expiresAt: now + 120_000,
        candidates: [{ upstreamId, identity: upstreamId, utilization: null }],
        conversation: { id, apiKeyId: 'key', isNew: version === null },
      });
      if (!lease) throw new Error('Expected account lease');
      const result = await repo.subscriptionConversations.start({
        id, poolId: 'pool', apiKeyId: 'key', upstreamId, identity: upstreamId, now, lockUntil: lease.expiresAt,
        leaseToken: token, requestToken: token, turnKey, requestHash: `request-${token}`, migration: version !== null,
        expectedVersion: version,
      });
      if (result.kind !== 'claimed') await repo.subscriptionPools.release(token);
      return result;
    };
    const complete = async (repo: Repo, id: string, token: string, portable = true) => {
      await repo.subscriptionConversations.finish({
        id, token, phase: 'completed', contextHash: 'proof', contextLength: 2, settingsHash: 'settings', modelKey: 'model', portable,
      });
      await repo.subscriptionPools.release(token);
    };

    test('one logical branch has exactly one owner under twenty competing claims', async () => {
      const repo = await setup();
      const results = await Promise.all(Array.from({ length: 20 }, (_unused, index) => claim(repo, 'session', `token-${index}`)));
      expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1);
      expect(results.filter(result => result.kind === 'busy')).toHaveLength(19);
      expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.inFlight).toBe(1);
    });

    test('a migration keeps the source account until a trustworthy completion commits it', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first');
      await repo.subscriptionConversations.dispatched('session', 'first');
      await complete(repo, 'session', 'first');
      const before = await repo.subscriptionConversations.get('session');
      if (!before) throw new Error('Expected binding');
      expect(await claim(repo, 'session', 'handoff', 'account-b', before.version)).toMatchObject({ kind: 'claimed' });
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({ upstreamId: 'account-a', targetUpstreamId: 'account-b', contextHash: 'proof' });
      await repo.subscriptionConversations.dispatched('session', 'handoff');
      await complete(repo, 'session', 'handoff');
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({ upstreamId: 'account-b', migrations: 1, phase: 'active', version: before.version + 1 });
      expect(await repo.subscriptionConversations.history('session')).toMatchObject([{ fromUpstreamId: 'account-a', toUpstreamId: 'account-b', version: before.version + 1 }]);
    });

    test('a known handoff rejection preserves the original binding and exact context proof', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first');
      await complete(repo, 'session', 'first');
      const before = await repo.subscriptionConversations.get('session');
      if (!before) throw new Error('Expected binding');
      await claim(repo, 'session', 'handoff', 'account-b', before.version);
      await repo.subscriptionConversations.dispatched('session', 'handoff');
      await repo.subscriptionConversations.finish({ id: 'session', token: 'handoff', phase: 'rejected', reason: 'quota' });
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({ upstreamId: 'account-a', contextHash: 'proof', migrations: 0, requestToken: null });
    });

    test('preparing crashes recover safely while dispatched crashes cannot be replayed', async () => {
      const repo = await setup();
      vi.useFakeTimers({ toFake: ['Date'] });
      await claim(repo, 'prepared', 'p');
      await claim(repo, 'dispatched', 'd');
      await repo.subscriptionConversations.dispatched('dispatched', 'd');
      vi.setSystemTime(Date.now() + 120_001);
      expect(await repo.subscriptionConversations.get('prepared')).toMatchObject({ phase: 'active', requestToken: null });
      expect(await repo.subscriptionConversations.get('dispatched')).toMatchObject({ phase: 'uncertain', blockedReason: 'execution_uncertain' });
      expect(await claim(repo, 'dispatched', 'retry', 'account-b', 1)).toMatchObject({ kind: 'uncertain' });
    });

    test('reads never renew a ghost lease, but a real heartbeat protects a long turn', async () => {
      const repo = await setup();
      vi.useFakeTimers({ toFake: ['Date'] });
      await claim(repo, 'session', 'long');
      await repo.subscriptionConversations.dispatched('session', 'long');
      const start = Date.now();
      expect(await repo.subscriptionPools.renew('long', start + 30_000, start + 240_000)).toBe(true);
      const renew = vi.spyOn(repo.subscriptionPools, 'renew');
      vi.setSystemTime(start + 150_000);
      expect((await repo.subscriptionConversations.get('session'))?.phase).toBe('dispatched');
      vi.setSystemTime(start + 240_001);
      expect((await repo.subscriptionConversations.get('session'))?.phase).toBe('uncertain');
      expect(renew).not.toHaveBeenCalled();
    });

    test('completed explicit turn IDs cannot accidentally generate a second time', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first', 'account-a', null, 'turn');
      await complete(repo, 'session', 'first');
      const before = await repo.subscriptionConversations.get('session');
      if (!before) throw new Error('Expected binding');
      expect(await claim(repo, 'session', 'replay', 'account-a', before.version, 'turn')).toMatchObject({ kind: 'repeated' });
    });

    test('new sessions prefer the other idle account without counting sessions as requests', async () => {
      const repo = await setup();
      await claim(repo, 'existing', 'first');
      await complete(repo, 'existing', 'first');
      const lease = await repo.subscriptionPools.acquire({
        poolId: 'pool', modelKey: 'model', token: 'new', now: Date.now(), expiresAt: Date.now() + 120_000,
        candidates: ['account-a', 'account-b'].map(upstreamId => ({ upstreamId, identity: upstreamId, utilization: null })),
        conversation: { id: 'new', apiKeyId: 'key', isNew: true },
      });
      expect(lease?.upstreamId).toBe('account-b');
      expect((await repo.subscriptionPools.runtime('pool', Date.now())).map(account => account.inFlight)).toEqual([0, 1]);
    });

    test('pausing and disabling do not invalidate an existing idle binding', async () => {
      const repo = await setup();
      await claim(repo, 'existing', 'first');
      await complete(repo, 'existing', 'first');
      await repo.subscriptionPools.setAcceptNewSessions('account-a', false);
      await repo.subscriptionPools.save({ ...subscriptionPoolFixture(), enabled: false });
      const input = {
        poolId: 'pool', modelKey: 'model', now: Date.now(), expiresAt: Date.now() + 120_000,
        candidates: [{ upstreamId: 'account-a', identity: 'account-a', utilization: null }],
      };
      expect(await repo.subscriptionPools.acquire({ ...input, token: 'new', conversation: { id: 'new', apiKeyId: 'key', isNew: true } })).toBeNull();
      expect((await repo.subscriptionPools.acquire({ ...input, token: 'old', conversation: { id: 'existing', apiKeyId: 'key', isNew: false } }))?.upstreamId).toBe('account-a');
    });

    test('open bindings prevent pool deletion and uncertain closure needs acknowledgement plus no live lease', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first');
      await repo.subscriptionConversations.dispatched('session', 'first');
      await repo.subscriptionConversations.finish({ id: 'session', token: 'first', phase: 'uncertain' });
      await expect(repo.subscriptionPools.delete('pool')).rejects.toThrow();
      expect(await repo.subscriptionConversations.close('session', 1)).toBe(false);
      expect(await repo.subscriptionConversations.close('session', 1, true)).toBe(false);
      await repo.subscriptionPools.release('first');
      expect(await repo.subscriptionConversations.close('session', 1, true)).toBe(true);
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({ phase: 'closed', requestToken: null });
      expect(await repo.subscriptionPools.delete('pool')).toBe(true);
    });

    test('safe-migration requests are versioned, cancellable and never erase their blocked reason', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first');
      await complete(repo, 'session', 'first');
      expect(await repo.subscriptionConversations.requestMigration('session', 2)).toBe(true);
      expect(await repo.subscriptionConversations.cancelMigration('session', 2)).toBe(false);
      await repo.subscriptionConversations.block('session', 'history_mismatch');
      const blocked = await repo.subscriptionConversations.get('session');
      expect(blocked).toMatchObject({ migrationRequested: true, blockedReason: 'history_mismatch', version: 4 });
      expect(await repo.subscriptionConversations.cancelMigration('session', 4)).toBe(true);
    });

    test('backups omit reusable ownership and restore every open binding behind an uncertainty gate', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'first', 'account-a', null, 'turn');
      await complete(repo, 'session', 'first');
      const snapshot = (await repo.subscriptionConversations.backup('pool'))[0];
      if (!snapshot) throw new Error('Expected snapshot');
      expect(Object.keys(snapshot.conversation)).not.toContain('requestToken');
      expect(Object.keys(snapshot.conversation)).not.toContain('leaseToken');
      expect(snapshot.turns).toEqual([{ turnKey: 'turn', requestHash: 'request-first', phase: 'completed' }]);
      expect(await repo.subscriptionConversations.restore(snapshot)).toBe(false);
      await repo.subscriptionConversations.deleteAll();
      expect(await repo.subscriptionConversations.restore(snapshot)).toBe(true);
      expect(await repo.subscriptionConversations.get('session')).toMatchObject({
        upstreamId: 'account-a', phase: 'uncertain', blockedReason: 'restored_requires_confirmation', requestToken: null, leaseToken: null,
      });
      expect(await repo.subscriptionConversations.requestMigration('session', 3)).toBe(false);
      expect(await repo.subscriptionConversations.close('session', 3, true)).toBe(true);
    });

    test('storage itself prevents erasing prepared or dispatched ownership even when a caller skips prechecks', async () => {
      const repo = await setup();
      await claim(repo, 'session', 'owner');
      await expect(repo.subscriptionConversations.deleteAll()).rejects.toThrow('active or uncertain execution');
      await repo.subscriptionConversations.dispatched('session', 'owner');
      await expect(repo.subscriptionPools.deleteAll()).rejects.toThrow('active or uncertain execution');
      expect((await repo.subscriptionConversations.get('session'))?.phase).toBe('dispatched');
      expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.inFlight).toBe(1);
    });
  });
}
