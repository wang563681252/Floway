import { afterEach, expect, test, vi } from 'vitest';

import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { iterateCandidates } from '../../../src/data-plane/shared/iterate-candidates.ts';
import { subscriptionPoolModelKey } from '../../../src/data-plane/shared/subscription-pool-selection.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { codexPoolUpstream, subscriptionPoolFixture } from '../../test-utils/subscription-pools.ts';
import type { ApiErrorResult, ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const setup = async (limit: number | null = 50) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(repo.upstreams, codexPoolUpstream(id));
  await repo.subscriptionPools.save(subscriptionPoolFixture(limit));
  const candidates: ModelCandidate[] = [];
  for (const id of ['account-a', 'account-b']) {
    const upstream = await repo.upstreams.getById(id);
    if (!upstream) throw new Error('Pool fixture upstream missing');
    candidates.push(stubModelCandidate({
      provider: createProvider(upstream),
      model: {
        id: 'model',
        providerModels: { [id]: stubProviderModel({ id: 'model', upstreamModelId: 'model' }) },
      },
    }));
  }
  return { repo, candidates, ctx: mockGatewayCtx() };
};

const stream = () => ({ type: 'events' as const, events: (async function* () { yield 'chunk'; })() });
const upstreamError = (status: number, retryAfter?: string): ApiErrorResult => ({
  type: 'api-error', source: 'upstream', status,
  headers: new Headers({ 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) }),
  body: new TextEncoder().encode('exact upstream failure bytes'),
});

test('retains 50 leases per account until streams finish or are cancelled before the first read', async () => {
  const { repo, candidates, ctx } = await setup();
  const results = await Promise.all(Array.from({ length: 101 }, () => iterateCandidates(candidates, 'test', ctx, 'chat', async () => stream())));
  const streams = results.filter(result => result.type === 'events');
  expect(streams).toHaveLength(100);
  expect(results.find(result => result.type === 'api-error')?.status).toBe(429);
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).map(item => item.inFlight)).toEqual([50, 50]);
  for (const result of streams) await result.events?.[Symbol.asyncIterator]().return?.();
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).map(item => item.inFlight)).toEqual([0, 0]);
});

test('one pre-stream 429 cools down that account and fails over without changing the successful stream', async () => {
  const { repo, candidates, ctx } = await setup();
  const calls: string[] = [];
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', async candidate => {
    calls.push(candidate.provider.upstreamId);
    return candidate.provider.upstreamId === 'account-a' ? upstreamError(429, '60') : stream();
  });
  expect(calls).toEqual(['account-a', 'account-b']);
  if (result.type !== 'events' || !result.events) throw new Error('Expected a successful stream');
  expect(await Array.fromAsync(result.events)).toEqual(['chunk']);
  const state = await repo.subscriptionPools.runtime('pool', Date.now());
  expect(state.find(item => item.upstreamId === 'account-a')?.cooldowns[0]).toMatchObject({ status: 429, failures: 1 });
  expect(state.every(item => item.inFlight === 0)).toBe(true);
});

test('all attempted failures preserve the final upstream status, headers and body by identity', async () => {
  const { candidates, ctx } = await setup();
  const error = upstreamError(429, '90');
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', async () => error);
  expect(result).toBe(error);
});

test('fresh exhaustion skips a known blocked account while stale hints do not permanently gate it', async () => {
  const { candidates, ctx } = await setup();
  const now = Date.now();
  candidates[0]!.provider.getSubscriptionAccountStatus = async () => ({
    identity: 'account-a', health: 'active', observedAt: now, utilization: 1, unavailableUntil: now + 60_000,
  });
  const run = vi.fn(async (_candidate: ModelCandidate) => ({ type: 'result' as const }));
  await iterateCandidates(candidates, 'test', ctx, 'chat', run);
  expect(run.mock.calls[0]?.[0]?.provider.upstreamId).toBe('account-b');
  candidates[0]!.provider.getSubscriptionAccountStatus = async () => ({
    identity: 'account-a', health: 'active', observedAt: now - 360_000, utilization: 1, unavailableUntil: now + 60_000,
  });
  run.mockClear();
  await iterateCandidates(candidates, 'test', ctx, 'chat', run);
  expect(run.mock.calls[0]?.[0]?.provider.upstreamId).toBe('account-a');
});

test('affinity preference precedes load balancing and pool selection never widens caller scope', async () => {
  const { candidates, ctx } = await setup(1);
  const first = await iterateCandidates(candidates, 'test', ctx, 'chat', async () => stream(), {
    priorityFor: candidate => candidate.provider.upstreamId === 'account-b' ? 0 : 1,
  });
  const next = await iterateCandidates([candidates[1]!], 'test', ctx, 'chat', async () => stream());
  expect(next.type).toBe('api-error');
  if (next.type === 'api-error') expect(next.status).toBe(429);
  if (first.type !== 'events') throw new Error('Expected preferred stream');
  await first.events?.[Symbol.asyncIterator]().return?.();
});

test('request cancellation releases a claim without relying on downstream consumption', async () => {
  const { repo, candidates } = await setup();
  const controller = new AbortController();
  const scheduled: Promise<unknown>[] = [];
  const ctx = mockGatewayCtx({ abortSignal: controller.signal, backgroundScheduler: promise => { scheduled.push(promise); } });
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', async () => stream());
  controller.abort();
  await Promise.all(scheduled);
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(item => item.inFlight === 0)).toBe(true);
  if (result.type === 'events') await result.events?.[Symbol.asyncIterator]().return?.();
});

test('renewal protects long streams and lease-storage failure aborts the actual attempt signal', async () => {
  const { repo, candidates, ctx } = await setup();
  vi.useFakeTimers();
  const renew = vi.spyOn(repo.subscriptionPools, 'renew');
  let signal: AbortSignal | undefined;
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', async (_candidate, attemptCtx) => {
    signal = attemptCtx.abortSignal;
    return stream();
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(renew.mock.calls[0]?.[2]).toBeGreaterThan(renew.mock.calls[0]?.[1] ?? 0);
  const failure = new Error('lease persistence failed');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  renew.mockRejectedValueOnce(failure);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(signal?.aborted).toBe(true);
  expect(logged).toHaveBeenCalledWith('[subscription-pool lease]', failure);
  if (result.type !== 'events' || !result.events) throw new Error('Expected leased stream');
  await expect(result.events[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(item => item.inFlight === 0)).toBe(true);
});

test('model cooldown status is exposed only on its own routed model and rules', async () => {
  const { repo, candidates, ctx } = await setup();
  await repo.subscriptionPools.observe({ upstreamId: 'account-a', modelKey: subscriptionPoolModelKey(candidates[0]!), status: 429, cooldownUntil: Date.now() + 60_000 });
  const alternate = { ...candidates[0]!, rules: { serviceTier: 'priority' } };
  const result = await iterateCandidates([alternate], 'test', ctx, 'chat', async () => ({ type: 'result' as const }));
  expect(result.type).toBe('result');
});

test.each(['openai', 'anthropic', 'gemini'] as const)('a fully restricted pool returns a %s rate-limit envelope and exact known retry time without dispatch', async errorFormat => {
  const { candidates, ctx } = await setup();
  vi.useFakeTimers();
  const now = Date.now();
  for (const candidate of candidates) {
    candidate.provider.getSubscriptionAccountStatus = async () => ({
      identity: candidate.provider.upstreamId, health: 'active', observedAt: now, utilization: 1, unavailableUntil: now + 60_000,
    });
  }
  const run = vi.fn(async () => ({ type: 'result' as const }));
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', run, { errorFormat });
  expect(run).not.toHaveBeenCalled();
  if (result.type !== 'api-error') throw new Error('Expected explicit pool failure');
  expect(result.status).toBe(429);
  expect(result.headers.get('retry-after')).toBe('60');
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { type?: string; error: { code?: string | number; type?: string; status?: string } };
  if (errorFormat === 'openai') expect(body.error.code).toBe('rate_limit_exceeded');
  if (errorFormat === 'anthropic') expect(body.error.type).toBe('rate_limit_error');
  if (errorFormat === 'gemini') expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
});

test('pre-stream credential failures fail over only when the owning provider recognizes them', async () => {
  const { repo, candidates, ctx } = await setup();
  const credentialError = new Error('known credential failure');
  candidates[0]!.provider.isSubscriptionCredentialError = error => error === credentialError;
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await iterateCandidates(candidates, 'test', ctx, 'chat', async candidate => {
    if (candidate.provider.upstreamId === 'account-a') throw credentialError;
    return { type: 'result' as const };
  });
  expect(result.type).toBe('result');
  expect(warned).toHaveBeenCalledWith('[subscription-pool] credential unavailable before response', 'account-a');
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
  const original = new Error('programming defect');
  const run = vi.fn(async () => { throw original; });
  await expect(iterateCandidates(candidates, 'test', ctx, 'chat', run)).rejects.toBe(original);
  expect(run).toHaveBeenCalledTimes(1);
});

test('a raw response owns its lease until its body is consumed and preserves headers and bytes', async () => {
  const { repo, candidates, ctx } = await setup();
  const response = new Response('exact body', { headers: { 'x-request-id': 'original-request' } });
  const result = await iterateCandidates([candidates[0]!], 'test', ctx, 'image_generation', async () => ({ type: 'plain' as const, status: 200, response }));
  if (result.type !== 'plain' || !result.response) throw new Error('Expected a raw response');
  expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.inFlight).toBe(1);
  expect(result.response.headers.get('x-request-id')).toBe('original-request');
  expect(await result.response.text()).toBe('exact body');
  expect((await repo.subscriptionPools.runtime('pool', Date.now()))[0]?.inFlight).toBe(0);
});
