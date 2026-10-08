import { isRecord, type SubscriptionClientSession } from '@floway-dev/provider';

export const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};

export const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const clientCodexClientMetadata = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) return {};
  return isRecord(body.client_metadata) ? body.client_metadata : {};
};

const parseClientTurnMetadataJson = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

// Per-turn body metadata outranks frozen WebSocket handshake headers.
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L184-L189
export const callerTurnMetadata = (headers: Headers, metadata: Record<string, unknown>): Record<string, unknown> | null =>
  parseClientTurnMetadataJson(stringField(metadata, 'x-codex-turn-metadata'))
  ?? parseClientTurnMetadataJson(trimHeader(headers, 'x-codex-turn-metadata'));

export const codexSubscriptionSession = (headers: Headers, payload: unknown): SubscriptionClientSession | null => {
  const metadata = clientCodexClientMetadata(payload);
  const turn = callerTurnMetadata(headers, metadata);
  const sessionId = stringField(metadata, 'session_id') ?? stringField(turn, 'session_id')
    ?? trimHeader(headers, 'session-id') ?? trimHeader(headers, 'session_id');
  const threadId = stringField(metadata, 'thread_id') ?? stringField(turn, 'thread_id') ?? trimHeader(headers, 'thread-id');
  const stableSession = sessionId ?? threadId;
  if (stableSession === null) return null;
  return {
    sessionId: stableSession,
    threadId: threadId ?? stableSession,
    turnId: stringField(metadata, 'turn_id') ?? stringField(turn, 'turn_id'),
  };
};
