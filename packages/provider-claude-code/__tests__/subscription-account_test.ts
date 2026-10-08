import { expect, test } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import type { ClaudeCodeAccountCredential } from '../src/state.ts';
import { claudeCodeSubscriptionAccountStatus } from '../src/subscription-account.ts';

const now = Date.parse('2026-10-08T00:00:00.000Z');
const account: ClaudeCodeAccountCredential = {
  accountUuid: 'account', tokenKind: 'oauth', refreshToken: 'test-refresh', state: 'active',
  stateUpdatedAt: new Date(now).toISOString(), accessToken: null, quotaSnapshot: null, usageProbeSnapshot: null,
};

test('quota hints preserve unknown observations rather than inventing available quota', () => {
  expect(claudeCodeSubscriptionAccountStatus(account, now)).toEqual({
    identity: 'account', health: 'active', observedAt: null, utilization: null, unavailableUntil: null,
  });
});

test('fresh rejected windows retain their latest known reset and measured utilization', () => {
  const quota = parseClaudeCodeQuotaHeaders(new Headers({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String((now + 60_000) / 1000),
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1',
    'anthropic-ratelimit-unified-7d-reset': String((now + 120_000) / 1000),
  }));
  expect(claudeCodeSubscriptionAccountStatus({ ...account, quotaSnapshot: { fetchedAt: now, data: quota } }, now))
    .toMatchObject({ utilization: 1, unavailableUntil: now + 120_000 });
});

test('expired setup credentials require reauthorization rather than participating in the pool', () => {
  expect(claudeCodeSubscriptionAccountStatus({
    ...account, tokenKind: 'setup-token', refreshToken: null,
    accessToken: { token: 'test-access', expiresAt: now - 1, refreshedAt: new Date(now).toISOString() },
  }, now).health).toBe('session_terminated');
});

test('an explicitly allowed account is not blocked by an exhausted included-usage window', () => {
  const quota = parseClaudeCodeQuotaHeaders(new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String((now + 60_000) / 1000),
    'anthropic-ratelimit-unified-overage-status': 'allowed',
  }));
  expect(claudeCodeSubscriptionAccountStatus({ ...account, quotaSnapshot: { fetchedAt: now, data: quota } }, now).unavailableUntil).toBeNull();
});
