import type { ExecutionContext } from 'hono';
import { expect, test, vi } from 'vitest';

import { app } from '../../../../src/app.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { codexModels, requestAppWithWarmModels, setupAppTest, sseOpenAIResponsesResponse, warmModelsForTest } from '../../../test-utils/app.ts';
import { codexPoolUpstream, subscriptionPoolFixture } from '../../../test-utils/subscription-pools.ts';
import { installWorkerWebSocketRuntime, type TestWorkerWebSocket } from '../../../test-utils/worker-websocket.ts';
import { isRecord } from '@floway-dev/provider';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const setup = async () => {
  const context = await setupAppTest();
  await context.repo.upstreams.deleteAll();
  for (const id of ['account-a', 'account-b']) await saveUpstreamForTest(context.repo.upstreams, codexPoolUpstream(id));
  await context.repo.subscriptionPools.save(subscriptionPoolFixture());
  return context;
};
const mocked = async <T>(run: (accounts: string[]) => Promise<T>): Promise<T> => {
  const accounts: string[] = [];
  return await withMockedFetch(async request => {
    const url = new URL(request.url);
    if (url.pathname === '/backend-api/codex/models') return jsonResponse(codexModels([{ slug: 'gpt-5.4' }]));
    if (url.pathname === '/backend-api/codex/responses') {
      const account = request.headers.get('chatgpt-account-id');
      if (!account) throw new Error('Native Codex wire request is missing its real account');
      accounts.push(account);
      return sseOpenAIResponsesResponse({
        id: `resp_${accounts.length}`, object: 'response', model: 'gpt-5.4', status: 'completed', error: null, incomplete_details: null,
        output: [{ type: 'message', id: `msg_${accounts.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
      });
    }
    throw new Error(`Unexpected subscription test fetch ${url.origin}${url.pathname}`);
  }, async () => await run(accounts));
};

test('native HTTP session identity stays sticky through hydrated previous_response_id without duplicating context', async () => {
  const { apiKey, repo } = await setup();
  await mocked(async accounts => {
    const call = async (session: string, payload: Record<string, unknown>) => {
      const response = await requestAppWithWarmModels('/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key, 'session-id': session },
        body: JSON.stringify({ model: 'gpt-5.4', ...payload }),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.id !== 'string') throw new Error('Expected client response resource');
      return body;
    };
    const first = await call('session-a', { input: 'first', store: true });
    await call('session-a', { previous_response_id: first.id, input: 'next', store: true });
    await call('session-b', { input: 'different session', store: true });
    expect(accounts).toEqual(['account-a', 'account-a', 'account-b']);
    const rows = await repo.subscriptionConversations.list('pool');
    expect(rows.map(row => row.phase)).toEqual(['active', 'active']);
    const original = rows.find(row => row.upstreamId === 'account-a');
    expect(original?.portable).toBe(true);
    expect(original?.contextLength).toBe(4);
    expect((await repo.subscriptionPools.runtime('pool', Date.now())).every(account => account.inFlight === 0)).toBe(true);
  });
});

const sendTurn = async (socket: TestWorkerWebSocket, session: string) => {
  const events: unknown[] = [];
  const listener = (event: Event) => { events.push(JSON.parse((event as MessageEvent<string>).data)); };
  socket.addEventListener('message', listener);
  try {
    socket.send(JSON.stringify({
      type: 'response.create', response: {
        model: 'gpt-5.4', input: `hello ${session}`,
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: session, thread_id: session, turn_id: `${session}-turn` }) },
      },
    }));
    await vi.waitFor(() => expect(events.some(event => isRecord(event) && event.type === 'response.completed')).toBe(true));
  } finally { socket.removeEventListener('message', listener); }
};

test('one WebSocket can create different logical sessions from current frame metadata despite frozen handshake headers', async () => {
  const { apiKey, repo } = await setup();
  await mocked(async accounts => {
    const runtime = installWorkerWebSocketRuntime();
    try {
      await warmModelsForTest();
      const execution = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } satisfies ExecutionContext;
      const response = await app.fetch(new Request('https://example.test/v1/responses', {
        headers: { upgrade: 'websocket', 'x-api-key': apiKey.key, 'session-id': 'old-handshake', 'thread-id': 'old-thread' },
      }), {}, execution);
      expect(response.status).toBe(101);
      const socket = runtime.pairs.at(-1)?.client;
      if (!socket) throw new Error('Expected WebSocket runtime pair');
      await sendTurn(socket, 'body-session-a');
      await sendTurn(socket, 'body-session-b');
      expect(accounts).toEqual(['account-a', 'account-b']);
      expect((await repo.subscriptionConversations.list('pool')).map(row => row.upstreamId).toSorted()).toEqual(['account-a', 'account-b']);
      expect((await repo.subscriptionConversations.list('pool')).every(row => row.phase === 'active')).toBe(true);
      socket.close();
    } finally { runtime.restore(); }
  });
});
