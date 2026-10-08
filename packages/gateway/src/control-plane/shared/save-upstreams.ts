import { HTTPException } from 'hono/http-exception';

import { subscriptionAccountStatusForRecord } from '../../data-plane/providers/registry.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { validateSubscriptionPoolMembers } from '../subscription-pools/validation.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface UpstreamChange {
  previous: StoredUpstreamRecord | null;
  next: UpstreamRecord;
}

const persistUpstream = async ({ previous, next }: UpstreamChange): Promise<StoredUpstreamRecord> => {
  const upstreams = getRepo().upstreams;
  const saved = previous === null
    ? await upstreams.insertForModels(next)
    : await upstreams.replaceForModels({ previous, upstream: next });
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  return saved;
};

const requireIdleAccountReplacement = async (changes: readonly UpstreamChange[]): Promise<void> => {
  const repo = getRepo();
  for (const { previous, next } of changes) {
    if (!previous || subscriptionAccountStatusForRecord(previous)?.identity === subscriptionAccountStatusForRecord(next)?.identity) continue;
    const pool = (await repo.subscriptionPools.list()).find(item => item.upstreamIds.includes(next.id));
    if (pool && (await repo.subscriptionPools.runtime(pool.id, Date.now())).some(account => account.upstreamId === next.id && account.inFlight > 0)) {
      throw new HTTPException(409, { message: 'Subscription account identity cannot be replaced while requests are active' });
    }
  }
};

export const saveUpstream = async (change: UpstreamChange): Promise<StoredUpstreamRecord> => {
  const { next } = change;
  const upstreams = getRepo().upstreams;
  const pools = await getRepo().subscriptionPools.list();
  if (pools.some(pool => pool.upstreamIds.includes(next.id))) {
    const prospective = [...(await upstreams.list()).filter(record => record.id !== next.id), next];
    const invalid = await validateSubscriptionPoolMembers(pools, prospective);
    if (invalid) throw new HTTPException(409, { message: invalid });
  }
  await requireIdleAccountReplacement([change]);
  return await persistUpstream(change);
};

export const saveUpstreams = async (changes: readonly UpstreamChange[]): Promise<void> => {
  const pools = await getRepo().subscriptionPools.list();
  if (pools.length > 0) {
    const changedIds = new Set(changes.map(change => change.next.id));
    const prospective = [...(await getRepo().upstreams.list()).filter(record => !changedIds.has(record.id)), ...changes.map(change => change.next)];
    const invalid = await validateSubscriptionPoolMembers(pools, prospective);
    if (invalid) throw new HTTPException(409, { message: invalid });
  }
  await requireIdleAccountReplacement(changes);
  for (const change of changes) await persistUpstream(change);
};
