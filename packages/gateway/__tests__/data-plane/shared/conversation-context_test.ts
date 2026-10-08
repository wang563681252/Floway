import { expect, test } from 'vitest';

import { affinityEgressOptions } from '../../../src/data-plane/chat/shared/affinity/index.ts';
import { conversationContextWithAffinity, conversationInputContext, createConversationRequest, normalizeConversationEntries } from '../../../src/data-plane/shared/conversation-context.ts';
import { encodeBase64UrlJson } from '../../../src/shared/base64url-json.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';

const secret = '00'.repeat(32);
const payload = { model: 'model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] };

test('Floway conversation keys isolate API keys, pools, clients and explicit branches', async () => {
  const headers = new Headers({ 'x-floway-conversation-id': 'session', 'x-floway-conversation-branch': 'branch' });
  const request = await createConversationRequest(secret, 'responses', payload, headers);
  if (!request) throw new Error('Expected explicit conversation');
  expect(await request.key('pool', 'key')).toMatch(/^[0-9a-f]{64}$/);
  expect(await request.key('pool', 'key')).not.toBe(await request.key('pool', 'other-key'));
  expect(await request.key('pool', 'key')).not.toBe(await request.key('other-pool', 'key'));
  const other = await createConversationRequest(secret, 'responses', payload, new Headers({ 'x-floway-conversation-id': 'session', 'x-floway-conversation-branch': 'other' }));
  const native = await createConversationRequest(secret, 'responses', payload, new Headers({ 'session-id': 'session', 'thread-id': 'branch' }));
  expect(await other?.key('pool', 'key')).not.toBe(await request.key('pool', 'key'));
  expect(await native?.key('pool', 'key')).not.toBe(await request.key('pool', 'key'));
});

test('authentication sessions and repeated prompt text never become conversation identity', async () => {
  expect(await createConversationRequest(secret, 'responses', payload, new Headers({ 'x-floway-session': 'authentication-only' }))).toBeNull();
  await expect(createConversationRequest(secret, 'responses', payload, new Headers({ 'x-floway-conversation-id': ' ' }))).rejects.toMatchObject({ status: 400 });
  await expect(createConversationRequest(secret, 'responses', payload, new Headers({ 'x-floway-conversation-id': 'a', 'x-floway-conversation-branch': ' ' }))).rejects.toMatchObject({ status: 400 });
  await expect(createConversationRequest(undefined, 'responses', payload, new Headers({ 'session-id': 'session' }))).rejects.toThrow('server secret');
});

test('canonical context equates input/output text, key order and empty transport decorations', async () => {
  const request = await createConversationRequest(secret, 'responses', payload, new Headers({ 'session-id': 'session' }));
  if (!request) throw new Error('Expected conversation');
  const input = normalizeConversationEntries([{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'answer' }] }]);
  const output = normalizeConversationEntries([{
    id: 'ephemeral', status: 'completed', role: 'assistant', type: 'message',
    content: [{ text: 'answer', type: 'output_text', annotations: [], logprobs: [] }],
  }]);
  expect(await request.hash(input.entries)).toBe(await request.hash(output.entries));
});

test('directives, tool definitions and generation settings remain in the protected settings hash', async () => {
  const headers = new Headers({ 'session-id': 'session' });
  const first = await createConversationRequest(secret, 'responses', { ...payload, instructions: 'directive', tools: [{ type: 'function', name: 'read' }] }, headers);
  const changed = await createConversationRequest(secret, 'responses', { ...payload, instructions: 'different', tools: [{ type: 'function', name: 'read' }] }, headers);
  const streamed = await createConversationRequest(secret, 'responses', { ...payload, instructions: 'directive', tools: [{ type: 'function', name: 'read' }], stream: true, metadata: { trace: 'new' } }, headers);
  expect(first?.settingsHash).not.toBe(changed?.settingsHash);
  expect(first?.settingsHash).toBe(streamed?.settingsHash);
});

test.each([
  [{ type: 'reasoning', encrypted_content: 'native-opaque', summary: [] }, 'opaque_context'],
  [{ type: 'compaction', encrypted_content: 'native-opaque' }, 'opaque_context'],
  [{ type: 'program', fingerprint: 'account-owned' }, 'opaque_context'],
  [{ type: 'item_reference', id: 'missing-item' }, 'history_unavailable'],
  [{ role: 'user', content: [{ type: 'input_file', file_id: 'account-file' }] }, 'attachment_unavailable'],
  [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image' } }] }] }, 'attachment_unavailable'],
] as const)('non-replayable context is explicitly classified: %j', (entry, reason) => {
  const context = normalizeConversationEntries([entry]);
  expect(context.portable).toBe(false);
  expect(context.reasons).toContain(reason);
});

test('tool IDs and complete call/result pairs are required at a handoff boundary', () => {
  const call = { type: 'function_call', call_id: 'tool', name: 'read', arguments: '{"path":"a"}' };
  const result = { type: 'function_call_output', call_id: 'tool', output: 'bytes' };
  expect(normalizeConversationEntries([call]).pendingTools).toEqual(['tool']);
  expect(normalizeConversationEntries([call, result]).pendingTools).toEqual([]);
  expect(normalizeConversationEntries([result]).reasons).toContain('orphan_tool_results');
  expect(normalizeConversationEntries([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'aGVsbG8=', media_type: 'image/png' } }] }]).portable).toBe(true);
});

test('an existing gateway checkpoint expands byte-for-byte without another summary', () => {
  const checkpoint = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'existing exact checkpoint' }] }];
  const context = conversationInputContext('responses', { input: [{ type: 'compaction', encrypted_content: encodeBase64UrlJson(checkpoint) }] });
  expect(context.portable).toBe(true);
  expect(context.entries).toEqual(normalizeConversationEntries(checkpoint).entries);
});

test('only authenticated, empty Floway affinity bookkeeping is excluded from the context proof', async () => {
  const ctx = mockChatGatewayCtx();
  const options = affinityEgressOptions(ctx);
  const empty = await options.codec.wrap(undefined, options.affinity, 'openai-responses.reasoning.encrypted_content', { syntheticItem: true });
  const native = await options.codec.wrap('native-opaque', options.affinity, 'openai-responses.reasoning.encrypted_content');
  expect((await conversationContextWithAffinity('responses', {
    input: [
      { type: 'reasoning', summary: [], encrypted_content: empty }, ...payload.input,
    ],
  }, ctx.affinity.codec)).entries).toEqual(normalizeConversationEntries(payload.input).entries);
  expect((await conversationContextWithAffinity('responses', {
    input: [
      { type: 'reasoning', summary: [], encrypted_content: native },
    ],
  }, ctx.affinity.codec)).portable).toBe(false);
  expect((await conversationContextWithAffinity('responses', {
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'real context' }], encrypted_content: empty },
    ],
  }, ctx.affinity.codec)).portable).toBe(false);
  const redacted = await options.codec.wrap(undefined, options.affinity, 'anthropic-messages.redacted_thinking.data');
  expect((await conversationContextWithAffinity('messages', {
    messages: [{
      role: 'assistant', content: [
        { type: 'redacted_thinking', data: redacted }, { type: 'text', text: 'answer' },
      ],
    }],
  }, ctx.affinity.codec)).portable).toBe(true);
});
