import { ConversationTurn } from './conversation-stream.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { SUBSCRIPTION_LEASE_MS } from './subscription-pool-lease.ts';
import { subscriptionPoolModelKey, type PoolIterationOptions } from './subscription-pool-options.ts';
import { getRepo } from '../../repo/index.ts';
import type { SubscriptionConversation } from '../../repo/subscription-conversations.ts';
import type { SubscriptionPool, SubscriptionPoolLease } from '../../repo/subscription-pools.ts';
import type { ModelCandidate, SubscriptionAccountStatus } from '@floway-dev/provider';

export interface ConversationSelectionFailure {
  status: 409 | 429 | 503;
  reason: string;
  retryAt: number | null;
}

export class ConversationPoolSelection {
  private readonly attempted = new Set<string>();
  failure: ConversationSelectionFailure | undefined;

  constructor(
    private readonly candidates: readonly ModelCandidate[],
    private readonly pools: readonly SubscriptionPool[],
    private readonly options: PoolIterationOptions,
  ) {}

  private reject(status: ConversationSelectionFailure['status'], reason: string, retryAt: number | null = null): null {
    this.failure = { status, reason, retryAt };
    return null;
  }

  private async faithful(binding: SubscriptionConversation): Promise<string | null> {
    const request = this.options.conversation;
    if (!request) throw new Error('Conversation selection requires a stable client identity');
    if (!request.context.portable) return request.context.reasons[0] ?? 'unsupported_context';
    if (request.context.pendingTools.length > 0) return 'pending_tool_results';
    if (binding.contextHash === null && binding.contextLength === 0) return null;
    if (!binding.portable) return 'opaque_context';
    if (binding.settingsHash !== null && binding.settingsHash !== request.settingsHash && request.intent !== 'compact') return 'settings_changed';
    if (request.context.entries.length < binding.contextLength) return 'history_unavailable';
    if (await request.hash(request.context.entries, binding.contextLength) !== binding.contextHash) return 'history_mismatch';
    return null;
  }

  async next(ctx: Pick<GatewayCtx, 'abortSignal'> & { apiKeyId?: string }): Promise<{
    candidate: ModelCandidate; lease: SubscriptionPoolLease; turn?: ConversationTurn;
  } | null> {
    const request = this.options.conversation;
    if (!request) throw new Error('Conversation selection requires a stable client identity');
    if (!ctx.apiKeyId) throw new Error('Session routing requires the authenticated API key id');
    ctx.abortSignal?.throwIfAborted();
    const repo = getRepo();
    const matchingPools = this.pools.filter(pool => this.candidates.some(candidate => pool.provider === candidate.provider.kind));
    const bound: Array<{ pool: SubscriptionPool; binding: SubscriptionConversation }> = [];
    for (const pool of this.pools) {
      const binding = await repo.subscriptionConversations.get(await request.key(pool.id, ctx.apiKeyId));
      if (binding) bound.push({ pool, binding });
    }
    if (bound.length > 1) return this.reject(409, 'ambiguous_pool_route');
    const chosen = bound[0];
    const pool = chosen?.pool ?? matchingPools.find(item => item.enabled && this.candidates.some(candidate => item.upstreamIds.includes(candidate.provider.upstreamId)));
    if (!pool) return chosen ? this.reject(503, 'no_session_account') : null;
    if (!chosen && !this.candidates.some(candidate => pool.upstreamIds.includes(candidate.provider.upstreamId))) return null;
    const binding = chosen?.binding ?? null;
    if (binding?.phase === 'closed') return this.reject(409, 'conversation_closed');
    if (binding?.phase === 'uncertain') return this.reject(409, 'execution_uncertain');
    if (binding?.phase === 'preparing' || binding?.phase === 'dispatched') return this.reject(409, 'conversation_busy');
    const now = Date.now();
    const runtime = await repo.subscriptionPools.runtime(pool.id, now);
    const candidates = this.candidates.filter(candidate => pool.upstreamIds.includes(candidate.provider.upstreamId)
      && !this.attempted.has(candidate.provider.upstreamId) && (this.options.priorityFor?.(candidate) ?? 0) < 2);
    const hints = new Map<string, SubscriptionAccountStatus>();
    for (const candidate of this.candidates.filter(item => pool.upstreamIds.includes(item.provider.upstreamId))) {
      if (!candidate.provider.getSubscriptionAccountStatus) throw new Error('Session account has no credential status contract');
      hints.set(candidate.provider.upstreamId, await candidate.provider.getSubscriptionAccountStatus());
    }
    let migration = false;
    let selected = candidates;
    if (binding) {
      const owner = this.candidates.find(candidate => candidate.provider.upstreamId === binding.upstreamId);
      const hint = hints.get(binding.upstreamId);
      const identity = hint?.identity === null || hint?.identity === undefined ? null : JSON.stringify([owner?.provider.kind, hint.identity]);
      const fresh = hint?.observedAt !== null && hint?.observedAt !== undefined && hint.observedAt <= now && now - hint.observedAt <= 5 * 60_000;
      const cooldown = runtime.find(account => account.upstreamId === binding.upstreamId)?.cooldowns
        .find(item => item.modelKey === (owner ? subscriptionPoolModelKey(owner, this.options.quotaScope) : ''));
      const quotaUnavailable = fresh && hint?.unavailableUntil !== null && hint?.unavailableUntil !== undefined && hint.unavailableUntil > now;
      const actualUnavailable = !owner || !pool.upstreamIds.includes(binding.upstreamId) || hint?.health !== 'active' || identity !== binding.accountIdentity
        || quotaUnavailable || cooldown?.status === 429 || cooldown?.status === 401 || cooldown?.status === 403
        || binding.migrationRequested;
      if (!actualUnavailable) {
        if (cooldown) return this.reject(503, 'account_temporarily_unavailable', cooldown.until);
        if (this.attempted.has(binding.upstreamId)) return this.reject(503, 'bound_account_unavailable');
        selected = candidates.filter(candidate => candidate.provider.upstreamId === binding.upstreamId);
      } else {
        if (request.intent === 'measure') return this.reject(429, 'bound_account_unavailable', cooldown?.until ?? hint?.unavailableUntil ?? null);
        const reason = await this.faithful(binding);
        if (reason) {
          await repo.subscriptionConversations.block(binding.id, reason);
          return this.reject(409, reason, cooldown?.until ?? hint?.unavailableUntil ?? null);
        }
        migration = true;
        selected = candidates.filter(candidate => {
          const targetIdentity = hints.get(candidate.provider.upstreamId)?.identity;
          return targetIdentity !== null && targetIdentity !== undefined
            && JSON.stringify([candidate.provider.kind, targetIdentity]) !== binding.accountIdentity;
        });
        if (binding.modelKey !== null) {
          selected = selected.filter(candidate => subscriptionPoolModelKey(candidate, this.options.quotaScope) === binding.modelKey);
          if (selected.length === 0) {
            await repo.subscriptionConversations.block(binding.id, 'incompatible_model');
            return this.reject(409, 'incompatible_model');
          }
        }
      }
    }
    const preferred = selected.toSorted((left, right) =>
      (this.options.priorityFor?.(left) ?? 0) - (this.options.priorityFor?.(right) ?? 0))[0];
    if (preferred) {
      selected = selected.filter(candidate => candidate.model.id === preferred.model.id
        && (this.options.priorityFor?.(candidate) ?? 0) === (this.options.priorityFor?.(preferred) ?? 0)
        && subscriptionPoolModelKey(candidate, this.options.quotaScope) === subscriptionPoolModelKey(preferred, this.options.quotaScope));
    }
    const eligible = selected.flatMap(candidate => {
      const hint = hints.get(candidate.provider.upstreamId);
      if (hint?.health !== 'active' || hint.identity === null) return [];
      const fresh = hint.observedAt !== null && hint.observedAt <= now && now - hint.observedAt <= 5 * 60_000;
      if (fresh && hint.unavailableUntil !== null && hint.unavailableUntil > now) return [];
      return [{ upstreamId: candidate.provider.upstreamId, identity: JSON.stringify([candidate.provider.kind, hint.identity]), utilization: fresh ? hint.utilization : null }];
    });
    const id = binding?.id ?? await request.key(pool.id, ctx.apiKeyId);
    const lease = eligible.length === 0 || !preferred ? null : await repo.subscriptionPools.acquire({
      poolId: pool.id, modelKey: subscriptionPoolModelKey(preferred, this.options.quotaScope),
      candidates: eligible, token: crypto.randomUUID(), now, expiresAt: now + SUBSCRIPTION_LEASE_MS,
      conversation: { id, apiKeyId: ctx.apiKeyId, isNew: (binding === null || migration) && request.intent !== 'measure' },
    });
    if (!lease) {
      const relevant = runtime.filter(account => selected.some(candidate => candidate.provider.upstreamId === account.upstreamId));
      const known = relevant.flatMap(account => account.cooldowns.filter(item =>
        selected.some(candidate => subscriptionPoolModelKey(candidate, this.options.quotaScope) === item.modelKey)).map(item => item.until));
      const unknown = relevant.some(account => account.inFlight > 0 && account.cooldowns.length === 0);
      return this.reject(429, binding && !migration ? 'bound_account_busy' : 'no_session_capacity', !unknown && known.length ? Math.min(...known) : null);
    }
    const candidate = selected.find(item => item.provider.upstreamId === lease.upstreamId);
    if (!candidate) throw new Error('Session lease escaped its compatible candidate set');
    if (request.intent === 'measure') return { candidate, lease };
    const result = await repo.subscriptionConversations.start({
      id, poolId: pool.id, apiKeyId: ctx.apiKeyId, upstreamId: lease.upstreamId, identity: lease.identity,
      leaseToken: lease.token, requestToken: lease.token, now: Date.now(), lockUntil: lease.expiresAt,
      turnKey: request.turnKey, requestHash: request.requestHash, migration, expectedVersion: binding?.version ?? null,
    }).catch(async error => {
      try { await repo.subscriptionPools.release(lease.token); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Conversation claim and reservation cleanup failed', { cause: error });
      }
      throw error;
    });
    if (result.kind !== 'claimed') {
      await repo.subscriptionPools.release(lease.token);
      return this.reject(409, result.kind === 'uncertain' ? 'execution_uncertain'
        : result.kind === 'repeated' ? 'turn_already_completed' : 'conversation_busy');
    }
    this.attempted.add(candidate.provider.upstreamId);
    return { candidate, lease, turn: new ConversationTurn(result.claim, request, subscriptionPoolModelKey(candidate, this.options.quotaScope)) };
  }
}
