import { expect, test } from 'vitest';

import { app } from '../../src/app.ts';
import { saveUpstream } from '../../src/control-plane/shared/save-upstreams.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { setupAppTest } from '../test-utils/app.ts';
import { codexPoolUpstream, subscriptionPoolFixture } from '../test-utils/subscription-pools.ts';

const setup = async (portable = true) => {
  const context = await setupAppTest();
  for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(context.repo.upstreams, codexPoolUpstream(id));
  await context.repo.subscriptionPools.save(subscriptionPoolFixture());
  const now = Date.now();
  const lease = await context.repo.subscriptionPools.acquire({
    poolId: 'pool', token: 'private-lease', now, expiresAt: now + 120_000, modelKey: 'model',
    candidates: [{ upstreamId: 'account-a', identity: JSON.stringify(['codex', 'account-a']), utilization: null }],
  });
  if (!lease) throw new Error('Expected lease');
  await context.repo.subscriptionConversations.start({
    id: 'session', poolId: 'pool', apiKeyId: context.apiKey.id, upstreamId: lease.upstreamId, identity: lease.identity,
    leaseToken: lease.token, requestToken: 'private-owner', now, lockUntil: lease.expiresAt, turnKey: 'private-turn',
    requestHash: 'private-hash', migration: false, expectedVersion: null,
  });
  await context.repo.subscriptionConversations.dispatched('session', 'private-owner');
  await context.repo.subscriptionConversations.finish({
    id: 'session', token: 'private-owner', phase: 'completed', contextHash: 'private-context-proof',
    contextLength: 2, settingsHash: 'settings-proof', modelKey: 'model', portable,
  });
  await context.repo.subscriptionPools.release(lease.token);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`/api/subscription-pools/pool${path}`, {
    method, headers: { 'x-floway-session': context.adminSession, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...context, request };
};

test('session diagnostics are admin-only, paginated and contain no lease, turn or context proof secrets', async () => {
  const { request, adminSession } = await setup();
  const response = await request('/conversations?offset=0');
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ total: 1, page_size: 100, conversations: [{ id: 'session', phase: 'active', upstream_id: 'account-a' }] });
  for (const value of ['private-owner', 'private-lease', 'private-hash', 'private-turn', 'private-context-proof', 'codex-access-token']) expect(text).not.toContain(value);
  expect((await app.request('/api/subscription-pools/pool/conversations')).status).toBe(401);
  expect((await request('/conversations?offset=-1')).status).toBe(400);
  expect((await request('/conversations?offset=99999999999999999999999')).status).toBe(400);
  expect((await app.request('/api/subscription-pools/other/conversations/session/check', { headers: { 'x-floway-session': adminSession } })).status).toBe(404);
});

test('prechecks describe their full-context requirement and actions only schedule a versioned safe handoff', async () => {
  const { repo, request } = await setup();
  const checked = await request('/conversations/session/check');
  expect(await checked.json()).toMatchObject({ requires_full_context: true, can_request_migration: true, eligible_upstream_ids: ['account-b'], history: [] });
  expect((await request('/conversations/session/action', 'POST', { action: 'request-migration', expected_version: 2 })).status).toBe(204);
  expect(await repo.subscriptionConversations.get('session')).toMatchObject({ upstreamId: 'account-a', migrationRequested: true, version: 3 });
  expect((await request('/conversations/session/action', 'POST', { action: 'cancel-migration', expected_version: 2 })).status).toBe(409);
  expect((await request('/conversations/session/action', 'POST', { action: 'cancel-migration', expected_version: 3 })).status).toBe(204);
  expect((await repo.subscriptionConversations.get('session'))?.migrationRequested).toBe(false);
});

test('native opaque history cannot be forced through the safe-migration action', async () => {
  const { repo, request } = await setup(false);
  expect(await (await request('/conversations/session/check')).json()).toMatchObject({ can_request_migration: false, blockers: ['opaque_context'] });
  expect((await request('/conversations/session/action', 'POST', { action: 'request-migration', expected_version: 2 })).status).toBe(409);
  expect((await repo.subscriptionConversations.get('session'))?.upstreamId).toBe('account-a');
});

test('pausing intake changes only new allocation and is restricted to the named pool member', async () => {
  const { repo, request } = await setup();
  expect((await request('/members/account-a', 'PATCH', { accept_new_sessions: false })).status).toBe(204);
  expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.acceptNewSessions).toBe(false);
  expect((await repo.subscriptionConversations.get('session'))?.upstreamId).toBe('account-a');
  expect((await request('/members/missing', 'PATCH', { accept_new_sessions: true })).status).toBe(404);
  expect((await request('/members/account-a', 'PATCH', { accept_new_sessions: 'false' })).status).toBe(400);
});

test('account replacement is rejected while its real request lease is active', async () => {
  const { repo } = await setup();
  const now = Date.now();
  await repo.subscriptionPools.acquire({
    poolId: 'pool', token: 'active', now, expiresAt: now + 120_000, modelKey: 'model',
    candidates: [{ upstreamId: 'account-a', identity: JSON.stringify(['codex', 'account-a']), utilization: null }],
  });
  const previous = await repo.upstreams.getById('account-a');
  await expect(saveUpstream({ previous, next: { ...codexPoolUpstream('replacement'), id: 'account-a' } })).rejects.toMatchObject({ status: 409 });
  expect(await repo.upstreams.getById('account-a')).toEqual(previous);
});

test('API-key and user scope still constrain every destination shown by the precheck', async () => {
  const { repo, apiKey, request } = await setup();
  await repo.apiKeys.save({ ...apiKey, upstreamIds: ['account-a'] });
  expect(await (await request('/conversations/session/check')).json()).toMatchObject({ can_request_migration: false, eligible_upstream_ids: [], blockers: ['no_session_account'] });
});

test('replace backups cannot erase dispatch ownership and imported idle bindings are quarantined without reusable leases', async () => {
  const { repo, request, adminSession } = await setup();
  await repo.subscriptionPools.setAcceptNewSessions('account-a', false);
  const exported = await app.request('/api/export', { headers: { 'x-floway-session': adminSession } });
  const backup = await exported.json() as { version: number; data: unknown };
  expect(backup.version).toBe(22);
  const snapshot = (await repo.subscriptionConversations.backup('pool'))[0];
  expect(snapshot?.conversation.phase).toBe('active');
  expect(JSON.stringify(backup.data)).not.toContain('private-owner');
  expect(JSON.stringify(backup.data)).not.toContain('private-lease');
  const now = Date.now();
  const lease = await repo.subscriptionPools.acquire({
    poolId: 'pool', token: 'pending', now, expiresAt: now + 120_000, modelKey: 'model',
    candidates: [{ upstreamId: 'account-a', identity: JSON.stringify(['codex', 'account-a']), utilization: null }],
    conversation: { id: 'session', apiKeyId: (await repo.subscriptionConversations.get('session'))!.apiKeyId, isNew: false },
  });
  if (!lease || !snapshot) throw new Error('Expected live conversation');
  await repo.subscriptionConversations.start({
    id: 'session', poolId: 'pool', apiKeyId: snapshot.conversation.apiKeyId, upstreamId: lease.upstreamId, identity: lease.identity,
    leaseToken: lease.token, requestToken: lease.token, now, lockUntil: lease.expiresAt, turnKey: null,
    requestHash: 'pending-hash', migration: false, expectedVersion: 2,
  });
  await repo.subscriptionConversations.dispatched('session', lease.token);
  const importRequest = () => app.request('/api/import', {
    method: 'POST', headers: { 'x-floway-session': adminSession, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', version: backup.version, data: backup.data }),
  });
  expect((await importRequest()).status).toBe(409);
  expect((await repo.subscriptionConversations.get('session'))?.phase).toBe('dispatched');
  await repo.subscriptionConversations.finish({ id: 'session', token: lease.token, phase: 'rejected', reason: 'input_rejected' });
  await repo.subscriptionPools.release(lease.token);
  expect((await importRequest()).status).toBe(200);
  expect(await repo.subscriptionConversations.get('session')).toMatchObject({ phase: 'uncertain', upstreamId: 'account-a', blockedReason: 'restored_requires_confirmation', leaseToken: null, requestToken: null });
  expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.acceptNewSessions).toBe(false);
  expect((await request('/conversations')).status).toBe(401);
});
