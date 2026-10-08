import { expect, test } from 'vitest';

import { codexSubscriptionSession } from '../src/client-identity.ts';

test('per-turn Codex body identity outranks a frozen WebSocket handshake', () => {
  const headers = new Headers({
    'session-id': 'old-session', 'thread-id': 'old-thread',
    'x-codex-turn-metadata': JSON.stringify({ session_id: 'handshake', thread_id: 'handshake-thread', turn_id: 'old-turn' }),
  });
  expect(codexSubscriptionSession(headers, {
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'session', thread_id: 'branch', turn_id: 'turn' }) },
  })).toEqual({ sessionId: 'session', threadId: 'branch', turnId: 'turn' });
  expect(codexSubscriptionSession(headers, {
    client_metadata: {
      session_id: 'flat-session', thread_id: 'flat-thread', turn_id: 'flat-turn',
      'x-codex-turn-metadata': JSON.stringify({ session_id: 'blob-session', thread_id: 'blob-thread' }),
    },
  })).toEqual({ sessionId: 'flat-session', threadId: 'flat-thread', turnId: 'flat-turn' });
});

test('a thread alone is stable, but message text never invents a subscription session', () => {
  expect(codexSubscriptionSession(new Headers({ 'thread-id': 'thread' }), {}))
    .toEqual({ sessionId: 'thread', threadId: 'thread', turnId: null });
  expect(codexSubscriptionSession(new Headers(), { input: [{ role: 'user', content: 'same text' }] })).toBeNull();
  expect(codexSubscriptionSession(new Headers({ session_id: ' session ' }), {}))
    .toEqual({ sessionId: 'session', threadId: 'session', turnId: null });
});

test('malformed optional turn metadata cannot displace a valid header identity', () => {
  expect(codexSubscriptionSession(new Headers({ 'session-id': 'session' }), { client_metadata: { 'x-codex-turn-metadata': 'bad-json' } }))
    .toEqual({ sessionId: 'session', threadId: 'session', turnId: null });
});
