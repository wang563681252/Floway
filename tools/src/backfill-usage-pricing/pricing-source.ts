import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { inputError, ToolError } from './errors.ts';
import type { BackfillIntent } from './plan.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { isRecord, pricingField } from '@floway-dev/provider';

export interface PricingSourceDocument {
  schemaVersion: 1;
  kind: 'usage-pricing-source';
  upstream: string;
  model: string;
  modelKey: string;
  referenceUrl: string;
  observedAt: string;
  pricing: ModelPricing;
}

export interface PricingSourceReference {
  path: string;
  digest: string;
}

export interface PricingSourceFile extends PricingSourceReference {
  document: PricingSourceDocument;
}

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw inputError('pricing-source-field', `${field} must be a non-empty string`);
  return value;
};

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const unexpected = Object.keys(value).filter(key => !keys.includes(key));
  if (unexpected.length > 0) throw inputError('pricing-source-field', `Pricing source has unknown fields: ${unexpected.join(', ')}`);
};

export const parsePricingSourceReference = (value: unknown): PricingSourceReference => {
  if (!isRecord(value)) throw inputError('pricing-source-reference', 'Pricing source reference must be an object');
  onlyKeys(value, ['path', 'digest']);
  const path = stringField(value.path, 'pricing source path');
  const digest = stringField(value.digest, 'pricing source digest');
  if (!isAbsolute(path) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw inputError('pricing-source-reference', 'Pricing source reference requires an absolute path and SHA-256 digest');
  }
  return { path, digest };
};

export const parsePricingSourceDocument = (value: unknown): PricingSourceDocument => {
  if (!isRecord(value)) throw inputError('pricing-source-document', 'Pricing source must be a JSON object');
  onlyKeys(value, ['schemaVersion', 'kind', 'upstream', 'model', 'modelKey', 'referenceUrl', 'observedAt', 'pricing']);
  if (value.schemaVersion !== 1 || value.kind !== 'usage-pricing-source') {
    throw inputError('pricing-source-document', 'Pricing source schema is unsupported');
  }
  const upstream = stringField(value.upstream, 'upstream');
  const model = stringField(value.model, 'model');
  const modelKey = stringField(value.modelKey, 'modelKey');
  const referenceUrl = stringField(value.referenceUrl, 'referenceUrl');
  let reference: URL;
  try {
    reference = new URL(referenceUrl);
  } catch (cause) {
    throw new ToolError('pricing-source-reference', 'Pricing reference must be a valid HTTPS URL', 2, { cause });
  }
  if (reference.protocol !== 'https:' || reference.username || reference.password) {
    throw inputError('pricing-source-reference', 'Pricing reference must use HTTPS without credentials');
  }
  const observedAt = stringField(value.observedAt, 'observedAt');
  if (Number.isNaN(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw inputError('pricing-source-observed-at', 'Pricing source observedAt must be a canonical ISO timestamp');
  }
  let pricing: ModelPricing | undefined;
  try {
    pricing = pricingField(value.pricing, 'pricing source pricing');
  } catch (cause) {
    throw new ToolError('pricing-source-pricing', 'Pricing source contains invalid rates or selectors', 2, { cause });
  }
  if (pricing === undefined) throw inputError('pricing-source-pricing', 'Pricing source must declare pricing');
  return { schemaVersion: 1, kind: 'usage-pricing-source', upstream, model, modelKey, referenceUrl, observedAt, pricing };
};

export const assertPricingSourceScope = (source: PricingSourceDocument, intent: BackfillIntent): void => {
  if (source.upstream !== intent.upstream || source.model !== intent.model || source.modelKey !== intent.modelKey) {
    throw inputError('pricing-source-scope', 'Pricing source does not match the selected upstream, public model and wire model key');
  }
};

export const loadPricingSourceFile = async (path: string, intent: BackfillIntent): Promise<PricingSourceFile> => {
  let canonicalPath: string;
  let contents: Buffer;
  try {
    canonicalPath = await realpath(path);
    contents = await readFile(canonicalPath);
  } catch (cause) {
    throw new ToolError('pricing-source-read', `Cannot read pricing source ${path}`, 2, { cause });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch (cause) {
    throw new ToolError('pricing-source-json', 'Pricing source is not valid JSON', 2, { cause });
  }
  const document = parsePricingSourceDocument(value);
  assertPricingSourceScope(document, intent);
  return {
    path: canonicalPath,
    digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    document,
  };
};
