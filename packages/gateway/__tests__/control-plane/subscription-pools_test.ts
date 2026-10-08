import { expect, test } from 'vitest';

import { app } from '../../src/app.ts';
import type { SubscriptionPool } from '../../src/repo/subscription-pools.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { setupAppTest } from '../test-utils/app.ts';
import { codexPoolUpstream } from '../test-utils/subscription-pools.ts';

const setup = async () => {
  const context = await setupAppTest();
  for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(context.repo.upstreams, codexPoolUpstream(id));
  const request = (path = '', method = 'GET', body?: unknown) => app.request(`/api/subscription-pools${  path}`, {
    method,
    headers: { 'x-floway-session': context.adminSession, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...context, request };
};

const body = { name: 'Subscriptions', provider: 'codex', upstream_ids: ['account-a', 'account-b'] };

test('admin CRUD defaults to exactly 50 per account, supports unlimited and preserves credentials', async () => {
  const { request, repo } = await setup();
  const before = await repo.upstreams.list();
  const created = await request('', 'POST', body);
  expect(created.status).toBe(201);
  const pool = await created.json() as { id: string; max_concurrent_requests: number };
  expect(pool.max_concurrent_requests).toBe(50);
  expect((await request(`/${  pool.id}`, 'PUT', { ...body, max_concurrent_requests: null })).status).toBe(200);
  const listed = await request();
  const pools = await listed.json() as Array<{ max_concurrent_requests: null; accounts: Array<{ in_flight: number; health: string }> }>;
  expect(pools[0]?.max_concurrent_requests).toBeNull();
  expect(pools[0]?.accounts.map(account => account.in_flight)).toEqual([0, 0]);
  expect(pools[0]?.accounts.map(account => account.health)).toEqual(['active', 'active']);
  expect(await repo.upstreams.list()).toEqual(before);
  expect((await request(`/${  pool.id}`, 'DELETE')).status).toBe(204);
});

test('rejects unsupported providers, duplicate identities and missing member IDs without writes', async () => {
  const { request, repo } = await setup();
  expect((await request('', 'POST', { ...body, provider: 'copilot' })).status).toBe(400);
  expect((await request('', 'POST', { ...body, upstream_ids: ['missing'] })).status).toBe(400);
  expect((await request('', 'POST', { ...body, upstream_ids: ['account-a', 'account-a'] })).status).toBe(400);
  await saveUpstreamForTest(repo.upstreams, { ...codexPoolUpstream('account-a'), id: 'duplicate' });
  expect((await request('', 'POST', { ...body, upstream_ids: ['account-a', 'duplicate'] })).status).toBe(400);
  expect(await repo.subscriptionPools.list()).toEqual([]);
});

test('rejects nonpositive or fractional concurrency without converting it to unlimited', async () => {
  const { request } = await setup();
  for (const limit of [0, -1, 1.5]) expect((await request('', 'POST', { ...body, max_concurrent_requests: limit })).status).toBe(400);
});

test('pool credentials cannot leak through list/status and anonymous access is rejected', async () => {
  const { request } = await setup();
  await request('', 'POST', body);
  const text = await (await request()).text();
  expect(text).not.toContain('codex-access-token');
  expect(text).not.toContain('rt_v1');
  expect(text).not.toContain('openaiDeviceId');
  expect((await app.request('/api/subscription-pools')).status).toBe(401);
});

test('export/import round-trips only pool configuration, not active leases and cooldowns', async () => {
  const { request, repo, adminSession } = await setup();
  const response = await request('', 'POST', body);
  const pool = await response.json() as { id: string };
  const lease = await repo.subscriptionPools.acquire({
    poolId: pool.id, token: 'live', modelKey: 'model', now: Date.now(), expiresAt: Date.now() + 120_000,
    candidates: [{ upstreamId: 'account-a', identity: 'identity-a', utilization: 0.1 }],
  });
  expect(lease).not.toBeNull();
  const exported = await app.request('/api/export', { headers: { 'x-floway-session': adminSession } });
  const payload = await exported.json() as { version: number; data: { subscriptionPools: SubscriptionPool[] } };
  expect(payload.version).toBe(21);
  expect(payload.data.subscriptionPools).toHaveLength(1);
  expect(JSON.stringify(payload)).not.toContain('"token":"live"');
  const restored = await app.request('/api/import', {
    method: 'POST', headers: { 'x-floway-session': adminSession, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', version: payload.version, data: payload.data }),
  });
  expect(restored.status).toBe(200);
  expect(await repo.subscriptionPools.get(pool.id)).toEqual(payload.data.subscriptionPools[0]);
  expect((await repo.subscriptionPools.runtime(pool.id, Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('a pooled upstream credential re-import cannot duplicate another account identity', async () => {
  const { request, repo } = await setup();
  await request('', 'POST', body);
  const replacement = { ...codexPoolUpstream('account-a'), id: 'account-b' };
  const { saveUpstream } = await import('../../src/control-plane/shared/save-upstreams.ts');
  const before = await repo.upstreams.getById('account-b');
  await expect(saveUpstream({ previous: before, next: replacement })).rejects.toThrow('same subscription account');
  expect(await repo.upstreams.getById('account-b')).toEqual(before);
});
