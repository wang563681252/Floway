import { stampUpstreamCallStart } from './attempt-timing.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { filterInboundHeadersForProvider } from './inbound-headers.ts';
import { getRepo } from '../../repo/index.ts';
import { subscriptionAccountStatusForRecord } from '../providers/registry.ts';
import type { ModelCandidate, UpstreamCallOptions } from '@floway-dev/provider';

// See UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: GatewayCtx,
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: ctx.dump?.http.wrapFetcher(candidate.fetcher, candidate.provider.upstreamId) ?? candidate.fetcher,
  waitUntil: ctx.backgroundScheduler,
  headers: filterInboundHeadersForProvider(headers, candidate.provider),
  wrapUpstreamCall: async dispatch => {
    ctx.abortSignal?.throwIfAborted();
    if (ctx.attempt.conversation) {
      const current = await getRepo().upstreams.getById(candidate.provider.upstreamId);
      const status = current ? subscriptionAccountStatusForRecord(current) : null;
      const identity = status?.identity === null || status?.identity === undefined ? null : JSON.stringify([current?.kind, status.identity]);
      if (status?.health !== 'active' || identity !== ctx.attempt.conversation.claim.conversation.targetIdentity) {
        throw new Error('Subscription account changed before conversation dispatch; the original binding was retained');
      }
    }
    await ctx.attempt.conversation?.dispatched();
    return await stampUpstreamCallStart(ctx.attempt.timing)(dispatch);
  },
  ...(ctx.attempt.conversation ? { subscriptionSession: ctx.attempt.conversation.request.client } : {}),
});
