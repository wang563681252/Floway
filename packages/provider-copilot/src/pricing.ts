import type { CopilotVariantIndex } from './model-variants.ts';
import type { CopilotRawModel } from './types.ts';
import {
  BILLING_METRICS,
  canonicalPricingSelectorKey,
  decimalStringIsZero,
  divideDecimalString,
  modelPricing,
  multiplyDecimalStrings,
  parseNonNegativeDecimalString,
  pricingEntry,
  type BillingMetric,
  type ModelPricing,
  type PriceVector,
  type PricingEntry,
} from '@floway-dev/protocols/common';
import { isRecord } from '@floway-dev/provider';

// Copilot publishes AI credits, not USD. One credit is USD 0.01.
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
const USD_PER_AI_CREDIT = '0.01';

// The denominator belongs to token_prices. Older catalogs omit it.
// https://github.com/microsoft/vscode/blob/675354c07e19f3d7ff0b09d00bcc816dad233825/src/vs/platform/agentHost/common/meta/vscode/agentModelPricing.ts#L119
const DEFAULT_BATCH_SIZE = 1_000_000;

const RATE_FIELDS = [
  ['input_price', 'input_tokens'],
  ['cache_write_price', 'input_cache_write_tokens'],
  ['output_price', 'output_tokens'],
] as const satisfies readonly (readonly [string, BillingMetric])[];

const recordField = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
};

const creditPrice = (value: unknown, label: string): string => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite non-negative price`);
    return parseNonNegativeDecimalString(String(value), label);
  }
  return parseNonNegativeDecimalString(value, label);
};

const priceBand = (band: Record<string, unknown>, batchSize: number, label: string): PriceVector => {
  const prices: PriceVector = {};
  for (const [field, metric] of RATE_FIELDS) {
    if (band[field] !== undefined) prices[metric] = creditPrice(band[field], `${label}.${field}`);
  }
  const cachePrice = band.cache_read_price !== undefined ? band.cache_read_price : band.cache_price;
  if (cachePrice !== undefined) {
    prices.input_cache_read_tokens = creditPrice(cachePrice, `${label}.cache_read_price`);
  }
  if (band.cache_read_price !== undefined && band.cache_price !== undefined) {
    if (creditPrice(band.cache_price, `${label}.cache_price`) !== prices.input_cache_read_tokens) {
      throw new TypeError(`${label} has conflicting cache-read prices`);
    }
  }
  const metrics = BILLING_METRICS.filter(metric => prices[metric] !== undefined);
  if (metrics.length === 0) throw new TypeError(`${label} must contain at least one token price`);

  // Free catalog entries explicitly carry batch_size=0 and zero rates.
  // A zero denominator never makes an absent or positive price free.
  if (batchSize === 0) {
    if (metrics.some(metric => !decimalStringIsZero(prices[metric]!))) {
      throw new RangeError(`${label} has a non-zero price with a zero batch_size`);
    }
    return prices;
  }
  const rates: PriceVector = {};
  for (const metric of metrics) {
    rates[metric] = divideDecimalString(multiplyDecimalStrings(prices[metric]!, USD_PER_AI_CREDIT), String(batchSize));
  }
  return rates;
};

const rawPricingEntries = (model: CopilotRawModel): readonly PricingEntry[] | null => {
  const label = `Copilot model ${model.id}.billing`;
  if (model.billing === undefined) return null;
  const billing = recordField(model.billing, label);
  if (billing.token_prices === undefined) return null;
  const prices = recordField(billing.token_prices, `${label}.token_prices`);
  const batchSize = prices.batch_size === undefined ? DEFAULT_BATCH_SIZE : prices.batch_size;
  if (typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize < 0) {
    throw new RangeError(`${label}.token_prices.batch_size must be a non-negative safe integer`);
  }
  const base = recordField(prices.default, `${label}.token_prices.default`);
  const entries = [pricingEntry(priceBand(base, batchSize, `${label}.token_prices.default`))];
  if (prices.long_context !== undefined) {
    const long = recordField(prices.long_context, `${label}.token_prices.long_context`);
    // The default band's upper bound starts the long-context price, not the
    // long band's cap or the model's context-window capability.
    // https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
    const boundary = base.max_prompt_tokens !== undefined ? base.max_prompt_tokens : base.context_max;
    if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary) || boundary <= 0) {
      throw new RangeError(`${label}.token_prices.default must publish a positive long-context boundary`);
    }
    entries.push(pricingEntry(priceBand(long, batchSize, `${label}.token_prices.long_context`), {
      inputTokens: { operator: 'gt', value: boundary },
    }));
  }
  return entries;
};

export const pricingForCopilotModel = (
  model: CopilotRawModel,
  variants: readonly CopilotRawModel[],
  index: CopilotVariantIndex,
): ModelPricing | null => {
  const base = rawPricingEntries(model);
  const variantPricing = variants.map(raw => ({ raw, entries: rawPricingEntries(raw) }));
  if (base === null || variantPricing.some(variant => variant.entries === null)) return null;

  const entriesBySelector = new Map<string, PricingEntry>();
  const add = (entry: PricingEntry): void => {
    const key = canonicalPricingSelectorKey(entry.selector);
    const previous = entriesBySelector.get(key);
    if (previous && BILLING_METRICS.some(metric => previous.rates[metric] !== entry.rates[metric])) {
      throw new TypeError(`Copilot model ${model.id} has conflicting variant prices for selector ${key}`);
    }
    entriesBySelector.set(key, entry);
  };
  for (const entry of base) add(entry);
  for (const variant of variantPricing) {
    // Raw accelerated lanes use the same tier spelling as their served usage.
    // https://developers.openai.com/api/docs/guides/priority-processing
    // https://docs.claude.com/en/build-with-claude/fast-mode
    const serviceTier = index.suffixOf(variant.raw.id) === 'fast'
      ? model.id.startsWith('claude-') ? 'fast' : 'priority'
      : undefined;
    for (const entry of variant.entries!) {
      add(serviceTier === undefined ? entry : pricingEntry(entry.rates, { ...entry.selector, serviceTier }));
    }
  }
  return modelPricing(...entriesBySelector.values());
};
