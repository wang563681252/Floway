import { isEqual } from 'es-toolkit';

import { ConversationPoolSelection } from './conversation-selection.ts';
import type { ConversationTurn } from './conversation-stream.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { SUBSCRIPTION_LEASE_MS } from './subscription-pool-lease.ts';
import { subscriptionPoolModelKey, type PoolIterationOptions } from './subscription-pool-options.ts';
import { getRepo } from '../../repo/index.ts';
import type { SubscriptionPool, SubscriptionPoolLease } from '../../repo/subscription-pools.ts';
import type { ApiErrorResult, ModelCandidate } from '@floway-dev/provider';

export { subscriptionPoolModelKey, type PoolIterationOptions };

export class SubscriptionPoolSelection {
  private conversations: ConversationPoolSelection | undefined;
  private initialized = false;
  private readonly remaining: ModelCandidate[];
  private busy = false;
  private retryAt: number | null = null;
  private retryUnknown = false;

  get conversationFailure() { return this.conversations?.failure; }

  constructor(
    private readonly candidates: readonly ModelCandidate[],
    private readonly pools: readonly SubscriptionPool[],
    private readonly options: PoolIterationOptions,
  ) {
    this.conversations = options.conversation ? new ConversationPoolSelection(candidates, pools, options) : undefined;
    this.remaining = [...candidates].toSorted((left, right) =>
      (options.priorityFor?.(left) ?? 0) - (options.priorityFor?.(right) ?? 0));
  }

  async next(ctx: Pick<GatewayCtx, 'abortSignal'> & { apiKeyId?: string }): Promise<{ candidate: ModelCandidate; lease?: SubscriptionPoolLease; turn?: ConversationTurn } | null> {
    if (!this.initialized) {
      this.initialized = true;
      if (!this.conversations && this.options.conversationForRequest && this.pools.length > 0) {
        const conversation = await this.options.conversationForRequest();
        if (conversation) this.conversations = new ConversationPoolSelection(this.candidates, this.pools, { ...this.options, conversation });
      }
    }
    if (this.conversations) {
      const selected = await this.conversations.next(ctx);
      if (selected || this.conversations.failure) return selected;
    }
    while (this.remaining.length > 0) {
      ctx.abortSignal?.throwIfAborted();
      const first = this.remaining[0]!;
      const pool = this.pools.find(item => item.enabled && item.upstreamIds.includes(first.provider.upstreamId));
      if (!pool) {
        this.remaining.shift();
        return { candidate: first };
      }
      const priority = this.options.priorityFor?.(first) ?? 0;
      const cohort = this.remaining.filter(candidate =>
        candidate.model.id === first.model.id
        && isEqual(candidate.rules, first.rules)
        && (this.options.priorityFor?.(candidate) ?? 0) === priority
        && pool.upstreamIds.includes(candidate.provider.upstreamId));
      const now = Date.now();
      const hints = await Promise.all(cohort.map(async candidate => {
        if (!candidate.provider.getSubscriptionAccountStatus) throw new Error('Subscription pool contains a provider without account status support');
        return await candidate.provider.getSubscriptionAccountStatus();
      }));
      const eligible = cohort.flatMap((candidate, index) => {
        const hint = hints[index]!;
        if (hint.health !== 'active' || hint.identity === null) return [];
        const fresh = hint.observedAt !== null && hint.observedAt <= now && now - hint.observedAt <= 5 * 60_000;
        if (fresh && hint.unavailableUntil !== null && hint.unavailableUntil > now) {
          this.busy = true;
          this.retryAt = Math.min(this.retryAt ?? hint.unavailableUntil, hint.unavailableUntil);
          return [];
        }
        return [{ upstreamId: candidate.provider.upstreamId, identity: JSON.stringify([candidate.provider.kind, hint.identity]), utilization: fresh ? hint.utilization : null }];
      });
      const repo = getRepo().subscriptionPools;
      const lease = eligible.length === 0 ? null : await repo.acquire({
        poolId: pool.id, modelKey: subscriptionPoolModelKey(first, this.options.quotaScope), candidates: eligible,
        token: crypto.randomUUID(), now, expiresAt: now + SUBSCRIPTION_LEASE_MS,
      });
      if (lease) {
        const candidate = cohort.find(item => item.provider.upstreamId === lease.upstreamId);
        if (!candidate) throw new Error('Account lease escaped the caller-visible affinity cohort');
        this.remaining.splice(this.remaining.indexOf(candidate), 1);
        return { candidate, lease };
      }
      if (eligible.length > 0) {
        this.busy = true;
        const runtimes = await repo.runtime(pool.id, now);
        for (const runtime of runtimes.filter(item => eligible.some(candidate => candidate.upstreamId === item.upstreamId))) {
          const cooldown = runtime.cooldowns.find(item => item.modelKey === subscriptionPoolModelKey(first, this.options.quotaScope));
          if (cooldown) this.retryAt = Math.min(this.retryAt ?? cooldown.until, cooldown.until);
          else if (runtime.inFlight > 0) this.retryUnknown = true;
        }
      }
      for (const candidate of cohort) this.remaining.splice(this.remaining.indexOf(candidate), 1);
    }
    return null;
  }

  unavailable(): ApiErrorResult {
    if (this.conversations?.failure) {
      const failure = this.conversations.failure;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (failure.retryAt !== null && failure.retryAt > Date.now()) headers.set('retry-after', String(Math.ceil((failure.retryAt - Date.now()) / 1000)));
      const message = `Conversation remains on its bound account: ${failure.reason}. Context was not discarded and no summary migration was performed.`;
      const body = this.options.errorFormat === 'anthropic'
        ? { type: 'error', error: { type: failure.status === 429 ? 'rate_limit_error' : 'api_error', message } }
        : this.options.errorFormat === 'gemini'
          ? { error: { code: failure.status, status: failure.status === 429 ? 'RESOURCE_EXHAUSTED' : 'FAILED_PRECONDITION', message } }
          : { error: { type: 'api_error', code: failure.reason, message } };
      return { type: 'api-error', source: 'gateway', status: failure.status, headers, body: new TextEncoder().encode(JSON.stringify(body)) };
    }
    const status = this.busy ? 429 : 503;
    const message = this.busy
      ? 'All caller-visible compatible subscription accounts are busy or rate limited. Retry later.'
      : 'No caller-visible compatible subscription account has an active credential.';
    const headers = new Headers({ 'content-type': 'application/json' });
    if (this.retryAt !== null && !this.retryUnknown) headers.set('retry-after', String(Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000))));
    const body = this.options.errorFormat === 'gemini'
      ? { error: { code: status, status: this.busy ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE', message } }
      : this.options.errorFormat === 'anthropic'
        ? { type: 'error', error: { type: this.busy ? 'rate_limit_error' : 'api_error', message } }
        : { error: { type: this.busy ? 'rate_limit_error' : 'api_error', code: this.busy ? 'rate_limit_exceeded' : 'subscription_pool_unavailable', message } };
    return { type: 'api-error', source: 'gateway', status, headers, body: new TextEncoder().encode(JSON.stringify(body)) };
  }
}

export const recordSubscriptionPoolOutcome = async (candidate: ModelCandidate, status: number, headers?: Headers, scope = 'chat'): Promise<void> => {
  const now = Date.now();
  const retryAfter = headers?.get('retry-after')?.trim();
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  const date = retryAfter === undefined ? NaN : Date.parse(retryAfter);
  const hintedUntil = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000
    : Number.isFinite(date) && date > now ? date : null;
  const until = status === 429 ? hintedUntil ?? now + 30_000
    : status === 401 || status === 403 ? now + 60_000
      : status >= 500 ? hintedUntil ?? now + 5_000 : null;
  if (status >= 200 && status < 300 || until !== null) {
    await getRepo().subscriptionPools.observe({
      upstreamId: candidate.provider.upstreamId,
      modelKey: subscriptionPoolModelKey(candidate, scope), status, cooldownUntil: until,
    });
  }
};
