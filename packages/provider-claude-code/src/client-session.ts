import { parseMetadataUserID } from './detection.ts';
import { isRecord, type SubscriptionClientSession } from '@floway-dev/provider';

export const claudeCodeSubscriptionSession = (headers: Headers, payload: unknown): SubscriptionClientSession | null => {
  const metadata = isRecord(payload) && isRecord(payload.metadata) ? payload.metadata : null;
  const parsed = typeof metadata?.user_id === 'string' ? parseMetadataUserID(metadata.user_id) : null;
  const sessionId = parsed?.sessionId.trim() ?? headers.get('x-claude-code-session-id')?.trim();
  if (!sessionId) return null;
  const turnId = headers.get('x-client-request-id')?.trim();
  return { sessionId, threadId: sessionId, turnId: turnId === '' ? null : turnId ?? null };
};
