import { HTTPException } from 'hono/http-exception';

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

export const saveUpstream = async (change: UpstreamChange): Promise<StoredUpstreamRecord> => {
  const { next } = change;
  const upstreams = getRepo().upstreams;
  const pools = await getRepo().subscriptionPools.list();
  if (pools.some(pool => pool.upstreamIds.includes(next.id))) {
    const prospective = [...(await upstreams.list()).filter(record => record.id !== next.id), next];
    const invalid = await validateSubscriptionPoolMembers(pools, prospective);
    if (invalid) throw new HTTPException(409, { message: invalid });
  }
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
  for (const change of changes) await persistUpstream(change);
};
