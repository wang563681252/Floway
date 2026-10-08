import { expect, test } from 'vitest';

import type { CodexAccountCredential } from '../src/state.ts';
import { codexSubscriptionAccountStatus } from '../src/subscription-account.ts';

const now = Date.parse('2026-10-08T00:00:00.000Z');
const account: CodexAccountCredential = {
  chatgptAccountId: 'account', refresh_token: 'test-refresh', state: 'active',
  state_updated_at: '2026-10-08T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null, quotaSnapshot: null,
};

test('missing observations remain unknown and never become a zero or exhausted quota', () => {
  expect(codexSubscriptionAccountStatus(account, now)).toEqual({
    identity: 'account', health: 'active', observedAt: null, utilization: null, unavailableUntil: null,
  });
});

test('the newest active-limit observation guides ranking without blocking another quota family', () => {
  const result = codexSubscriptionAccountStatus({
    ...account,
    quotaSnapshot: {
      old: { fetchedAt: now - 10_000, data: { observed_at: new Date(now - 10_000).toISOString(), primary_used_percent: 100 } },
      premium: {
        fetchedAt: now, data: {
          observed_at: new Date(now).toISOString(),
          primary_used_percent: 40, primary_reset_after_at: new Date(now + 60_000).toISOString(),
          secondary_used_percent: 100, secondary_reset_after_at: new Date(now + 120_000).toISOString(),
          ratelimited_until: new Date(now + 120_000).toISOString(),
        },
      },
    },
  }, now);
  expect(result.observedAt).toBe(now);
  expect(result.utilization).toBe(1);
  expect(result.unavailableUntil).toBeNull();
});

test('expired quota windows and expired access-only credentials do not look freshly available', () => {
  const result = codexSubscriptionAccountStatus({
    ...account, refresh_token: null,
    accessToken: { token: 'test-access', expiresAt: now - 1, refreshedAt: new Date(now).toISOString() },
    quotaSnapshot: {
      exhausted: { fetchedAt: now, data: { observed_at: new Date(now).toISOString(), primary_used_percent: 100, primary_reset_after_at: new Date(now - 1).toISOString() } },
    },
  }, now);
  expect(result.health).toBe('session_terminated');
  expect(result.utilization).toBeNull();
});
