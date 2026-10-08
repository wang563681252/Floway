import type { Context } from 'hono';

import { subscriptionAccountStatusForRecord } from '../../data-plane/providers/registry.ts';
import type { CtxWithJson, CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { SubscriptionConversation } from '../../repo/subscription-conversations.ts';
import type { subscriptionConversationActionBody, subscriptionConversationQuery } from '../schemas.ts';

const conversationToJson = (conversation: SubscriptionConversation) => ({
  id: conversation.id, api_key_id: conversation.apiKeyId, upstream_id: conversation.upstreamId,
  version: conversation.version, phase: conversation.phase, last_seen_at: conversation.lastSeenAt,
  context_items: conversation.contextLength, portable: conversation.portable,
  blocked_reason: conversation.blockedReason, target_upstream_id: conversation.targetUpstreamId,
  migrations: conversation.migrations, migration_requested: conversation.migrationRequested,
});

const findConversation = async (c: Context) => {
  const conversation = await getRepo().subscriptionConversations.get(c.req.param('conversationId') ?? '');
  return conversation?.poolId === c.req.param('id') ? conversation : null;
};

export const listSubscriptionConversations = async (c: CtxWithQuery<typeof subscriptionConversationQuery>) => {
  const poolId = c.req.param('id') ?? '';
  const repo = getRepo();
  if (!await repo.subscriptionPools.get(poolId)) return c.json({ error: 'Subscription pool not found' }, 404);
  const conversations = await repo.subscriptionConversations.list(poolId);
  const offset = Number(c.req.valid('query').offset);
  if (!Number.isSafeInteger(offset)) return c.json({ error: 'Conversation offset is too large' }, 400);
  return c.json({ conversations: conversations.slice(offset, offset + 100).map(conversationToJson), total: conversations.length, offset, page_size: 100 });
};

const inspect = async (conversation: SubscriptionConversation) => {
  const repo = getRepo();
  const pool = await repo.subscriptionPools.get(conversation.poolId);
  if (!pool) throw new Error('Conversation references a missing subscription pool');
  const key = await repo.apiKeys.getById(conversation.apiKeyId);
  const user = key ? await repo.users.getById(key.userId) : null;
  const blockers: string[] = [];
  if (!key || !user) blockers.push('conversation_key_revoked');
  if (conversation.phase === 'closed') blockers.push('conversation_closed');
  if (conversation.phase === 'uncertain') blockers.push('execution_uncertain');
  if (conversation.phase === 'preparing' || conversation.phase === 'dispatched') blockers.push('conversation_busy');
  if (!conversation.portable) blockers.push('opaque_context');
  if (conversation.contextHash === null || conversation.modelKey === null) blockers.push('history_unavailable');
  const now = Date.now();
  const runtime = await repo.subscriptionPools.runtime(pool.id, now);
  const destinations: string[] = [];
  for (const id of pool.upstreamIds) {
    if (key?.upstreamIds !== null && !key?.upstreamIds.includes(id)) continue;
    if (user?.upstreamIds !== null && !user?.upstreamIds.includes(id)) continue;
    const upstream = await repo.upstreams.getById(id);
    if (!upstream) throw new Error('Subscription pool member disappeared during conversation inspection');
    const status = subscriptionAccountStatusForRecord(upstream);
    if (!status) throw new Error('Subscription pool member has no account status contract');
    if (!upstream.enabled || status.health !== 'active' || status.identity === null
      || JSON.stringify([upstream.kind, status.identity]) === conversation.accountIdentity
      || runtime.find(account => account.upstreamId === id)?.acceptNewSessions === false) continue;
    const fresh = status.observedAt !== null && status.observedAt <= now && now - status.observedAt <= 5 * 60_000;
    if (fresh && status.unavailableUntil !== null && status.unavailableUntil > now) continue;
    const account = runtime.find(item => item.upstreamId === id);
    if (account?.cooldowns.some(cooldown => cooldown.modelKey === conversation.modelKey)
      || pool.maxConcurrentRequests !== null && (account?.inFlight ?? 0) >= pool.maxConcurrentRequests) continue;
    destinations.push(id);
  }
  if (destinations.length === 0) blockers.push('no_session_account');
  const leaseActive = conversation.leaseToken !== null && await repo.subscriptionPools.isLeaseActive(conversation.leaseToken, now);
  return {
    conversation: conversationToJson(conversation), blockers, eligible_upstream_ids: destinations,
    requires_full_context: true as const, can_request_migration: blockers.length === 0,
    can_close: !leaseActive && ['active', 'blocked', 'uncertain'].includes(conversation.phase),
    requires_uncertain_acknowledgement: conversation.phase === 'uncertain',
    history: await repo.subscriptionConversations.history(conversation.id),
  };
};

export const checkSubscriptionConversation = async (c: Context) => {
  const conversation = await findConversation(c);
  if (!conversation) return c.json({ error: 'Subscription conversation not found' }, 404);
  return c.json(await inspect(conversation));
};

export const actOnSubscriptionConversation = async (c: CtxWithJson<typeof subscriptionConversationActionBody>) => {
  const conversation = await findConversation(c);
  if (!conversation) return c.json({ error: 'Subscription conversation not found' }, 404);
  const body = c.req.valid('json');
  if (conversation.version !== body.expected_version) return c.json({ error: 'Conversation changed concurrently; refresh before acting' }, 409);
  const repo = getRepo().subscriptionConversations;
  let changed: boolean;
  if (body.action === 'request-migration') {
    const check = await inspect(conversation);
    if (!check.can_request_migration) return c.json({ error: 'Safe migration precheck rejected; the original binding was retained', blockers: check.blockers }, 409);
    changed = await repo.requestMigration(conversation.id, body.expected_version);
  } else if (body.action === 'cancel-migration') {
    changed = await repo.cancelMigration(conversation.id, body.expected_version);
  } else {
    if (conversation.phase === 'uncertain' && !body.acknowledge_uncertain) {
      return c.json({ error: 'Confirm the upstream has stopped before closing an uncertain branch; no request will be replayed' }, 409);
    }
    changed = await repo.close(conversation.id, body.expected_version, body.acknowledge_uncertain);
  }
  if (!changed) return c.json({ error: 'Conversation is busy or changed concurrently; no binding was overwritten' }, 409);
  return c.body(null, 204);
};
