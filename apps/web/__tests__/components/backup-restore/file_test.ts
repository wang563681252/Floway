import { describe, expect, it } from 'vitest';

import { BACKUP_FILE_VERSION, parseBackupFile } from '../../../src/components/backup-restore/file';

const data = {
  users: [],
  apiKeys: [],
  upstreams: [],
  subscriptionPools: [],
  subscriptionConversations: [],
  subscriptionPoolIntake: [],
  proxies: [],
  usage: [],
  searchUsage: [],
  performanceIncluded: false,
  searchConfig: null,
};

const backup = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  version: BACKUP_FILE_VERSION,
  exportedAt: '2026-07-28T00:00:00.000Z',
  data,
  ...overrides,
});

describe('backup file validation', () => {
  it('accepts the envelope version this deployment writes', () => {
    expect(parseBackupFile(backup()).ok).toBe(true);
  });

  it('rejects a superseded envelope version outright', () => {
    expect(parseBackupFile(backup({ version: 19 })).ok).toBe(false);
  });

  it('accepts versions 20 and 21 but requires routing metadata in version 22', () => {
    const { subscriptionPools: _pools, ...legacy } = data;
    expect(parseBackupFile(backup({ version: 20, data: legacy })).ok).toBe(true);
    expect(parseBackupFile(backup({ version: 21, data: { ...legacy, subscriptionPools: [] } })).ok).toBe(true);
    expect(parseBackupFile(backup({ version: 21, data: legacy })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: legacy })).ok).toBe(false);
    const { subscriptionConversations: _conversations, ...missingRouting } = data;
    expect(parseBackupFile(backup({ data: missingRouting })).ok).toBe(false);
  });

  it('rejects unknown fields instead of stripping them', () => {
    expect(parseBackupFile(backup({ typo: true })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, typo: [] } })).ok).toBe(false);
  });

  it('keeps performance presence synchronized with its flag', () => {
    expect(parseBackupFile(backup({ data: { ...data, performance: [] } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true, performance: [] } })).ok).toBe(true);
  });
});
