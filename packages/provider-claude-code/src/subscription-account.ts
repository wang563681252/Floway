import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { readClaudeCodeUpstreamState, type ClaudeCodeAccountCredential } from './state.ts';
import type { SubscriptionAccountStatus, UpstreamRecord } from '@floway-dev/provider';

export const readClaudeCodeSubscriptionAccountStatus = (record: UpstreamRecord): SubscriptionAccountStatus => {
  assertClaudeCodeUpstreamRecord(record);
  const account = readClaudeCodeUpstreamState(record.state).accounts[0];
  if (account.accountUuid !== record.config.accounts[0].accountUuid) throw new Error('Claude Code subscription identity does not match its credential');
  return claudeCodeSubscriptionAccountStatus(account);
};

export const claudeCodeSubscriptionAccountStatus = (account: ClaudeCodeAccountCredential, now = Date.now()): SubscriptionAccountStatus => {
  const snapshot = account.quotaSnapshot;
  const windows = [snapshot?.data.fiveHour, snapshot?.data.sevenDay];
  const utilization = windows.flatMap(window =>
    window?.utilization !== null && window?.utilization !== undefined && window.utilization >= 0
    && (window.reset === null || Date.parse(window.reset) > now)
      ? [Math.min(window.utilization, 1)] : []);
  // The unified allowed state can include overage or fallback capacity; a
  // saturated included-usage window alone is not an account-wide rejection.
  // https://github.com/apstenku123/claude-code-reverse
  const exhausted = snapshot?.data.status === 'allowed' ? [] : windows.flatMap(window =>
    window && (window.status === 'rejected' || (window.utilization !== null && window.utilization >= 1))
    && window.reset !== null && Date.parse(window.reset) > now ? [Date.parse(window.reset)] : []);
  if (snapshot?.data.status === 'rejected' && snapshot.data.reset !== null && Date.parse(snapshot.data.reset) > now) {
    exhausted.push(Date.parse(snapshot.data.reset));
  }
  const expiredSetupToken = account.tokenKind === 'setup-token' && account.accessToken !== null && account.accessToken.expiresAt <= now;
  return {
    identity: account.accountUuid,
    health: expiredSetupToken ? 'session_terminated' : account.state,
    observedAt: snapshot?.fetchedAt ?? null,
    utilization: utilization.length === 0 ? null : Math.max(...utilization),
    unavailableUntil: exhausted.length === 0 ? null : Math.max(...exhausted),
  };
};
