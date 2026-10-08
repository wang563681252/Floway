import { expect, test } from 'vitest';

import { claudeCodeSubscriptionSession } from '../src/client-session.ts';

test('Claude Code JSON and legacy metadata yield the same logical session', () => {
  const session = '11111111-2222-4333-8444-555555555555';
  const headers = new Headers({ 'x-client-request-id': 'turn' });
  expect(claudeCodeSubscriptionSession(headers, {
    metadata: { user_id: JSON.stringify({ device_id: 'device-a', account_uuid: 'account-a', session_id: session }) },
  })).toEqual({ sessionId: session, threadId: session, turnId: 'turn' });
  expect(claudeCodeSubscriptionSession(headers, {
    metadata: { user_id: `user_${'a'.repeat(64)}_account__session_${session}` },
  })).toEqual({ sessionId: session, threadId: session, turnId: 'turn' });
});

test('Claude session metadata outranks a header and missing identity remains stateless', () => {
  const headers = new Headers({ 'x-claude-code-session-id': 'header-session' });
  expect(claudeCodeSubscriptionSession(headers, {
    metadata: { user_id: JSON.stringify({ device_id: 'device', session_id: 'body-session' }) },
  })?.sessionId).toBe('body-session');
  expect(claudeCodeSubscriptionSession(new Headers(), { messages: [{ role: 'user', content: 'same text' }] })).toBeNull();
});
