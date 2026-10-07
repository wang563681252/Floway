import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import type { ToolDatabase } from '../../src/backfill-usage-pricing/database.ts';
import { openNodeDatabase } from '../../src/backfill-usage-pricing/node-database.ts';
import { applyPlan, buildPlan, parsePlan } from '../../src/backfill-usage-pricing/plan.ts';
import { loadPricingSourceFile } from '../../src/backfill-usage-pricing/pricing-source.ts';
import { MODEL_CATALOG_REVISION } from '@floway-dev/gateway';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const createDatabase = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-tools-plan-'));
  const path = join(directory, 'floway.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE upstreams (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
      sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, config_json TEXT NOT NULL,
      models_cache_json TEXT
    );
    CREATE TABLE usage (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, model_key TEXT NOT NULL,
      hour TEXT NOT NULL, pricing_selector TEXT NOT NULL, metric TEXT NOT NULL,
      quantity TEXT NOT NULL, unit_price TEXT
    );
    CREATE UNIQUE INDEX idx_usage_metric_identity
      ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, metric);
  `);
  const pricing = { entries: [{ rates: { input_tokens: '0.01' } }] };
  const config = { models: [{ kind: 'chat', endpoints: { openaiResponses: {} }, upstreamModelId: 'wire', pricing }] };
  db.prepare('INSERT INTO upstreams VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('azure-1', 'azure', 'Azure', 1, 0, '2026-01-01T00:00:00.000Z', JSON.stringify(config), null);
  db.prepare('INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('key-1', 'public', 'azure-1', 'wire', '2026-01-01T00', '{}', 'input_tokens', '10', null);
  db.prepare('INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('key-1', 'public', 'azure-1', 'wire', '2026-01-01T00', '{}', 'output_tokens', '5', null);
  db.close();
  return path;
};

const intent = {
  upstream: 'azure-1',
  model: 'public',
  modelKey: 'wire',
  startHour: '2026-01-01T00',
  endHour: '2026-01-02T00',
  timezone: 'UTC',
  metrics: ['input_tokens', 'output_tokens'] as const,
  mode: 'fill' as const,
};

test('plan and apply share one guarded SQL path and preserve missing metric prices', async () => {
  const read = await openNodeDatabase(await createDatabase(), 'read');
  const built = await buildPlan(read, { ...intent, metrics: [...intent.metrics] }, {
    now: Date.UTC(2026, 0, 2),
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  await read.close();
  assertEquals(built.plan.summary, { selectedRows: 2, rowsToUpdate: 1, remainingNullRows: 1 });
  assertEquals(built.plan.operations[0]?.representative, { quantity: '10', realizedCost: '0.1' });
  assertEquals(built.plan.skipped[0]?.metric, 'output_tokens');

  const write = await openNodeDatabase(built.plan.database.kind === 'node' ? built.plan.database.path : '', 'write');
  const result = await applyPlan(write, built.plan);
  assertEquals(result.rowsUpdated, 1);
  assertEquals(result.summary, { remainingNullRows: 1, remainingNullRowsByMetric: { output_tokens: 1 } });
  const rows = await write.query<{ metric: string; unit_price: string | null }>({
    sql: 'SELECT metric, unit_price FROM usage ORDER BY metric',
  });
  assertEquals(rows.rows, [
    { metric: 'input_tokens', unit_price: '0.01' },
    { metric: 'output_tokens', unit_price: null },
  ]);
  await write.close();
});

test('static provider plans do not bind unused model catalog snapshots', async () => {
  const path = await createDatabase();
  const catalogJson = JSON.stringify({ padding: 'Floway'.repeat(12_000) });
  const mutate = new DatabaseSync(path);
  mutate.prepare("UPDATE upstreams SET id = 'codex-1', provider = 'codex', name = 'Codex', config_json = '{}', models_cache_json = ?")
    .run(catalogJson);
  mutate.exec("UPDATE usage SET upstream = 'codex-1', model = 'gpt-5.4', model_key = 'gpt-5.4'");
  mutate.close();

  const database = await openNodeDatabase(path, 'write');
  try {
    const built = await buildPlan(database, {
      ...intent,
      upstream: 'codex-1',
      model: 'gpt-5.4',
      modelKey: 'gpt-5.4',
      metrics: [...intent.metrics],
    });
    assertEquals(built.guards.guardModelsCache, false);
    const observed: ToolDatabase = {
      ...database,
      execute: async statement => {
        assertEquals(statement.params?.includes(catalogJson), false);
        return await database.execute(statement);
      },
    };
    const result = await applyPlan(observed, built.plan);
    assertEquals(result.rowsUpdated, 2);
    assertEquals(result.summary, { remainingNullRows: 0, remainingNullRowsByMetric: {} });
  } finally {
    await database.close();
  }
});

test('Copilot plans guard the fetched pricing snapshot and reject catalog changes before writing', async () => {
  const path = await createDatabase();
  const now = Date.now();
  const cache = {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: now,
    models: [{
      id: 'gpt-6.1-sol',
      providerData: { rawModels: [{ id: 'gpt-6.1-sol' }] },
      pricing: { entries: [{ rates: { input_tokens: '0.000002', output_tokens: '0.00001' } }] },
    }],
  };
  const mutate = new DatabaseSync(path);
  mutate.prepare("UPDATE upstreams SET id = 'copilot-1', provider = 'copilot', config_json = '{}', models_cache_json = ?")
    .run(JSON.stringify(cache));
  mutate.exec("UPDATE usage SET upstream = 'copilot-1', model = 'gpt-6.1-sol', model_key = 'gpt-6.1-sol'");
  mutate.close();
  const database = await openNodeDatabase(path, 'write');
  try {
    const built = await buildPlan(database, {
      ...intent,
      upstream: 'copilot-1',
      model: 'gpt-6.1-sol',
      modelKey: 'gpt-6.1-sol',
      metrics: [...intent.metrics],
    }, { now });
    assertEquals(built.guards.guardModelsCache, true);
    assertEquals(built.plan.pricing.status === 'priced' ? built.plan.pricing.source : null, 'upstream:copilot-1:models-cache');
    assertEquals(built.plan.summary.rowsToUpdate, 2);
    await database.execute({
      sql: 'UPDATE upstreams SET models_cache_json = ? WHERE id = ?',
      params: [JSON.stringify({
        ...cache,
        models: [{
          ...cache.models[0],
          pricing: { entries: [{ rates: { input_tokens: '0.000003', output_tokens: '0.00001' } }] },
        }],
      }), 'copilot-1'],
    });
    await assertRejects(() => applyPlan(database, built.plan));
    const rows = await database.query<{ unit_price: string | null }>({ sql: 'SELECT unit_price FROM usage' });
    assertEquals(rows.rows.every(row => row.unit_price === null), true);
  } finally {
    await database.close();
  }
});

const createExplicitSource = async (path: string): Promise<string> => {
  const source = `${path}.pricing.json`;
  await writeFile(source, JSON.stringify({
    schemaVersion: 1,
    kind: 'usage-pricing-source',
    upstream: intent.upstream,
    model: intent.model,
    modelKey: intent.modelKey,
    referenceUrl: 'https://vendor.example/pricing',
    observedAt: '2026-10-04T00:00:00.000Z',
    pricing: { entries: [{ rates: { input_tokens: '0.02', output_tokens: '0.03' } }] },
  }));
  return source;
};

test('explicit scoped sources price unavailable historical models without changing the catalog or existing prices', async () => {
  const path = await createDatabase();
  const mutate = new DatabaseSync(path);
  mutate.exec("UPDATE upstreams SET provider = 'copilot', config_json = '{}'; UPDATE usage SET unit_price = '0.04' WHERE metric = 'output_tokens'");
  mutate.close();
  const sourcePath = await createExplicitSource(path);
  const selectedIntent = { ...intent, metrics: [...intent.metrics] };
  const pricingSource = await loadPricingSourceFile(sourcePath, selectedIntent);
  const database = await openNodeDatabase(path, 'write');
  try {
    const built = await buildPlan(database, selectedIntent, { pricingSource });
    assertEquals(built.plan.blockers, []);
    assertEquals(built.plan.summary.rowsToUpdate, 1);
    assertEquals(built.plan.pricing.sourceFile, { path: pricingSource.path, digest: pricingSource.digest });
    assertEquals(built.guards.guardModelsCache, false);
    const applied = await applyPlan(database, parsePlan(JSON.stringify(built.plan)));
    assertEquals(applied.rowsUpdated, 1);
    assertEquals((await database.query({ sql: 'SELECT metric, quantity, unit_price FROM usage ORDER BY metric' })).rows, [
      { metric: 'input_tokens', quantity: '10', unit_price: '0.02' },
      { metric: 'output_tokens', quantity: '5', unit_price: '0.04' },
    ]);
    assertEquals((await database.query({ sql: 'SELECT config_json, models_cache_json FROM upstreams' })).rows, [
      { config_json: '{}', models_cache_json: null },
    ]);
  } finally {
    await database.close();
    await unlink(sourcePath);
  }
});

test('changed or missing source files fail before any historical price write', async () => {
  const path = await createDatabase();
  const sourcePath = await createExplicitSource(path);
  const selectedIntent = { ...intent, metrics: [...intent.metrics] };
  const pricingSource = await loadPricingSourceFile(sourcePath, selectedIntent);
  const database = await openNodeDatabase(path, 'write');
  try {
    const built = await buildPlan(database, selectedIntent, { pricingSource });
    await writeFile(sourcePath, `${JSON.stringify(pricingSource.document)}\n`);
    await assertRejects(() => applyPlan(database, built.plan), Error, 'Pricing source changed');
    await unlink(sourcePath);
    await assertRejects(() => applyPlan(database, built.plan), Error, 'Cannot read pricing source');
    assertEquals((await database.query({ sql: 'SELECT metric, unit_price FROM usage ORDER BY metric' })).rows, [
      { metric: 'input_tokens', unit_price: null },
      { metric: 'output_tokens', unit_price: null },
    ]);
  } finally {
    await database.close();
  }
});

test('apply rejects stale and tampered plans before writing', async () => {
  const path = await createDatabase();
  const read = await openNodeDatabase(path, 'read');
  const built = await buildPlan(read, { ...intent, metrics: [...intent.metrics] }, { createdAt: '2026-01-02T00:00:00.000Z' });
  await read.close();

  const tampered = JSON.stringify({ ...built.plan, summary: { ...built.plan.summary, rowsToUpdate: 99 } });
  await assertRejects(() => Promise.resolve(parsePlan(tampered)));
  await assertRejects(() => Promise.resolve(parsePlan(JSON.stringify({ ...built.plan, createdAt: '2026-01-03T00:00:00.000Z' }))));

  const mutate = new DatabaseSync(path);
  mutate.prepare("UPDATE usage SET unit_price = '0.03' WHERE metric = 'input_tokens'").run();
  mutate.close();
  const write = await openNodeDatabase(path, 'write');
  await assertRejects(() => applyPlan(write, built.plan));
  await write.close();
});

test('plan blocks an unpriced historical selector when priced siblings prove an older catalog', async () => {
  const path = await createDatabase();
  const mutate = new DatabaseSync(path);
  mutate.prepare("UPDATE usage SET pricing_selector = ? WHERE metric = 'input_tokens'")
    .run('{"serviceTier":"priority"}');
  mutate.prepare("UPDATE usage SET unit_price = '0.02', hour = '2025-12-31T23' WHERE metric = 'output_tokens'").run();
  mutate.close();

  const read = await openNodeDatabase(path, 'read');
  const built = await buildPlan(read, { ...intent, metrics: ['input_tokens'] });
  await read.close();
  assertEquals(built.plan.blockers.some(blocker => blocker.code === 'historical-selector-drift'), true);
});

test('obsolete selectors do not block coordinates that the selected mode would not change', async () => {
  const path = await createDatabase();
  const mutate = new DatabaseSync(path);
  mutate.prepare("UPDATE usage SET pricing_selector = ?, unit_price = '0.01' WHERE metric = 'input_tokens'")
    .run('{"serviceTier":"priority"}');
  mutate.close();

  const read = await openNodeDatabase(path, 'read');
  const fill = await buildPlan(read, { ...intent, metrics: ['input_tokens'] });
  const overwrite = await buildPlan(read, { ...intent, metrics: ['input_tokens'], mode: 'overwrite' });
  await read.close();
  assertEquals(fill.plan.blockers, []);
  assertEquals(fill.plan.operations, []);
  assertEquals(overwrite.plan.blockers, []);
  assertEquals(overwrite.plan.operations, []);
});
