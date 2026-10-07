import { expect, test } from 'vitest';

import { mergeCopilotVariants } from '../src/merge-variants.ts';
import { copilotVariantIndex } from '../src/model-variants.ts';
import { pricingForCopilotModel } from '../src/pricing.ts';
import type { CopilotRawModel } from '../src/types.ts';
import { billableServiceTier, perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';

const billing = (
  base: Record<string, unknown>,
  long?: Record<string, unknown>,
  batchSize = 1_000_000,
) => ({
  token_prices: {
    batch_size: batchSize,
    default: base,
    ...(long === undefined ? {} : { long_context: long }),
  },
});

// Sanitized authenticated Copilot /models observation, 2026-10-04.
// Units: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
const sol: CopilotRawModel = {
  id: 'gpt-6.1-sol',
  billing: billing(
    { input_price: 200, cache_price: 10, cache_write_price: 250, output_price: 1000, context_max: 272000 },
    { input_price: 400, cache_price: 20, cache_write_price: 500, output_price: 1500, context_max: 922000 },
  ),
};

const projection = (models: CopilotRawModel[], publicId = models[0].id) => {
  const index = copilotVariantIndex(models);
  const model = mergeCopilotVariants(index).find(candidate => candidate.id === publicId);
  const variants = index.families.get(publicId);
  if (!model || !variants) throw new Error(`Missing test family ${publicId}`);
  return pricingForCopilotModel(model, variants, index);
};

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('new Copilot models are priced directly from credits without a model-name rule', () => {
  const pricing = projection([{ ...sol, id: 'future-model-with-no-manual-rate-card' }]);
  expect(priceRequest(pricing, {}).rates).toEqual(published({
    input_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '2.5', output_tokens: '10',
  }));
  expect(priceRequest(pricing, {}).rates?.input_tokens).toBe('0.000002');
  expect(priceRequest(pricing, {}).rates?.input_cache_read_tokens).toBe('0.0000001');
});

test('Copilot long-context prices start above the default band rather than the long band or capability cap', () => {
  const pricing = projection([{
    ...sol,
    capabilities: { limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 922000 } },
  }]);
  const base = published({ input_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '2.5', output_tokens: '10' });
  const long = published({ input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', output_tokens: '15' });
  for (const inputTokens of [0, 271999, 272000]) expect(priceRequest(pricing, { inputTokens }).rates).toEqual(base);
  for (const inputTokens of [272001, 500000, 922000]) expect(priceRequest(pricing, { inputTokens }).rates).toEqual(long);
  expect(priceRequest(pricing, { inputTokens: 272001 }).selector).toEqual({ inputTokens: { operator: 'gt', value: 272000 } });
  expect(priceRequest(pricing, { serviceTier: billableServiceTier('default'), inputTokens: 272001 }).rates).toEqual(long);
  expect(priceRequest(pricing, { serviceTier: 'unpublished-tier', inputTokens: 272001 }).rates).toEqual(base);
});

test('Copilot Astra retains all four published metrics and its exact long-context boundary', () => {
  const pricing = projection([{
    id: 'gpt-6-astra',
    billing: billing(
      { input_price: 1000, cache_price: 100, cache_write_price: 1250, output_price: 5000, context_max: 272000 },
      { input_price: 2000, cache_price: 200, cache_write_price: 2500, output_price: 7500, context_max: 1050000 },
    ),
  }]);
  expect(priceRequest(pricing, { inputTokens: 272000 }).rates).toEqual(published({
    input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50',
  }));
  expect(priceRequest(pricing, { inputTokens: 272001 }).rates).toEqual(published({
    input_tokens: '20', input_cache_read_tokens: '2', input_cache_write_tokens: '25', output_tokens: '75',
  }));
});

test('Copilot accelerated variants contribute their own short and long priority entries independent of catalog order', () => {
  const base: CopilotRawModel = {
    id: 'gpt-5.6-sol',
    billing: billing(
      { input_price: 400, cache_price: 40, cache_write_price: 500, output_price: 2000, context_max: 272000 },
      { input_price: 800, cache_price: 80, cache_write_price: 1000, output_price: 3000, context_max: 922000 },
    ),
  };
  const fast: CopilotRawModel = {
    id: 'gpt-5.6-sol-fast',
    billing: billing(
      { input_price: 800, cache_price: 80, cache_write_price: 1000, output_price: 4000, context_max: 272000 },
      { input_price: 1600, cache_price: 160, cache_write_price: 2000, output_price: 6000, context_max: 922000 },
    ),
  };
  for (const models of [[base, fast], [fast, base]]) {
    const pricing = projection(models, base.id);
    expect(pricing?.entries).toHaveLength(4);
    expect(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272000 }).rates).toEqual(published({
      input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '40',
    }));
    expect(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272001 }).rates).toEqual(published({
      input_tokens: '16', input_cache_read_tokens: '1.6', input_cache_write_tokens: '20', output_tokens: '60',
    }));
    expect(priceRequest(pricing, {}).rates?.input_tokens).toBe('0.000004');
  }
});

test('Claude dated, reasoning and long-context variants share their published family prices with a distinct fast tier', () => {
  const base = billing({ input_price: 500, cache_price: 50, cache_write_price: 625, output_price: 2500 });
  const fast = billing({ input_price: 1000, cache_price: 100, cache_write_price: 1250, output_price: 5000 });
  const pricing = projection([
    { id: 'claude-opus-4.8-20260901', billing: base },
    { id: 'claude-opus-4.8-high', billing: base },
    { id: 'claude-opus-4.8-xhigh', billing: base },
    { id: 'claude-opus-4.8-1m', billing: base },
    { id: 'claude-opus-4.8-fast', billing: fast },
  ], 'claude-opus-4-8');
  expect(pricing?.entries).toHaveLength(2);
  expect(priceRequest(pricing, {}).rates?.input_tokens).toBe('0.000005');
  expect(priceRequest(pricing, { serviceTier: 'fast' }).rates?.input_tokens).toBe('0.00001');
  expect(priceRequest(pricing, { serviceTier: 'priority' }).rates?.input_tokens).toBe('0.000005');
});

test('a standalone model named fast is not mistaken for an accelerated variant', () => {
  const pricing = projection([{ id: 'grok-code-fast', billing: billing({ input_price: 20, output_price: 150 }) }]);
  expect(pricing?.entries).toHaveLength(1);
  expect(priceRequest(pricing, {}).rates).toEqual(published({ input_tokens: '0.2', output_tokens: '1.5' }));
});

test('Copilot explicit zero rates remain free even when the upstream uses a zero batch denominator', () => {
  const free = billing({ input_price: 0, cache_price: 0, cache_write_price: 0, output_price: 0 }, undefined, 0);
  for (const id of ['gpt-4.1', 'trajectory-compaction', 'text-embedding-3-small']) {
    expect(priceRequest(projection([{ id, billing: free }]), {}).rates).toEqual({
      input_tokens: '0', input_cache_read_tokens: '0', input_cache_write_tokens: '0', output_tokens: '0',
    });
  }
});

test('missing prices are unpriced rather than free, static-table values or another variant price', () => {
  expect(projection([{ id: 'gpt-5.4' }])).toBeNull();
  expect(projection([{ id: 'unpriced', billing: { restricted_to: ['pro'] } }])).toBeNull();
  expect(projection([{ ...sol }, { id: 'gpt-6.1-sol-fast' }])).toBeNull();
  const pricing = projection([{ id: 'partial', billing: billing({ input_price: 1, output_price: 2 }) }]);
  expect(priceRequest(pricing, {}).rates).toEqual({ input_tokens: '0.00000001', output_tokens: '0.00000002' });
  expect(priceRequest(pricing, {}).rates?.input_cache_read_tokens).toBeUndefined();
});

test('Copilot pricing uses the actual batch denominator and canonical decimal arithmetic', () => {
  const pricing = projection([{
    id: 'decimal-pricing',
    billing: billing({ input_price: '12.5', cache_read_price: '0.125', output_price: '1e-7' }, undefined, 1000),
  }]);
  expect(priceRequest(pricing, {}).rates).toEqual({
    input_tokens: '0.000125', input_cache_read_tokens: '0.00000125', output_tokens: '0.000000000001',
  });
  const legacy = projection([{ id: 'legacy-batch', billing: { token_prices: { default: { input_price: 100 } } } }]);
  expect(priceRequest(legacy, {}).rates).toEqual({ input_tokens: '0.000001' });
});

test('an upstream price change immediately changes the next catalog projection', () => {
  expect(priceRequest(projection([sol]), {}).rates?.input_tokens).toBe('0.000002');
  const changed = { ...sol, billing: billing({ input_price: 300, output_price: 1200 }) };
  expect(priceRequest(projection([changed]), {}).rates?.input_tokens).toBe('0.000003');
});

test.each([
  null,
  [],
  { token_prices: null },
  { token_prices: { batch_size: -1, default: { input_price: 1 } } },
  { token_prices: { batch_size: 0.5, default: { input_price: 1 } } },
  { token_prices: { batch_size: '1000000', default: { input_price: 1 } } },
  { token_prices: { batch_size: Number.POSITIVE_INFINITY, default: { input_price: 1 } } },
  { token_prices: { batch_size: Number.MAX_SAFE_INTEGER + 1, default: { input_price: 1 } } },
  { token_prices: { batch_size: 0, default: { input_price: 1 } } },
  { token_prices: { default: {} } },
  { token_prices: { default: { input_price: -1 } } },
  { token_prices: { default: { input_price: null } } },
  { token_prices: { default: { input_price: true } } },
  { token_prices: { default: { input_price: Number.NaN } } },
  { token_prices: { default: { input_price: 'not-a-price' } } },
  { token_prices: { default: { input_price: 1, cache_price: 1, cache_read_price: 2 } } },
  { token_prices: { default: { input_price: 1 }, long_context: { input_price: 2 } } },
  { token_prices: { default: { input_price: 1, context_max: 0 }, long_context: { input_price: 2 } } },
  { token_prices: { default: { input_price: 1, context_max: 2.5 }, long_context: { input_price: 2 } } },
  { token_prices: { default: { input_price: 1, context_max: 100 }, long_context: { output_price: 2 } } },
])('malformed Copilot pricing fails explicitly instead of becoming a guessed price (%#)', value => {
  expect(() => projection([{ id: 'invalid-price', billing: value }])).toThrow();
});

test('conflicting prices on merged reasoning variants cannot silently overwrite the base price', () => {
  expect(() => projection([
    { id: 'claude-opus-4.8', billing: billing({ input_price: 500, output_price: 2500 }) },
    { id: 'claude-opus-4.8-high', billing: billing({ input_price: 1000, output_price: 2500 }) },
  ], 'claude-opus-4-8')).toThrow('conflicting variant prices');
});
