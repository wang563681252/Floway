import { beforeEach, expect, test } from 'vitest';

import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/legacy.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../../src/repo/models-cache-contract.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { seedModelsCache, storedModelsRefreshIdentity } from '../../../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../../../repo/upstreams.ts';
import { buildCopilotUpstreamRecord } from '../../../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const repo = new InMemoryRepo();

beforeEach(async () => {
  initRepo(repo);
  await repo.upstreams.deleteAll();
});

const upstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up-a',
  kind: 'custom',
  name: 'Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: true },
    models: [],
  },
  state: null,
  ...overrides,
} as UpstreamRecord);

test('resolves v1 affinity from the current provider-model cache', async () => {
  const record = upstream();
  await saveUpstreamForTest(repo.upstreams, record);
  await seedModelsCache(repo.upstreams, record.id, await storedModelsRefreshIdentity(repo.upstreams, record.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({
      id: 'gpt-main',
      upstreamModelId: 'gpt-main-wire',
      opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
    })],
  });

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'gpt-main' }))
    .resolves.toEqual({ upstreamId: 'up-a', key: 'openai' });
});

test('resolves v1 affinity from manual configuration when the catalog is cold', async () => {
  await saveUpstreamForTest(repo.upstreams, upstream({
    config: {
      baseUrl: 'https://example.com',
      authStyle: 'bearer',
      endpoints: { openaiResponses: {} },
      ingressHeadersRules: [],
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'claude-wire',
        publicModelId: 'claude-public',
        kind: 'chat',
        endpoints: { openaiResponses: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'claude-opus' },
      }],
    },
  }));

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'up-a', modelId: 'claude-public' }))
    .resolves.toEqual({ key: 'claude-opus' });
});

test('resolves a legacy Copilot fast id through its current merged family without changing upstream ownership', async () => {
  const record = buildCopilotUpstreamRecord({
    token: 'test-token',
    user: { login: 'test-user', avatar_url: '', name: null, id: 1 },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  await seedModelsCache(repo.upstreams, record.id, await storedModelsRefreshIdentity(repo.upstreams, record.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
      providerData: {
        rawModels: [
          { id: 'gpt-5.6-sol', supported_endpoints: ['/responses'] },
          { id: 'gpt-5.6-sol-fast', supported_endpoints: ['/responses'] },
        ],
      },
    })],
  });

  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: record.id, modelId: 'gpt-5.6-sol-fast' }))
    .resolves.toEqual({ upstreamId: record.id, key: 'openai' });
  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: record.id, modelId: 'gpt-5.6-luna-fast' }))
    .resolves.toBeUndefined();
  await expect(resolveLegacyOpaqueBlobCompatibilityIdentity({ upstreamId: 'another-upstream', modelId: 'gpt-5.6-sol-fast' }))
    .resolves.toBeUndefined();
});
