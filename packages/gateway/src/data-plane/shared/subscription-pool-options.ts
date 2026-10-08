import type { ConversationRequest } from './conversation-context.ts';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

export interface PoolIterationOptions {
  conversation?: ConversationRequest | null;
  quotaScope?: string;
  priorityFor?: (candidate: ModelCandidate) => number;
  errorFormat?: 'openai' | 'anthropic' | 'gemini';
}

export const subscriptionPoolModelKey = (candidate: ModelCandidate, scope = 'chat'): string =>
  JSON.stringify([scope, providerModelOf(candidate).upstreamModelId, candidate.rules ?? {}]);
