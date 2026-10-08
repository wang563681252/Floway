import { assertCodexUpstreamRecord } from './config.ts';
import { readCodexUpstreamState, type CodexAccountCredential } from './state.ts';
import type { SubscriptionAccountStatus, UpstreamRecord } from '@floway-dev/provider';

export const readCodexSubscriptionAccountStatus = (record: UpstreamRecord): SubscriptionAccountStatus => {
  assertCodexUpstreamRecord(record);
  const account = readCodexUpstreamState(record.state).accounts.find(item => item.chatgptAccountId === record.config.accounts[0].chatgptAccountId);
  if (!account) throw new Error('Codex subscription identity does not match its credential');
  return codexSubscriptionAccountStatus(account);
};

export const codexSubscriptionAccountStatus = (account: CodexAccountCredential, now = Date.now()): SubscriptionAccountStatus => {
  const snapshots = Object.values(account.quotaSnapshot ?? {}).toSorted((left, right) => right.fetchedAt - left.fetchedAt);
  const latest = snapshots[0];
  const readings = latest === undefined ? [] : [
    [latest.data.primary_used_percent, latest.data.primary_reset_after_at],
    [latest.data.secondary_used_percent, latest.data.secondary_reset_after_at],
  ] as const;
  const utilization = readings.flatMap(([used, reset]) =>
    used !== undefined && Number.isFinite(used) && used >= 0 && (reset === undefined || Date.parse(reset) > now)
      ? [Math.min(used / 100, 1)] : []);
  const expiredAccessOnly = account.refresh_token === null
    && account.accessToken?.expiresAt !== null
    && account.accessToken?.expiresAt !== undefined
    && account.accessToken.expiresAt <= now;
  return {
    identity: account.chatgptAccountId,
    health: expiredAccessOnly ? 'session_terminated' : account.state,
    observedAt: latest?.fetchedAt ?? null,
    utilization: utilization.length === 0 ? null : Math.max(...utilization),
    // Active-limit families are not model ids. A 429 observed for the actual
    // requested model establishes its pool cooldown; another family's snapshot
    // must not block it. https://github.com/openai/codex/blob/602d2add6e6df7e2c301c0507434b02a7463337d/codex-rs/codex-api/src/rate_limits.rs
    unavailableUntil: null,
  };
};
