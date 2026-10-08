import { buildCodexUpstreamRecord } from './app.ts';
import type { SubscriptionPool } from '../../src/repo/subscription-pools.ts';
import { assertCodexUpstreamRecord, readCodexUpstreamState } from '@floway-dev/provider-codex';

export const codexPoolUpstream = (id: string) => {
  const record = buildCodexUpstreamRecord({ id, name: id });
  assertCodexUpstreamRecord(record);
  const state = readCodexUpstreamState(record.state);
  return {
    ...record,
    config: { ...record.config, accounts: [{ ...record.config.accounts[0], chatgptAccountId: id }] },
    state: { ...state, accounts: [{ ...state.accounts[0]!, chatgptAccountId: id }] },
  };
};

export const subscriptionPoolFixture = (limit: number | null = 50): SubscriptionPool => ({
  id: 'pool', name: 'Subscriptions', provider: 'codex', enabled: true, maxConcurrentRequests: limit,
  upstreamIds: ['account-a', 'account-b'], createdAt: '2026-10-08T00:00:00.000Z',
});
