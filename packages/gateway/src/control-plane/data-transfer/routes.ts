// Data transfer routes — export/import operator-managed database data as JSON.
//
// Ephemeral stored OpenAI Responses state is omitted from exports and cleared on
// replace imports; clients can regenerate it through normal OpenAI Responses use.
//
// The export contains all persisted authentication material, including raw API
// keys and server secrets, user password hashes, provider tokens, and
// credential-bearing proxy URIs. The endpoint is admin-only; handle the file
// with the same care as a DB backup.

import { parseImportData, type SerializedProxy } from './import-schema.ts';
import { parseWebSearchConfigDefault, parseWebSearchConfigStrict } from '../../data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_FALLBACK_IDS } from '../../repo/proxy-fallback-list.ts';
import type { SubscriptionConversationBackup } from '../../repo/subscription-conversations.ts';
import type { SubscriptionPool } from '../../repo/subscription-pools.ts';
import type { ApiKey, PerformanceTelemetryRecord, UsageRecord, User, WebSearchUsageRecord } from '../../repo/types.ts';
import { type exportQuery, type importBody } from '../schemas.ts';
import { saveUpstreams } from '../shared/save-upstreams.ts';
import { validateSubscriptionPoolMembers } from '../subscription-pools/validation.ts';
import { type FullSerializedUpstreamRecord, upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

interface ExportPayload {
  version: 22;
  exportedAt: string;
  data: {
    subscriptionPools: SubscriptionPool[];
    subscriptionConversations: SubscriptionConversationBackup[];
    subscriptionPoolIntake: Array<{ upstreamId: string; acceptNewSessions: boolean }>;
    users: User[];
    apiKeys: ApiKey[];
    upstreams: FullSerializedUpstreamRecord[];
    proxies: SerializedProxy[];
    usage: UsageRecord[];
    searchUsage: WebSearchUsageRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded: boolean;
    searchConfig: WebSearchConfig;
  };
}

const EXPORT_VERSION = 22;

const validateApiKeyIdentities = (records: readonly ApiKey[], existing: readonly ApiKey[], mode: 'merge' | 'replace'): string | null => {
  const ids = new Map<string, number>();
  const rawKeys = new Map<string, string>();
  const serverSecrets = new Map<string, string>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const existingIdIndex = ids.get(record.id);
    if (existingIdIndex !== undefined) return `duplicate apiKeys id ${record.id} at indexes ${existingIdIndex} and ${i}`;
    ids.set(record.id, i);

    const existingRawKeyId = rawKeys.get(record.key);
    if (existingRawKeyId !== undefined) return `duplicate apiKeys raw key used by ${existingRawKeyId} and ${record.id}`;
    rawKeys.set(record.key, record.id);

    const existingServerSecretId = serverSecrets.get(record.serverSecret);
    if (existingServerSecretId !== undefined) return `duplicate apiKeys server secret used by ${existingServerSecretId} and ${record.id}`;
    serverSecrets.set(record.serverSecret, record.id);
  }

  if (mode === 'merge') {
    const existingRawKeys = new Map(existing.map(record => [record.key, record.id]));
    const existingServerSecrets = new Map(existing.map(record => [record.serverSecret, record.id]));
    for (const record of records) {
      const existingId = existingRawKeys.get(record.key);
      if (existingId !== undefined && existingId !== record.id) {
        return `apiKeys raw key for ${record.id} conflicts with existing api key ${existingId}`;
      }
      const existingServerSecretId = existingServerSecrets.get(record.serverSecret);
      if (existingServerSecretId !== undefined && existingServerSecretId !== record.id) {
        return `apiKeys server secret for ${record.id} conflicts with existing api key ${existingServerSecretId}`;
      }
    }
  }

  return null;
};

// Every fallback must resolve in the post-import catalog. Merge mode may refer
// to an existing local proxy; replace mode may only refer to imported proxies
// and the built-in direct transports because it clears the proxy repository.
const validateProxyFallbackReferences = (
  upstreams: readonly UpstreamRecord[],
  proxies: readonly SerializedProxy[],
  existingProxyIds: readonly string[],
): string | null => {
  const knownIds = new Set<string>(proxies.map(proxy => proxy.id));
  for (const id of existingProxyIds) knownIds.add(id);
  for (const id of DIRECT_FALLBACK_IDS) knownIds.add(id);
  for (const upstream of upstreams) {
    for (const ref of upstream.proxyFallbackList) {
      if (!knownIds.has(ref.id)) return `upstream ${upstream.id} references unknown proxy ${ref.id}`;
    }
  }
  return null;
};

export const exportData = async (c: CtxWithQuery<typeof exportQuery>) => {
  const repo = getRepo();
  const includePerformance = c.req.valid('query').include_performance === '1';

  const [users, apiKeys, usage, webSearchUsage, performance, rawWebSearchConfig, upstreams, proxies] = await Promise.all([
    repo.users.listIncludingDeleted(),
    repo.apiKeys.listIncludingDeleted(),
    repo.usage.listAll(),
    repo.webSearchUsage.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.webSearchConfig.get(),
    repo.upstreams.list(),
    repo.proxies.list(),
  ]);

  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      users,
      subscriptionPools: await repo.subscriptionPools.list(),
      subscriptionConversations: [],
      subscriptionPoolIntake: [],
      apiKeys,
      upstreams: upstreams.map(upstreamRecordToFullJson),
      proxies: proxies.map(proxy => ({ id: proxy.id, name: proxy.name, url: proxy.url, dial_timeout_seconds: proxy.dialTimeoutSeconds })),
      usage,
      searchUsage: webSearchUsage,
      performanceIncluded: includePerformance,
      searchConfig: rawWebSearchConfig === null ? parseWebSearchConfigDefault() : parseWebSearchConfigStrict(rawWebSearchConfig),
    },
  };
  for (const pool of payload.data.subscriptionPools) {
    payload.data.subscriptionConversations.push(...await repo.subscriptionConversations.backup(pool.id));
    payload.data.subscriptionPoolIntake.push(...(await repo.subscriptionPools.runtime(pool.id, Date.now())).map(member =>
      ({ upstreamId: member.upstreamId, acceptNewSessions: member.acceptNewSessions })));
  }
  if (includePerformance) payload.data.performance = performance;

  return c.json(payload);
};

export const importData = async (c: CtxWithJson<typeof importBody>) => {
  const { mode, version, data: rawData } = c.req.valid('json');
  if (version >= 21 && (rawData === null || typeof rawData !== 'object' || !Object.hasOwn(rawData, 'subscriptionPools'))) {
    return c.json({ error: `version ${version} requires subscriptionPools configuration` }, 400);
  }
  if (version === 22 && (rawData === null || typeof rawData !== 'object'
    || !Object.hasOwn(rawData, 'subscriptionConversations') || !Object.hasOwn(rawData, 'subscriptionPoolIntake'))) {
    return c.json({ error: 'version 22 requires subscriptionConversations and subscriptionPoolIntake metadata' }, 400);
  }
  const parsed = parseImportData(rawData);
  if (parsed.type === 'invalid') return c.json({ error: parsed.error }, 400);
  const { users, apiKeys, upstreams, proxies, usage, searchUsage, performance, performanceIncluded, searchConfig, subscriptionPools, subscriptionConversations, subscriptionPoolIntake } = parsed.data;

  const repo = getRepo();
  const existingPools = mode === 'merge' ? await repo.subscriptionPools.list() : [];
  const incomingPoolIds = new Set(subscriptionPools.map(pool => pool.id));
  const prospectivePools = [...existingPools.filter(pool => !incomingPoolIds.has(pool.id)), ...subscriptionPools];
  const incomingIds = new Set(upstreams.map(upstream => upstream.id));
  const prospectiveUpstreams = mode === 'merge'
    ? [...(await repo.upstreams.list()).filter(upstream => !incomingIds.has(upstream.id)), ...upstreams]
    : upstreams;
  const prospectiveKeys = mode === 'merge'
    ? [...(await repo.apiKeys.listIncludingDeleted()).filter(key => !apiKeys.some(incoming => incoming.id === key.id)), ...apiKeys]
    : apiKeys;
  for (const snapshot of subscriptionConversations) {
    if (!prospectivePools.some(pool => pool.id === snapshot.conversation.poolId)
      || !prospectiveKeys.some(key => key.id === snapshot.conversation.apiKeyId)) {
      return c.json({ error: 'Conversation metadata references an unknown pool or API key' }, 400);
    }
  }
  if (subscriptionPoolIntake.some(member => !prospectivePools.some(pool => pool.upstreamIds.includes(member.upstreamId)))) {
    return c.json({ error: 'Subscription intake metadata references an unknown pool member' }, 400);
  }
  const currentPools = await repo.subscriptionPools.list();
  if (mode === 'replace' && currentPools.length > 0) {
    for (const pool of currentPools) {
      if ((await repo.subscriptionPools.runtime(pool.id, Date.now())).some(account => account.inFlight > 0)) {
        return c.json({ error: 'Drain active subscription requests before a replace import; live ownership cannot be erased' }, 409);
      }
      const existing = await repo.subscriptionConversations.list(pool.id);
      if (existing.some(conversation => ['preparing', 'dispatched'].includes(conversation.phase)
        || conversation.phase === 'uncertain' && conversation.requestToken !== null)) {
        return c.json({ error: 'Drain active conversation turns before a replace import; dispatched ownership cannot be erased' }, 409);
      }
      if (existing.some(conversation => conversation.phase !== 'closed'
        && !subscriptionConversations.some(snapshot => snapshot.conversation.id === conversation.id))) {
        return c.json({ error: 'Replace import cannot discard open conversation bindings; include their metadata or safely close the branches first' }, 409);
      }
    }
  }
  const poolError = await validateSubscriptionPoolMembers(prospectivePools, prospectiveUpstreams);
  if (poolError) return c.json({ error: `invalid subscriptionPools: ${poolError}` }, 400);
  for (const pool of subscriptionPools) {
    const existing = existingPools.find(item => item.id === pool.id);
    if (!existing) continue;
    if (existing.provider !== pool.provider) return c.json({ error: 'Subscription pool provider cannot be changed' }, 400);
    const removed = existing.upstreamIds.filter(id => !pool.upstreamIds.includes(id));
    if (removed.length > 0 && (await repo.subscriptionPools.runtime(pool.id, Date.now())).some(account => removed.includes(account.upstreamId) && account.inFlight > 0)) {
      return c.json({ error: 'Subscription pool has active requests' }, 409);
    }
  }
  // Merge mode needs each key's prior dump policy to identify transitions that
  // must disconnect live subscribers after the replacement row is stored.
  const preImportKeys = await repo.apiKeys.listIncludingDeleted();
  const apiKeyIdentityError = validateApiKeyIdentities(apiKeys, mode === 'merge' ? preImportKeys : [], mode);
  if (apiKeyIdentityError) return c.json({ error: `invalid apiKeys: ${apiKeyIdentityError}` }, 400);
  if (mode === 'merge') {
    for (const key of apiKeys) {
      const previous = preImportKeys.find(item => item.id === key.id);
      if (!previous || previous.serverSecret === key.serverSecret) continue;
      for (const pool of currentPools) {
        if ((await repo.subscriptionConversations.list(pool.id)).some(conversation => conversation.apiKeyId === key.id && conversation.phase !== 'closed')) {
          return c.json({ error: 'API-key context secret cannot change while durable conversations are open' }, 409);
        }
      }
    }
  }
  const preImportRetentionById = new Map<string, number | null>(preImportKeys.map(key => [key.id, key.dumpRetentionSeconds]));

  const existingProxyIdsForRefs = mode === 'merge' ? (await repo.proxies.list()).map(proxy => proxy.id) : [];
  const fallbackRefError = validateProxyFallbackReferences(upstreams, proxies, existingProxyIdsForRefs);
  if (fallbackRefError) return c.json({ error: `invalid upstreams: ${fallbackRefError}` }, 400);

  if (mode === 'replace') {
    await repo.subscriptionPools.deleteAll();
    for (const key of preImportKeys) await notifyDisabledBestEffort(key.id, 'replace-mode import');

    // D1 does not expose a transaction spanning these repositories. Complete
    // validation therefore happens before this delete wave; a storage failure
    // after it begins can still leave a partially restored deployment.
    const deletes: Promise<unknown>[] = [
      repo.sessions.deleteAll(),
      repo.apiKeys.deleteAll(),
      repo.usage.deleteAll(),
      repo.webSearchUsage.deleteAll(),
      repo.upstreams.deleteAll(),
      repo.proxies.deleteAll(),
      repo.proxyBackoffs.deleteAll(),
      repo.openaiResponsesSnapshots.deleteAll(),
      repo.openaiResponsesItems.deleteAll(),
      repo.users.deleteAll(),
    ];
    if (performanceIncluded) deletes.push(repo.performance.deleteAll());
    await Promise.all(deletes);
  }

  // Users precede their API keys, and proxies precede upstream fallback refs.
  for (const user of users) await repo.users.save(user);
  for (const proxy of proxies) {
    await repo.proxies.save({
      id: proxy.id,
      name: proxy.name,
      url: proxy.url,
      dialTimeoutSeconds: proxy.dial_timeout_seconds,
    });
  }
  for (const key of apiKeys) {
    const previous = preImportRetentionById.get(key.id) ?? null;
    await repo.apiKeys.save(key);
    if (mode === 'merge' && key.dumpRetentionSeconds === null && previous !== null) {
      await notifyDisabledBestEffort(key.id, 'merge-mode retention disable');
    }
  }
  for (const record of usage) await repo.usage.set(record);
  for (const record of searchUsage) await repo.webSearchUsage.set(record);
  await saveUpstreams(await Promise.all(upstreams.map(async next => ({
    previous: await repo.upstreams.getById(next.id),
    next,
  }))));
  for (const pool of subscriptionPools) await repo.subscriptionPools.save(pool);
  for (const member of subscriptionPoolIntake) {
    if (!await repo.subscriptionPools.setAcceptNewSessions(member.upstreamId, member.acceptNewSessions)) {
      throw new Error('Subscription pool intake member disappeared while restoring metadata');
    }
  }
  let restoredConversations = 0;
  for (const snapshot of subscriptionConversations) {
    if (await repo.subscriptionConversations.restore(snapshot)) restoredConversations++;
  }
  for (const record of performance) await repo.performance.set(record);
  await repo.webSearchConfig.save(searchConfig);

  return c.json({
    ok: true,
    imported: {
      users: users.length,
      apiKeys: apiKeys.length,
      upstreams: upstreams.length,
      subscriptionPools: subscriptionPools.length,
      ...(version >= 22 ? {
        subscriptionPoolIntake: subscriptionPoolIntake.length,
        subscriptionConversations: restoredConversations,
        subscriptionConversationsPreserved: subscriptionConversations.length - restoredConversations,
      } : {}),
      proxies: proxies.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      performance: performance.length,
    },
  });
};
