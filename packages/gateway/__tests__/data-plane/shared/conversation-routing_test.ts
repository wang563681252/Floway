import { afterEach, expect, test, vi } from 'vitest';

import { wrapOpenAIResponsesClientEgress } from '../../../src/data-plane/chat/openai-responses/client-output.ts';
import { syntheticEventsFromResult } from '../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { createConversationRequest, type ConversationIntent } from '../../../src/data-plane/shared/conversation-context.ts';
import { iterateCandidates } from '../../../src/data-plane/shared/iterate-candidates.ts';
import { subscriptionPoolModelKey } from '../../../src/data-plane/shared/subscription-pool-selection.ts';
import { buildUpstreamCallOptions } from '../../../src/data-plane/shared/upstream-call-options.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { encodeBase64UrlJson } from '../../../src/shared/base64url-json.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { codexPoolUpstream, subscriptionPoolFixture } from '../../test-utils/subscription-pools.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesStreamEvent, type OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import type { ApiErrorResult, ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/translate';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const secret = '00'.repeat(32);
const input = (text: string) => ({ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text }] });
const answer: OpenAIResponsesResult = {
  id: 'resp_test', object: 'response', model: 'model', status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }],
};
const upstreamError = (status: number): ApiErrorResult => ({
  type: 'api-error', source: 'upstream', status, headers: new Headers({ 'retry-after': '60', 'x-upstream': 'preserved' }),
  body: new TextEncoder().encode('exact upstream error'),
});
const setup = async (limit: number | null = 50) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const candidates: ModelCandidate[] = [];
  for (const id of ['account-a', 'account-b']) {
    await saveUpstreamForTest(repo.upstreams, codexPoolUpstream(id));
    const record = await repo.upstreams.getById(id);
    if (!record) throw new Error('Expected fixture upstream');
    candidates.push(stubModelCandidate({
      provider: createProvider(record),
      model: { id: 'model', providerModels: { [id]: stubProviderModel({ id: 'model', upstreamModelId: 'model', endpoints: { openaiResponses: {} } }) } },
    }));
  }
  await repo.subscriptionPools.save(subscriptionPoolFixture(limit));
  return { repo, candidates };
};
const prepare = async (session: string, entries: readonly unknown[] = [input('hello')], intent: ConversationIntent = 'generate',
  branch = session, extra: Record<string, unknown> = {}) => {
  const ctx = mockChatGatewayCtx({ conversationSecret: secret });
  const headers = new Headers({ 'x-floway-conversation-id': session, 'x-floway-conversation-branch': branch });
  const payload = canonicalizeOpenAIResponsesPayload({ model: 'model', input: entries, ...extra });
  const conversation = await createConversationRequest(secret, 'responses', payload, headers, intent, ctx.affinity.codec);
  if (!conversation) throw new Error('Expected conversation');
  return { ctx, headers, payload, conversation, id: await conversation.key('pool', ctx.apiKeyId) };
};
const dispatch = async (candidates: ModelCandidate[], request: Awaited<ReturnType<typeof prepare>>,
  action: (candidate: ModelCandidate) => Promise<{ type: 'events'; events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> } | ApiErrorResult> =
    async () => ({ type: 'events', events: syntheticEventsFromResult(answer) })) => {
  return await iterateCandidates(candidates, 'conversation-test', request.ctx, 'chat', async (candidate, ctx) => {
    request.ctx.affinity.select(candidate);
    return await buildUpstreamCallOptions(candidate, ctx, request.headers).wrapUpstreamCall(() => action(candidate));
  }, { conversation: request.conversation });
};
const consume = async (result: Awaited<ReturnType<typeof dispatch>>, request: Awaited<ReturnType<typeof prepare>>) => {
  if (result.type !== 'events') throw new Error('Expected response stream');
  return await collectOpenAIResponsesProtocolEventsToResult(wrapOpenAIResponsesClientEgress(result.events, request.ctx, request.payload));
};
const exhaust = (candidate: ModelCandidate) => {
  const now = Date.now();
  candidate.provider.getSubscriptionAccountStatus = async () => ({
    identity: candidate.provider.upstreamId, health: 'active', observedAt: now, utilization: 1, unavailableUntil: now + 60_000,
  });
};

test('twelve completed turns keep one account, while a new idle session goes to the other account', async () => {
  const { repo, candidates } = await setup();
  let entries: unknown[] = [input('hello')];
  for (let index = 0; index < 12; index++) {
    const request = await prepare('session', entries);
    const response = await consume(await dispatch(candidates, request), request);
    expect((await repo.subscriptionConversations.get(request.id))?.upstreamId).toBe('account-a');
    entries = [...entries, ...response.output, input(`turn-${index}`)];
  }
  const next = await prepare('new-session');
  await consume(await dispatch(candidates, next), next);
  expect((await repo.subscriptionConversations.get(next.id))?.upstreamId).toBe('account-b');
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).map(account => account.inFlight)).toEqual([0, 0]);
});

test('a busy bound account never borrows a free account or promises an unknown recovery time', async () => {
  const { repo, candidates } = await setup(1);
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  await repo.subscriptionPools.acquire({
    poolId: 'pool', token: 'other-request', modelKey: 'other-model', now: Date.now(), expiresAt: Date.now() + 120_000,
    candidates: [{ upstreamId: 'account-a', identity: JSON.stringify(['codex', 'account-a']), utilization: null }],
  });
  const request = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const run = vi.fn(async () => ({ type: 'events' as const, events: syntheticEventsFromResult(answer) }));
  const result = await dispatch(candidates, request, run);
  expect(result.type).toBe('api-error');
  if (result.type !== 'api-error') throw new Error('Expected capacity error');
  expect(result.status).toBe(429);
  expect(result.headers?.has('retry-after')).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-a');
});

test('competing requests on one branch are rejected, while explicit independent branches can run in parallel', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const result = await dispatch(candidates, first);
  const duplicate = await dispatch(candidates, await prepare('session'));
  expect(duplicate.type === 'api-error' && duplicate.status).toBe(409);
  const branch = await prepare('session', [input('branch')], 'generate', 'other-branch');
  await consume(await dispatch(candidates, branch), branch);
  expect((await repo.subscriptionConversations.get(branch.id))?.upstreamId).toBe('account-b');
  await consume(result, first);
});

test('known quota rejection migrates only a full portable history and commits after the terminal result', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  const request = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const calls: string[] = [];
  const result = await dispatch(candidates, request, async candidate => {
    calls.push(candidate.provider.upstreamId);
    return candidate.provider.upstreamId === 'account-a' ? upstreamError(429) : { type: 'events', events: syntheticEventsFromResult(answer) };
  });
  expect(calls).toEqual(['account-a', 'account-b']);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-a', targetUpstreamId: 'account-b', phase: 'dispatched' });
  await consume(result, request);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-b', migrations: 1, phase: 'active' });
  expect(request.payload.input).toEqual([...first.payload.input, ...response.output, input('next')]);
});

test.each([
  ['missing history', [input('next')], {}, 'history_unavailable'],
  ['missing account file', [input('hello'), ...answer.output, { type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file-from-a' }] }], {}, 'attachment_unavailable'],
  ['native reasoning', [input('hello'), ...answer.output, { type: 'reasoning', summary: [], encrypted_content: 'native-a' }, input('next')], {}, 'opaque_context'],
  ['changed directives', [input('hello'), ...answer.output, input('next')], { instructions: 'new directive' }, 'settings_changed'],
] as const)('unsafe %s blocks migration and retains the original account', async (_name, entries, extra, reason) => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  await consume(await dispatch(candidates, first), first);
  exhaust(candidates[0]!);
  const request = await prepare('session', [...entries], 'generate', 'session', extra);
  const run = vi.fn(async () => ({ type: 'events' as const, events: syntheticEventsFromResult(answer) }));
  const result = await dispatch(candidates, request, run);
  expect(result.type === 'api-error' && result.status).toBe(409);
  expect(run).not.toHaveBeenCalled();
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-a', blockedReason: reason, migrations: 0 });
});

test('a blocked handoff preserves the actual upstream rejection and adds an explicit Floway diagnostic', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  await consume(await dispatch(candidates, first), first);
  const request = await prepare('session', [input('only-last-message')]);
  const original = upstreamError(429);
  const result = await dispatch(candidates, request, async () => original);
  expect(result.type).toBe('api-error');
  if (result.type !== 'api-error') throw new Error('Expected rejection');
  expect(result.status).toBe(original.status);
  expect(result.body).toBe(original.body);
  expect(result.headers?.get('x-upstream')).toBe('preserved');
  expect(result.headers?.get('retry-after')).toBe('60');
  expect(result.headers?.get('x-floway-conversation-error')).toBe('history_unavailable');
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-a');
});

test('a 5xx after dispatch is uncertain, is never retried, and blocks later automatic execution', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  const run = vi.fn(async () => upstreamError(503));
  expect((await dispatch(candidates, request, run)).type).toBe('api-error');
  expect(run).toHaveBeenCalledTimes(1);
  expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('uncertain');
  const next = await dispatch(candidates, await prepare('session'));
  expect(next.type === 'api-error' && next.status).toBe(409);
});

test('readonly token measurements never create, advance or migrate a binding', async () => {
  const { repo, candidates } = await setup();
  const measure = async (request: Awaited<ReturnType<typeof prepare>>) =>
    await iterateCandidates(candidates, 'measure-test', request.ctx, 'chat', async () => ({ type: 'plain' as const, status: 200 }), { conversation: request.conversation });
  await measure(await prepare('new', undefined, 'measure'));
  expect(await repo.subscriptionConversations.list('pool')).toEqual([]);
  const first = await prepare('session');
  await consume(await dispatch(candidates, first), first);
  const before = await repo.subscriptionConversations.get(first.id);
  if (!before) throw new Error('Expected binding');
  await measure(await prepare('session', undefined, 'measure'));
  expect(await repo.subscriptionConversations.get(first.id)).toEqual(before);
  const owner = candidates.find(candidate => candidate.provider.upstreamId === before.upstreamId);
  if (!owner) throw new Error('Expected bound account');
  exhaust(owner);
  const result = await measure(await prepare('session', undefined, 'measure'));
  expect(result.type === 'api-error' && result.status).toBe(429);
  expect(await repo.subscriptionConversations.get(first.id)).toEqual(before);
});

test('temporary cooldowns and paused destination accounts do not steal a healthy binding', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  await repo.subscriptionPools.observe({ upstreamId: 'account-a', modelKey: subscriptionPoolModelKey(candidates[0]!), status: 503, cooldownUntil: Date.now() + 5_000 });
  const request = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const temporary = await dispatch(candidates, request);
  expect(temporary.type === 'api-error' && temporary.status).toBe(503);
  await repo.subscriptionPools.reset('account-a');
  await repo.subscriptionPools.setAcceptNewSessions('account-b', false);
  exhaust(candidates[0]!);
  const unavailable = await dispatch(candidates, request);
  expect(unavailable.type === 'api-error' && unavailable.status).toBe(429);
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-a');
});

test('cancellation before the first downstream read aborts the real signal, releases its lease and records uncertainty', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  let signal: AbortSignal | undefined;
  const result = await iterateCandidates(candidates, 'cancel-test', request.ctx, 'chat', async (candidate, ctx) => {
    signal = ctx.abortSignal;
    request.ctx.affinity.select(candidate);
    return await buildUpstreamCallOptions(candidate, ctx, request.headers).wrapUpstreamCall(async () => ({ type: 'events' as const, events: syntheticEventsFromResult(answer) }));
  }, { conversation: request.conversation });
  if (result.type !== 'events') throw new Error('Expected stream');
  const frames = wrapOpenAIResponsesClientEgress(result.events, request.ctx, request.payload);
  await frames[Symbol.asyncIterator]().return?.();
  expect(signal?.aborted).toBe(true);
  expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('uncertain');
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('an existing exact gateway checkpoint can migrate without requesting a new summary', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session', [input('hello'), { type: 'compaction_trigger' }]);
  const checkpoint = [input('accepted checkpoint')];
  const compact = await consume(await dispatch(candidates, request, async () => ({
    type: 'events', events: syntheticEventsFromResult({
      ...answer, output: [{ type: 'compaction', id: 'cmp_test', encrypted_content: encodeBase64UrlJson(checkpoint) }],
    }),
  })), request);
  expect(await repo.subscriptionConversations.get(request.id)).toMatchObject({ contextLength: 1, portable: true });
  exhaust(candidates[0]!);
  const next = await prepare('session', [...compact.output, input('continue')]);
  const run = vi.fn(async () => ({ type: 'events' as const, events: syntheticEventsFromResult(answer) }));
  await consume(await dispatch(candidates, next, run), next);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await repo.subscriptionConversations.get(request.id))?.upstreamId).toBe('account-b');
});

test('a removed member migrates only inside the caller-visible pool, never through a hidden or standalone account', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  await repo.subscriptionPools.save({ ...subscriptionPoolFixture(), upstreamIds: ['account-b'] });
  const request = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const hidden = await dispatch([candidates[0]!], request);
  expect(hidden.type).toBe('api-error');
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-a');
  await consume(await dispatch([candidates[1]!], request), request);
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-b');
});

test('source-model incompatibility blocks a handoff rather than silently using another mapped model', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  exhaust(candidates[0]!);
  const destination = candidates[1]!;
  const changed = stubModelCandidate({
    provider: destination.provider,
    model: {
      id: destination.model.id, providerModels: {
        [destination.provider.upstreamId]: stubProviderModel({ id: 'other', upstreamModelId: 'other' }),
      },
    },
  });
  const request = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const result = await dispatch([candidates[0]!, changed], request);
  expect(result.type === 'api-error' && result.status).toBe(409);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-a', blockedReason: 'incompatible_model' });
});

test('an account replacement between reservation and actual dispatch is detected before any network execution', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  const network = vi.fn(async () => ({ type: 'events' as const, events: syntheticEventsFromResult(answer) }));
  await expect(iterateCandidates(candidates, 'replacement-test', request.ctx, 'chat', async (candidate, ctx) => {
    expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('preparing');
    await saveUpstreamForTest(repo.upstreams, { ...codexPoolUpstream('replacement'), id: candidate.provider.upstreamId });
    return await buildUpstreamCallOptions(candidate, ctx, request.headers).wrapUpstreamCall(network);
  }, { conversation: request.conversation })).rejects.toThrow('changed before conversation dispatch');
  expect(network).not.toHaveBeenCalled();
  expect(await repo.subscriptionConversations.get(request.id)).toMatchObject({ upstreamId: 'account-a', accountIdentity: JSON.stringify(['codex', 'account-a']), phase: 'blocked' });
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('conversation persistence failure releases the acquired reservation and propagates its original error', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  const failure = new Error('conversation database unavailable');
  vi.spyOn(repo.subscriptionConversations, 'start').mockRejectedValueOnce(failure);
  await expect(dispatch(candidates, request)).rejects.toBe(failure);
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('a native agent user-turn ID spans legitimate tool continuations without moving the account', async () => {
  const { repo, candidates } = await setup();
  const metadata = { client_metadata: { session_id: 'native-session', turn_id: 'user-turn' } };
  const first = await prepare('session', [input('read a file')], 'generate', 'session', metadata);
  const calls: OpenAIResponsesResult = {
    ...answer, output: [
      { type: 'function_call', id: 'fc_test', call_id: 'call', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
    ],
  };
  const response = await consume(await dispatch(candidates, first, async () => ({ type: 'events', events: syntheticEventsFromResult(calls) })), first);
  const continued = await prepare('session', [...first.payload.input, ...response.output, { type: 'function_call_output', call_id: 'call', output: 'bytes' }], 'generate', 'session', metadata);
  expect(continued.conversation.turnKey).not.toBe(first.conversation.turnKey);
  await consume(await dispatch(candidates, continued), continued);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ phase: 'active', upstreamId: 'account-a', migrations: 0 });
  const replay = await dispatch(candidates, continued);
  expect(replay.type === 'api-error' && replay.status).toBe(409);
});

test('missing terminal frames are uncertain and never falsely advance the context proof', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  const result = await dispatch(candidates, request, async () => ({
    type: 'events', events: (async function* () {
      yield eventFrame({ type: 'response.created' as const, response: { ...answer, status: 'in_progress' as const, output: [] } });
    })(),
  }));
  await expect(consume(result, request)).rejects.toThrow('without a terminal');
  expect(await repo.subscriptionConversations.get(request.id)).toMatchObject({ phase: 'uncertain', contextHash: null, contextLength: 0 });
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('a real long-turn heartbeat owns the branch past two minutes, then cancellation settles it without a ghost renewal', async () => {
  const { repo, candidates } = await setup();
  vi.useFakeTimers();
  const request = await prepare('session');
  const result = await dispatch(candidates, request);
  await vi.advanceTimersByTimeAsync(180_000);
  expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('dispatched');
  if (result.type !== 'events') throw new Error('Expected stream');
  await wrapOpenAIResponsesClientEgress(result.events, request.ctx, request.payload)[Symbol.asyncIterator]().return?.();
  expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('uncertain');
  const renew = vi.spyOn(repo.subscriptionPools, 'renew');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(renew).not.toHaveBeenCalled();
});

test('unpooled requests retain their legacy path without hashing or requiring a conversation secret', async () => {
  initRepo(new InMemoryRepo());
  const factory = vi.fn(async () => { throw new Error('Unpooled request must not build a conversation proof'); });
  const result = await iterateCandidates([stubModelCandidate()], 'legacy-test', mockChatGatewayCtx(), 'chat',
    async () => ({ type: 'result' as const }), { conversationForRequest: factory });
  expect(result.type).toBe('result');
  expect(factory).not.toHaveBeenCalled();
});

test('a truncated successful turn on the original account never replaces missing history with a portable proof', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  await consume(await dispatch(candidates, first), first);
  const truncated = await prepare('session', [input('only-last-message')]);
  const response = await consume(await dispatch(candidates, truncated), truncated);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-a', portable: false, phase: 'active' });
  exhaust(candidates[0]!);
  const next = await prepare('session', [...truncated.payload.input, ...response.output, input('next')]);
  const result = await dispatch(candidates, next);
  expect(result.type === 'api-error' && result.status).toBe(409);
  expect(await repo.subscriptionConversations.get(first.id)).toMatchObject({ upstreamId: 'account-a', portable: false, migrations: 0 });
});

test('terminal proof persistence must succeed before a client can observe response.completed', async () => {
  const { repo, candidates } = await setup();
  const request = await prepare('session');
  const result = await dispatch(candidates, request);
  if (result.type !== 'events') throw new Error('Expected upstream events');
  const failure = new Error('terminal context proof storage failed');
  vi.spyOn(repo.subscriptionConversations, 'finish').mockRejectedValueOnce(failure);
  const emitted: string[] = [];
  const frames = wrapOpenAIResponsesClientEgress(result.events, request.ctx, request.payload);
  await expect((async () => {
    for await (const frame of frames) if (frame.type === 'event') emitted.push(frame.event.type);
  })()).rejects.toBe(failure);
  expect(emitted).not.toContain('response.completed');
  expect((await repo.subscriptionConversations.get(request.id))?.phase).toBe('uncertain');
  expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
});

test('a narrowed route cannot hide an existing binding and silently send its session to an unrelated provider', async () => {
  const { repo, candidates } = await setup();
  const first = await prepare('session');
  const response = await consume(await dispatch(candidates, first), first);
  const next = await prepare('session', [...first.payload.input, ...response.output, input('next')]);
  const run = vi.fn(async () => ({ type: 'result' as const }));
  const factory = vi.fn(async () => next.conversation);
  const unrelated = stubModelCandidate();
  expect(unrelated.provider.kind).not.toBe('codex');
  const result = await iterateCandidates([unrelated], 'narrowed-route', next.ctx, 'chat', run, { conversationForRequest: factory });
  expect(factory).toHaveBeenCalledTimes(1);
  expect(result.type).toBe('api-error');
  expect(run).not.toHaveBeenCalled();
  expect((await repo.subscriptionConversations.get(first.id))?.upstreamId).toBe('account-a');
});
