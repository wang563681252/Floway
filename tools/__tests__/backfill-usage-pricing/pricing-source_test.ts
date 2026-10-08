import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'vitest';

import { loadPricingSourceFile, parsePricingSourceDocument, parsePricingSourceReference } from '../../src/backfill-usage-pricing/pricing-source.ts';
import { basePricing } from '@floway-dev/protocols/common';

const intent = {
  upstream: 'copilot-1',
  model: 'retired-public',
  modelKey: 'retired-wire',
  startHour: '2026-01-01T00',
  endHour: '2026-01-02T00',
  timezone: 'UTC',
  mode: 'fill' as const,
  metrics: ['input_tokens'] as const,
};
const document = {
  schemaVersion: 1,
  kind: 'usage-pricing-source',
  upstream: intent.upstream,
  model: intent.model,
  modelKey: intent.modelKey,
  referenceUrl: 'https://vendor.example/pricing',
  observedAt: '2026-10-04T00:00:00.000Z',
  pricing: basePricing({ input_tokens: '0.000002' }),
};
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const sourcePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'floway pricing source & '));
  directories.push(directory);
  const path = join(directory, 'source.json');
  await writeFile(path, JSON.stringify(document));
  return path;
};

test('verified pricing sources retain the exact model scope, reference and USD-per-unit rates', () => {
  expect(parsePricingSourceDocument(document)).toEqual(document);
});

test('source files bind their canonical path and content digest, including metadata changes', async () => {
  const path = await sourcePath();
  const first = await loadPricingSourceFile(path, { ...intent, metrics: [...intent.metrics] });
  expect(first.path).toBe(await realpath(path));
  expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(first.document).toEqual(document);
  await writeFile(path, JSON.stringify({ ...document, observedAt: '2026-10-05T00:00:00.000Z' }));
  const changed = await loadPricingSourceFile(path, { ...intent, metrics: [...intent.metrics] });
  expect(changed.digest).not.toBe(first.digest);
});

test.each(['upstream', 'model', 'modelKey'] as const)('source files cannot be applied to a different %s', async field => {
  const path = await sourcePath();
  await expect(loadPricingSourceFile(path, {
    ...intent,
    metrics: [...intent.metrics],
    [field]: 'another-target',
  })).rejects.toMatchObject({ code: 'pricing-source-scope' });
});

test('missing source files preserve the original filesystem error chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-pricing-missing-'));
  directories.push(directory);
  await expect(loadPricingSourceFile(join(directory, 'missing.json'), {
    ...intent, metrics: [...intent.metrics],
  })).rejects.toMatchObject({ code: 'pricing-source-read', cause: { code: 'ENOENT' } });
});

test('malformed source JSON preserves the parse error rather than hiding it as a missing price', async () => {
  const path = await sourcePath();
  await writeFile(path, '{invalid-json');
  await expect(loadPricingSourceFile(path, {
    ...intent, metrics: [...intent.metrics],
  })).rejects.toMatchObject({ code: 'pricing-source-json', cause: { name: 'SyntaxError' } });
});

test.each([
  null,
  [],
  { ...document, schemaVersion: 2 },
  { ...document, kind: 'another-kind' },
  { ...document, upstream: '' },
  { ...document, model: 1 },
  { ...document, modelKey: null },
  { ...document, referenceUrl: 'not-a-url' },
  { ...document, referenceUrl: 'http://vendor.example/pricing' },
  { ...document, referenceUrl: 'https://user:password@vendor.example/pricing' },
  { ...document, observedAt: 'yesterday' },
  { ...document, observedAt: '2026-10-04' },
  { ...document, pricing: undefined },
  { ...document, pricing: { entries: [{ rates: { input_tokens: '-1' } }] } },
  { ...document, pricing: { entries: [{ rates: { input_tokens: 1 } }] } },
  { ...document, pricing: { entries: [{ rates: { input_tokens: '1' }, selector: { unknown: 'tier' } }] } },
  { ...document, unknown: true },
])('malformed explicit pricing sources are rejected (%#)', value => {
  expect(() => parsePricingSourceDocument(value)).toThrow();
});

test('source references reject relative paths, malformed digests and unexpected metadata', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  expect(parsePricingSourceReference({ path: join(tmpdir(), 'source.json'), digest })).toEqual({
    path: join(tmpdir(), 'source.json'), digest,
  });
  for (const value of [
    { path: 'relative.json', digest },
    { path: join(tmpdir(), 'source.json'), digest: 'wrong' },
    { path: join(tmpdir(), 'source.json'), digest, unknown: true },
    null,
  ]) expect(() => parsePricingSourceReference(value)).toThrow();
});
