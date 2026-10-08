import { subscriptionAccountStatusForRecord } from '../../data-plane/providers/registry.ts';
import { getRepo } from '../../repo/index.ts';
import type { SubscriptionPool } from '../../repo/subscription-pools.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export const validateSubscriptionPoolMembers = async (pools: readonly SubscriptionPool[], supplied?: readonly UpstreamRecord[]): Promise<string | null> => {
  const upstreams = supplied ?? await getRepo().upstreams.list();
  const upstreamOwners = new Set<string>();
  const identityOwners = new Set<string>();
  for (const pool of pools) {
    for (const id of pool.upstreamIds) {
      if (upstreamOwners.has(id)) return `Upstream ${id} already belongs to another subscription pool`;
      upstreamOwners.add(id);
      const upstream = upstreams.find(item => item.id === id);
      if (!upstream || upstream.kind !== pool.provider) return `Pool ${pool.name} must contain existing ${pool.provider} upstreams only`;
      const status = subscriptionAccountStatusForRecord(upstream);
      if (!status) throw new Error('Subscription provider has no account status contract');
      if (status.identity === null) return `Account identity for ${upstream.name} is unavailable; re-import credentials before pooling it`;
      const identity = JSON.stringify([pool.provider, status.identity]);
      if (identityOwners.has(identity)) return `The same subscription account is imported by multiple pool upstreams (${id})`;
      identityOwners.add(identity);
    }
  }
  return null;
};
