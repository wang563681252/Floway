import type { InferResponseType } from 'hono/client';

import type { api } from '../../api/client';

export type SubscriptionPoolView = InferResponseType<(typeof api.api)['subscription-pools']['$get'], 200>[number];
export type PoolUpstreamOption = InferResponseType<(typeof api.api)['upstream-options']['$get'], 200>[number];

export const poolConcurrencyValue = (unlimited: boolean, value: string): number | null => {
  if (unlimited) return null;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Subscription pool concurrency must be a positive integer');
  return parsed;
};
