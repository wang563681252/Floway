import { HTTPException } from 'hono/http-exception';

import { serializeStoredConfig } from '../../repo/upstream-json.ts';
import { serverSecretBytes } from '../../shared/server-secret.ts';
import { decodeOpenAIResponsesCompactShimItem } from '../chat/openai-responses/interceptors/compact-shim.ts';
import type { AffinityCodec } from '../chat/shared/affinity/index.ts';
import { subscriptionSessionForRequest } from '../providers/registry.ts';
import { encodeHex } from '@floway-dev/protocols/common';
import { isRecord, type SubscriptionClientSession } from '@floway-dev/provider';

export type ConversationProtocol = 'responses' | 'messages' | 'chat' | 'gemini';
export type ConversationIntent = 'generate' | 'compact' | 'measure';

export interface ConversationContext {
  entries: unknown[];
  portable: boolean;
  reasons: string[];
  pendingTools: string[];
}

export interface ConversationRequest {
  client: SubscriptionClientSession;
  protocol: ConversationProtocol;
  intent: ConversationIntent;
  context: ConversationContext;
  settingsHash: string;
  requestHash: string;
  turnKey: string | null;
  key(poolId: string, apiKeyId: string): Promise<string>;
  hash(entries: readonly unknown[], length?: number): Promise<string>;
}

const inputBlocks = (value: unknown, reasons: Set<string>): unknown[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) {
    reasons.add('unsupported_context');
    return [value];
  }
  return value.map(block => {
    if (!isRecord(block)) { reasons.add('unsupported_context'); return block; }
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      return {
        ...Object.fromEntries(Object.entries(block).filter(([name, field]) =>
          !(['annotations', 'logprobs'].includes(name) && Array.isArray(field) && field.length === 0))), type: 'text',
      };
    }
    if (block.type === 'input_image' || block.type === 'image') {
      const source = isRecord(block.source) ? block.source : null;
      if (!(typeof block.image_url === 'string' && block.image_url.startsWith('data:')) && source?.type !== 'base64') {
        reasons.add('attachment_unavailable');
      }
    }
    if (block.type === 'input_file' && typeof block.file_data !== 'string') reasons.add('attachment_unavailable');
    if (block.type === 'thinking' || block.type === 'redacted_thinking' || typeof block.signature === 'string' || typeof block.encrypted_content === 'string') {
      reasons.add('opaque_context');
    }
    if (typeof block.file_id === 'string') reasons.add('attachment_unavailable');
    return block;
  });
};

const normalizedEntry = (entry: unknown, reasons: Set<string>): unknown => {
  if (!isRecord(entry)) { reasons.add('unsupported_context'); return entry; }
  const { id: _id, status: _status, ...semantic } = entry;
  if (typeof entry.encrypted_content === 'string' || typeof entry.signature === 'string'
    || entry.type === 'reasoning' || entry.type === 'redacted_thinking'
    || entry.type === 'program' || entry.type === 'program_output'
    || entry.type === 'compaction' || entry.type === 'compaction_summary' || entry.type === 'context_compaction') {
    reasons.add('opaque_context');
  }
  if (entry.type === 'item_reference') reasons.add('history_unavailable');
  if (typeof entry.file_id === 'string') reasons.add('attachment_unavailable');
  if (typeof entry.role === 'string' || entry.type === 'message') {
    return { ...semantic, type: 'message', content: inputBlocks(entry.content, reasons) };
  }
  return semantic;
};

const pendingTools = (entries: readonly unknown[], reasons: Set<string>): string[] => {
  const calls = new Set<string>();
  const results = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    if (!isRecord(value)) return;
    if ((value.type === 'function_call' || value.type === 'custom_tool_call') && typeof value.call_id === 'string') calls.add(value.call_id);
    if (value.type === 'tool_use' && typeof value.id === 'string') calls.add(value.id);
    if ((value.type === 'function_call_output' || value.type === 'custom_tool_call_output') && typeof value.call_id === 'string') results.add(value.call_id);
    if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') results.add(value.tool_use_id);
    if (value.role === 'tool' && typeof value.tool_call_id === 'string') results.add(value.tool_call_id);
    if (Array.isArray(value.tool_calls)) {
      for (const call of value.tool_calls) if (isRecord(call) && typeof call.id === 'string') calls.add(call.id);
    }
    for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) walk(child);
  };
  for (const entry of entries) walk(entry);
  if ([...results].some(id => !calls.has(id))) reasons.add('orphan_tool_results');
  return [...calls].filter(id => !results.has(id));
};

export const normalizeConversationEntries = (entries: readonly unknown[]): ConversationContext => {
  const reasons = new Set<string>();
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) inspect(child); return; }
    if (!isRecord(value)) return;
    if (typeof value.encrypted_content === 'string' || typeof value.signature === 'string' || typeof value.reasoning_opaque === 'string'
      || typeof value.thoughtSignature === 'string'
      || ['thinking', 'redacted_thinking', 'reasoning', 'program', 'program_output', 'compaction', 'compaction_summary', 'context_compaction'].includes(String(value.type))) {
      reasons.add('opaque_context');
    }
    if (value.type === 'item_reference') reasons.add('history_unavailable');
    if (typeof value.file_id === 'string') reasons.add('attachment_unavailable');
    if (value.type === 'image' || value.type === 'input_image' || value.type === 'image_url') {
      const source = isRecord(value.source) ? value.source : null;
      const url = typeof value.image_url === 'string' ? value.image_url : isRecord(value.image_url) ? value.image_url.url : null;
      if (!(typeof url === 'string' && url.startsWith('data:')) && !(source?.type === 'base64' && typeof source.data === 'string')) {
        reasons.add('attachment_unavailable');
      }
    }
    if (value.type === 'input_file' && typeof value.file_data !== 'string') reasons.add('attachment_unavailable');
    if (value.type === 'document' && !(isRecord(value.source) && typeof value.source.data === 'string')) reasons.add('attachment_unavailable');
    for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) inspect(child);
  };
  inspect(entries);
  const normalized = entries.map(entry => normalizedEntry(entry, reasons));
  const pending = pendingTools(entries, reasons);
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.role !== 'string'
      && !['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'compaction_trigger'].includes(String(entry.type))) {
      reasons.add('unsupported_context');
    }
  }
  return { entries: normalized, portable: reasons.size === 0, reasons: [...reasons], pendingTools: pending };
};

export const conversationInputContext = (protocol: ConversationProtocol, payload: unknown): ConversationContext => {
  if (!isRecord(payload)) return { entries: [], portable: false, reasons: ['unsupported_context'], pendingTools: [] };
  if (protocol === 'responses') {
    if (!Array.isArray(payload.input)) return { entries: [], portable: false, reasons: ['history_unavailable'], pendingTools: [] };
    return normalizeConversationEntries(payload.input.flatMap(item => decodeOpenAIResponsesCompactShimItem(item) ?? [item]));
  }
  if (protocol === 'messages' || protocol === 'chat') {
    return Array.isArray(payload.messages) ? normalizeConversationEntries(payload.messages)
      : { entries: [], portable: false, reasons: ['history_unavailable'], pendingTools: [] };
  }
  return { entries: Array.isArray(payload.contents) ? payload.contents : [], portable: false, reasons: ['unsupported_context'], pendingTools: [] };
};

export const conversationContextWithAffinity = async (
  protocol: ConversationProtocol, payload: unknown, codec?: AffinityCodec,
): Promise<ConversationContext> => {
  if (!codec || !isRecord(payload)) return conversationInputContext(protocol, payload);
  if (protocol === 'responses' && Array.isArray(payload.input)) {
    const input: unknown[] = [];
    for (const item of payload.input) {
      if (!isRecord(item) || typeof item.type !== 'string' || typeof item.encrypted_content !== 'string') { input.push(item); continue; }
      const type = item.type === 'compaction_summary' ? 'compaction' : item.type;
      const decoded = await codec.unwrap(item.encrypted_content, `openai-responses.${type}.encrypted_content`);
      if (decoded.kind === 'owned' && decoded.value === undefined && decoded.syntheticItem === true
        && item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length === 0
        && Object.keys(item).every(name => ['type', 'id', 'status', 'summary', 'encrypted_content'].includes(name))) continue;
      input.push(decoded.kind === 'owned' && decoded.value !== undefined ? { ...item, encrypted_content: decoded.value } : item);
    }
    return conversationInputContext(protocol, { ...payload, input });
  }
  if ((protocol === 'messages' || protocol === 'chat') && Array.isArray(payload.messages)) {
    const messages: unknown[] = [];
    for (const message of payload.messages) {
      if (!isRecord(message)) { messages.push(message); continue; }
      if (protocol === 'chat' && typeof message.reasoning_opaque === 'string') {
        const decoded = await codec.unwrap(message.reasoning_opaque, 'openai-chat-completions.reasoning_opaque');
        if (decoded.kind === 'owned' && decoded.value === undefined) {
          const { reasoning_opaque: _carrier, ...visible } = message;
          messages.push(visible);
          continue;
        }
      }
      if (protocol !== 'messages' || !Array.isArray(message.content)) { messages.push(message); continue; }
      const content: unknown[] = [];
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'redacted_thinking' && typeof block.data === 'string') {
          const decoded = await codec.unwrap(block.data, 'anthropic-messages.redacted_thinking.data');
          if (decoded.kind === 'owned' && decoded.value === undefined && Object.keys(block).every(name => ['type', 'data'].includes(name))) continue;
        }
        content.push(block);
      }
      messages.push({ ...message, content });
    }
    return conversationInputContext(protocol, { ...payload, messages });
  }
  return conversationInputContext(protocol, payload);
};

export const createConversationRequest = async (
  secret: string | undefined,
  protocol: ConversationProtocol,
  payload: unknown,
  headers: Headers,
  intent: ConversationIntent = 'generate',
  codec?: AffinityCodec,
): Promise<ConversationRequest | null> => {
  const explicit = headers.get('x-floway-conversation-id');
  const nativeClient = protocol === 'messages'
    ? subscriptionSessionForRequest('claude-code', headers, payload)
    : subscriptionSessionForRequest('codex', headers, payload);
  let client: SubscriptionClientSession | null;
  if (explicit !== null) {
    if (!explicit.trim() || explicit.length > 1024) throw new HTTPException(400, { message: 'x-floway-conversation-id must be a non-empty identifier up to 1024 characters' });
    const branch = headers.get('x-floway-conversation-branch')?.trim() ?? explicit.trim();
    client = { sessionId: explicit.trim(), threadId: branch, turnId: headers.get('x-floway-turn-id')?.trim() ?? nativeClient?.turnId ?? null };
  } else {
    client = nativeClient;
  }
  if (!client) return null;
  const branch = headers.get('x-floway-conversation-branch');
  const turnId = headers.get('x-floway-turn-id');
  for (const value of [branch, turnId]) {
    if (value !== null && (!value.trim() || value.length > 1024)) throw new HTTPException(400, { message: 'Conversation branch and turn identifiers must be non-empty and at most 1024 characters' });
  }
  client = { ...client, threadId: branch?.trim() ?? client.threadId, turnId: turnId?.trim() ?? client.turnId };
  if ([client.sessionId, client.threadId, client.turnId].some(value => value !== null && value.length > 1024)) {
    throw new HTTPException(400, { message: 'Conversation, branch and turn identifiers must not exceed 1024 characters' });
  }
  if (!secret) throw new Error('Conversation routing requires the API key server secret');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(serverSecretBytes(secret)).buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (domain: string, value: unknown) => encodeHex(new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(serializeStoredConfig([domain, value])))));
  const context = await conversationContextWithAffinity(protocol, payload, codec);
  const effectiveIntent = intent === 'generate' && protocol === 'responses' && isRecord(payload) && Array.isArray(payload.input)
    && payload.input.some(item => isRecord(item) && item.type === 'compaction_trigger') ? 'compact' : intent;
  const settings = isRecord(payload) ? Object.fromEntries(Object.entries(payload)
    .filter(([name]) => !['input', 'messages', 'contents', 'metadata', 'client_metadata', 'previous_response_id', 'stream'].includes(name))) : payload;
  const requestHash = await sign('conversation-request', [context.entries, settings, effectiveIntent]);
  // Native agent turn IDs span tool continuations; explicit Floway turn IDs
  // identify one model request. https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs
  const turnKey = client.turnId === null ? null : await sign('conversation-turn',
    headers.has('x-floway-turn-id') ? client.turnId : [client.turnId, requestHash]);
  return {
    client, protocol, intent: effectiveIntent, context,
    settingsHash: await sign('conversation-settings', settings),
    requestHash, turnKey,
    key: async (poolId, apiKeyId) => await sign('conversation-binding', [apiKeyId, poolId, explicit === null ? protocol : 'floway', client.sessionId, client.threadId]),
    hash: async (entries, length = entries.length) => await sign('conversation-context', entries.slice(0, length)),
  };
};
