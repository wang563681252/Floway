export type SubscriptionPoolProvider = 'codex' | 'claude-code';

export interface SubscriptionPool {
  id: string;
  name: string;
  provider: SubscriptionPoolProvider;
  enabled: boolean;
  maxConcurrentRequests: number | null;
  upstreamIds: string[];
  createdAt: string;
}

export interface SubscriptionPoolCandidate {
  upstreamId: string;
  identity: string;
  utilization: number | null;
}

export interface SubscriptionPoolLease {
  token: string;
  poolId: string;
  upstreamId: string;
  identity: string;
  expiresAt: number;
}

export interface SubscriptionPoolAccountRuntime {
  upstreamId: string;
  inFlight: number;
  selections: number;
  cooldowns: Array<{ modelKey: string; until: number; status: number; failures: number }>;
}

export interface SubscriptionPoolsRepo {
  list(): Promise<SubscriptionPool[]>;
  get(id: string): Promise<SubscriptionPool | null>;
  save(pool: SubscriptionPool): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  runtime(poolId: string, now: number): Promise<SubscriptionPoolAccountRuntime[]>;
  acquire(input: {
    poolId: string;
    modelKey: string;
    candidates: readonly SubscriptionPoolCandidate[];
    token: string;
    now: number;
    expiresAt: number;
  }): Promise<SubscriptionPoolLease | null>;
  renew(token: string, now: number, expiresAt: number): Promise<boolean>;
  release(token: string): Promise<void>;
  observe(input: { upstreamId: string; modelKey: string; status: number; cooldownUntil: number | null }): Promise<void>;
  reset(upstreamId: string): Promise<void>;
}

export class SubscriptionPoolConflictError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SubscriptionPoolConflictError';
  }
}

export const assertSubscriptionPool = (pool: SubscriptionPool): void => {
  if (!pool.id || !pool.name.trim() || !Number.isFinite(Date.parse(pool.createdAt))) throw new TypeError('Subscription pool identity is invalid');
  if (pool.provider !== 'codex' && pool.provider !== 'claude-code') throw new TypeError('Subscription pool provider is unsupported');
  if (typeof pool.enabled !== 'boolean') throw new TypeError('Subscription pool enabled flag is invalid');
  if (pool.maxConcurrentRequests !== null && (!Number.isSafeInteger(pool.maxConcurrentRequests) || pool.maxConcurrentRequests < 1)) {
    throw new TypeError('Subscription pool concurrency must be a positive integer or null for unlimited');
  }
  if (pool.upstreamIds.length === 0 || pool.upstreamIds.some(id => !id) || new Set(pool.upstreamIds).size !== pool.upstreamIds.length) {
    throw new TypeError('Subscription pool must contain distinct upstreams');
  }
};
