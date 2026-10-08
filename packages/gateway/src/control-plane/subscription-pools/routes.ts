import type { Context } from 'hono';

import { validateSubscriptionPoolMembers } from './validation.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { SubscriptionPoolConflictError, type SubscriptionPool } from '../../repo/subscription-pools.ts';
import { shortId } from '../../shared/short-id.ts';
import type { subscriptionPoolBody, subscriptionPoolMemberBody } from '../schemas.ts';

export const subscriptionPoolToJson = (pool: SubscriptionPool) => ({
  id: pool.id, name: pool.name, provider: pool.provider, enabled: pool.enabled,
  max_concurrent_requests: pool.maxConcurrentRequests, upstream_ids: pool.upstreamIds, created_at: pool.createdAt,
});

export const listSubscriptionPools = async (c: Context) => {
  const repo = getRepo();
  const pools = await repo.subscriptionPools.list();
  const now = Date.now();
  const result = await Promise.all(pools.map(async pool => {
    const runtime = await repo.subscriptionPools.runtime(pool.id, now);
    const conversations = await repo.subscriptionConversations.list(pool.id);
    const accounts = await Promise.all(pool.upstreamIds.map(async id => {
      const upstream = await repo.upstreams.getById(id);
      if (upstream === null) throw new Error('Subscription pool member disappeared while reading status');
      const provider = createProvider(upstream);
      if (!provider.getSubscriptionAccountStatus) throw new Error('Subscription pool member changed provider');
      const status = await provider.getSubscriptionAccountStatus();
      const fresh = status.observedAt !== null && status.observedAt <= now && now - status.observedAt <= 5 * 60_000;
      const active = runtime.find(item => item.upstreamId === id);
      if (!active) throw new Error('Subscription pool membership changed while reading account status');
      return {
        upstream_id: id, name: upstream.name, enabled: upstream.enabled,
        health: status.health, in_flight: active?.inFlight ?? 0, selections: active?.selections ?? 0,
        utilization: fresh ? status.utilization : null, quota_observed_at: status.observedAt,
        quota_fresh: fresh, unavailable_until: fresh ? status.unavailableUntil : null,
        cooldowns: active?.cooldowns ?? [],
        accept_new_sessions: active.acceptNewSessions,
        recent_sessions: conversations.filter(conversation =>
          conversation.accountIdentity === JSON.stringify([pool.provider, status.identity])
          && conversation.phase !== 'closed' && conversation.lastSeenAt >= now - 30 * 60_000).length,
      };
    }));
    return { ...subscriptionPoolToJson(pool), accounts };
  }));
  return c.json(result);
};

export const updateSubscriptionPoolMember = async (c: CtxWithJson<typeof subscriptionPoolMemberBody>) => {
  const repo = getRepo();
  const pool = await repo.subscriptionPools.get(c.req.param('id') ?? '');
  const upstreamId = c.req.param('upstreamId') ?? '';
  if (!pool?.upstreamIds.includes(upstreamId)) return c.json({ error: 'Subscription pool member not found' }, 404);
  if (!await repo.subscriptionPools.setAcceptNewSessions(upstreamId, c.req.valid('json').accept_new_sessions)) {
    return c.json({ error: 'Subscription pool member changed concurrently' }, 409);
  }
  return c.body(null, 204);
};

const save = async (c: CtxWithJson<typeof subscriptionPoolBody>, existing: SubscriptionPool | null) => {
  const body = c.req.valid('json');
  const pool: SubscriptionPool = {
    id: existing?.id ?? shortId('pool'), name: body.name, provider: body.provider,
    enabled: body.enabled, maxConcurrentRequests: body.max_concurrent_requests,
    upstreamIds: body.upstream_ids, createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const repo = getRepo();
  if (existing && pool.provider !== existing.provider) return c.json({ error: 'Subscription pool provider cannot be changed' }, 400);
  const candidates = [...(await repo.subscriptionPools.list()).filter(item => item.id !== pool.id), pool];
  const invalid = await validateSubscriptionPoolMembers(candidates);
  if (invalid) return c.json({ error: invalid }, 400);
  try {
    await repo.subscriptionPools.save(pool);
  } catch (error) {
    if (error instanceof SubscriptionPoolConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
  return c.json(subscriptionPoolToJson(pool), existing ? 200 : 201);
};

export const createSubscriptionPool = async (c: CtxWithJson<typeof subscriptionPoolBody>) => await save(c, null);

export const updateSubscriptionPool = async (c: CtxWithJson<typeof subscriptionPoolBody>) => {
  const pool = await getRepo().subscriptionPools.get(c.req.param('id') ?? '');
  if (!pool) return c.json({ error: 'Subscription pool not found' }, 404);
  return await save(c, pool);
};

export const deleteSubscriptionPool = async (c: Context) => {
  try {
    if (!await getRepo().subscriptionPools.delete(c.req.param('id') ?? '')) return c.json({ error: 'Subscription pool not found' }, 404);
  } catch (error) {
    if (error instanceof SubscriptionPoolConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
  return c.body(null, 204);
};

export const resetSubscriptionPoolCooldowns = async (c: Context) => {
  const pool = await getRepo().subscriptionPools.get(c.req.param('id') ?? '');
  if (!pool) return c.json({ error: 'Subscription pool not found' }, 404);
  for (const id of pool.upstreamIds) await getRepo().subscriptionPools.reset(id);
  return c.body(null, 204);
};
