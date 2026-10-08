import { SubscriptionRequestLease } from './subscription-pool-lease.ts';
import { recordSubscriptionPoolOutcome, SubscriptionPoolSelection } from './subscription-pool-selection.ts';
import { getRepo } from '../../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { apiErrorToResponse, providerModelOf, type ModelCandidate, type ProviderCallResult } from '@floway-dev/provider';

export const callBoundSubscriptionAccount = async (
  candidate: ModelCandidate,
  context: { abortSignal?: AbortSignal; backgroundScheduler: BackgroundScheduler; quotaScope?: string },
  dispatch: (signal: AbortSignal | undefined) => Promise<ProviderCallResult>,
): Promise<ProviderCallResult> => {
  const selection = new SubscriptionPoolSelection([candidate], await getRepo().subscriptionPools.list(), { quotaScope: context.quotaScope });
  const selected = await selection.next(context);
  if (!selected) return { response: apiErrorToResponse(selection.unavailable()), modelKey: providerModelOf(candidate).upstreamModelId };
  if (!selected.lease) return await dispatch(context.abortSignal);
  const lease = new SubscriptionRequestLease(getRepo().subscriptionPools, selected.lease, context);
  let ownsBody = false;
  let failure: unknown;
  try {
    const result = await lease.execute(() => dispatch(lease.signal));
    await recordSubscriptionPoolOutcome(candidate, result.response.status, result.response.headers, context.quotaScope);
    if (result.response.ok && result.response.body) {
      ownsBody = true;
      return { ...result, response: lease.wrapResponse(result.response) };
    }
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!ownsBody) {
      try {
        await lease.close();
      } catch (cleanupError) {
        if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Subscription subrequest and cleanup failed', { cause: failure });
        throw cleanupError;
      }
    }
  }
};
