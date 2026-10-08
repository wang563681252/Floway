import { test } from 'vitest';

import { ratesForStoredSelector, resolveUsagePricing, type StoredUpstream } from '../../src/backfill-usage-pricing/pricing.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const upstream = (provider: string, config: unknown, modelsCache: unknown = null): StoredUpstream => ({
  id: `${provider}-1`,
  provider,
  configJson: JSON.stringify(config),
  modelsCacheJson: modelsCache === null ? null : JSON.stringify(modelsCache),
});

const manual = (upstreamModelId: string, pricing = basePricing({ input_tokens: '0.01' })) => ({
  kind: 'chat',
  endpoints: { openaiResponses: {} },
  upstreamModelId,
  pricing,
});

test('configured pricing and provider pricing resolve through their owning sources', () => {
  const azure = resolveUsagePricing(upstream('azure', { models: [manual('deployment')] }), { model: 'public', modelKey: 'deployment' });
  assertEquals(azure.status, 'priced');
  assertEquals(azure.status === 'priced' ? azure.pricing.entries[0]?.rates.input_tokens : null, '0.01');

  assertEquals(resolveUsagePricing(upstream('codex', {}), { model: 'gpt-5.4', modelKey: 'gpt-5.4' }).status, 'priced');
  assertEquals(resolveUsagePricing(upstream('claude-code', {}), { model: 'claude-sonnet-4-6', modelKey: 'claude-sonnet-4-6' }).status, 'priced');
  assertEquals(resolveUsagePricing(upstream('ollama', { models: [] }), { model: 'gpt-oss:120b', modelKey: 'gpt-oss:120b' }).status, 'priced');
});

test('Copilot backfill uses current catalog prices and matches raw variants through public aliases', () => {
  const now = Date.UTC(2026, 9, 4);
  const pricing = basePricing({ input_tokens: '0.000002', output_tokens: '0.00001' });
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: now,
    models: [{
      id: 'gpt-6.1-sol',
      providerData: { rawModels: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-sol-fast' }] },
      pricing,
    }],
  };
  for (const modelKey of ['gpt-6.1-sol', 'gpt-6.1-sol-fast']) {
    assertEquals(resolveUsagePricing(upstream('copilot', {}, cache), { model: 'operator-alias', modelKey }, now), {
      status: 'priced',
      pricing,
      source: 'upstream:copilot-1:models-cache',
      guardsModelsCache: true,
    });
  }
  assertEquals(resolveUsagePricing(upstream('copilot', {}, cache), { model: 'gpt-6.1-sol', modelKey: 'unknown' }, now).status, 'unavailable');
  assertEquals(resolveUsagePricing(upstream('copilot', {}, cache), { model: 'gpt-6.1-sol', modelKey: 'gpt-6.1-sol' }, now + 24 * 60 * 60 * 1000).status, 'unavailable');
  assertEquals(resolveUsagePricing(upstream('copilot', {}, { ...cache, revision: MODEL_CATALOG_REVISION - 1 }), { model: 'gpt-6.1-sol', modelKey: 'gpt-6.1-sol' }, now).status, 'unavailable');
  assertEquals(resolveUsagePricing(upstream('copilot', {}), { model: 'gpt-6.1-sol', modelKey: 'gpt-6.1-sol' }, now).status, 'unavailable');
});

test('Copilot backfill preserves explicit zero prices and leaves absent catalog prices unpriced', () => {
  const now = Date.UTC(2026, 9, 4);
  const free = basePricing({ input_tokens: '0', output_tokens: '0' });
  const cachedModel = { id: 'new-model', providerData: { rawModels: [{ id: 'new-model' }] } };
  const cache = { revision: MODEL_CATALOG_REVISION, fetchedAt: now, models: [{ ...cachedModel, pricing: free }] };
  const identity = { model: 'new-model', modelKey: 'new-model' };
  const resolved = resolveUsagePricing(upstream('copilot', {}, cache), identity, now);
  assertEquals(resolved.status === 'priced' ? resolved.pricing : null, free);
  assertEquals(resolveUsagePricing(upstream('copilot', {}, { ...cache, models: [cachedModel] }), identity, now), {
    status: 'unpriced',
    source: 'upstream:copilot-1:models-cache',
    guardsModelsCache: true,
  });
  assertThrows(() => resolveUsagePricing(upstream('copilot', {}, { ...cache, models: [cachedModel, cachedModel] }), identity, now));
});

test('custom fetched pricing requires a current catalog with matching model identity', () => {
  const pricing = basePricing({ input_tokens: '0.02' });
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.UTC(2026, 0, 1),
    models: [{ id: 'public', providerData: 'wire', pricing }],
  };
  const resolved = resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'priced');
  assertEquals(resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'different' },
    Date.UTC(2026, 0, 1, 1),
  ).status, 'unavailable');
  assertEquals(resolveUsagePricing(
    upstream('custom', { models: [] }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 3),
  ).status, 'unavailable');
});

test('custom disabled model fetching does not reuse cached pricing', () => {
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.UTC(2026, 0, 1),
    models: [{ id: 'public', providerData: 'wire', pricing: basePricing({ input_tokens: '0.02' }) }],
  };
  const resolved = resolveUsagePricing(
    upstream('custom', {
      modelsFetch: { enabled: false },
      models: [{ kind: 'chat', endpoints: { openaiResponses: {} }, upstreamModelId: 'wire' }],
    }, cache),
    { model: 'public', modelKey: 'wire' },
    Date.UTC(2026, 0, 1, 1),
  );
  assertEquals(resolved.status, 'unpriced');
});

test('selector lookup falls back to the whole Base vector without merging fields', () => {
  const pricing = basePricing({ input_tokens: '0.01' });
  assertEquals(ratesForStoredSelector(pricing, '{"serviceTier":"priority"}'), {
    exact: false,
    rates: { input_tokens: '0.01' },
  });
});
