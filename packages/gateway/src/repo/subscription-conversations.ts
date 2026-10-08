export type ConversationPhase = 'active' | 'preparing' | 'dispatched' | 'uncertain' | 'blocked' | 'closed';

export interface SubscriptionConversation {
  id: string;
  poolId: string;
  apiKeyId: string;
  upstreamId: string;
  accountIdentity: string;
  version: number;
  phase: ConversationPhase;
  lastSeenAt: number;
  contextHash: string | null;
  contextLength: number;
  settingsHash: string | null;
  modelKey: string | null;
  portable: boolean;
  blockedReason: string | null;
  targetUpstreamId: string | null;
  targetIdentity: string | null;
  requestToken: string | null;
  leaseToken: string | null;
  turnKey: string | null;
  requestHash: string | null;
  lockUntil: number | null;
  migrations: number;
  migrationRequested: boolean;
}

export interface ConversationClaim {
  conversation: SubscriptionConversation;
  migration: boolean;
  leaseToken: string;
}

export interface SubscriptionConversationMigration {
  conversationId: string;
  version: number;
  fromUpstreamId: string;
  toUpstreamId: string;
  occurredAt: number;
}

export type ConversationClaimResult =
  | { kind: 'claimed'; claim: ConversationClaim }
  | { kind: 'busy' | 'uncertain' | 'repeated' | 'conflict' };

export interface SubscriptionConversationsRepo {
  get(id: string): Promise<SubscriptionConversation | null>;
  list(poolId: string): Promise<SubscriptionConversation[]>;
  history(id: string): Promise<SubscriptionConversationMigration[]>;
  start(input: {
    id: string; poolId: string; apiKeyId: string; upstreamId: string; identity: string;
    leaseToken: string; requestToken: string; now: number; lockUntil: number;
    turnKey: string | null; requestHash: string; migration: boolean; expectedVersion: number | null;
  }): Promise<ConversationClaimResult>;
  dispatched(id: string, token: string): Promise<void>;
  finish(input: {
    id: string; token: string; phase: 'completed' | 'rejected' | 'uncertain' | 'blocked';
    contextHash?: string; contextLength?: number; settingsHash?: string; modelKey?: string; portable?: boolean; reason?: string;
  }): Promise<void>;
  block(id: string, reason: string): Promise<void>;
  requestMigration(id: string, expectedVersion: number): Promise<boolean>;
  cancelMigration(id: string, expectedVersion: number): Promise<boolean>;
  close(id: string, expectedVersion: number, acknowledgeUncertain?: boolean): Promise<boolean>;
  deleteAll(): Promise<void>;
}
