import type { InferResponseType } from 'hono/client';

import type { api } from '../../api/client';

export type SubscriptionPoolView = InferResponseType<(typeof api.api)['subscription-pools']['$get'], 200>[number];
export type PoolUpstreamOption = InferResponseType<(typeof api.api)['upstream-options']['$get'], 200>[number];
export type ConversationPage = InferResponseType<(typeof api.api)['subscription-pools'][':id']['conversations']['$get'], 200>;
export type ConversationView = ConversationPage['conversations'][number];
export type ConversationCheck = InferResponseType<(typeof api.api)['subscription-pools'][':id']['conversations'][':conversationId']['check']['$get'], 200>;

const reasons = [
  'opaque_context', 'unsupported_context', 'attachment_unavailable', 'history_unavailable', 'history_mismatch', 'settings_changed',
  'pending_tool_results', 'orphan_tool_results', 'execution_uncertain', 'conversation_busy', 'conversation_closed',
  'no_session_account', 'no_session_capacity', 'bound_account_busy', 'bound_account_unavailable',
  'account_temporarily_unavailable', 'incompatible_model', 'migration_requested', 'conversation_key_revoked',
  'upstream_rejected', 'input_rejected', 'credential_invalid', 'pre_dispatch_failed', 'turn_already_completed',
  'restored_requires_confirmation',
] as const;

export const conversationReason = (reason: string | null): typeof reasons[number] | 'unknown' | 'none' =>
  reason === null ? 'none' : reasons.find(known => known === reason) ?? 'unknown';

export const poolConcurrencyValue = (unlimited: boolean, value: string): number | null => {
  if (unlimited) return null;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Subscription pool concurrency must be a positive integer');
  return parsed;
};
