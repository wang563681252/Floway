import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { SubscriptionConversationsDialog } from '../../../src/components/subscription-pools/conversations';
import type { ConversationCheck, ConversationPage, ConversationView, SubscriptionPoolView } from '../../../src/components/subscription-pools/data';
import { renderInApp } from '../../render';

afterEach(() => vi.restoreAllMocks());

const conversation: ConversationView = {
  id: 'a'.repeat(64), api_key_id: 'key', upstream_id: 'account-a', version: 2, phase: 'active',
  last_seen_at: 1_790_000_000_000, context_items: 2, portable: true, blocked_reason: null,
  target_upstream_id: null, migrations: 0, migration_requested: false,
};
const page: ConversationPage = { conversations: [conversation], total: 1, offset: 0, page_size: 100 };
const pool: SubscriptionPoolView = {
  id: 'pool', name: 'Subscriptions', provider: 'codex', enabled: true, max_concurrent_requests: 50,
  upstream_ids: ['account-a', 'account-b'], created_at: '2026-10-08T00:00:00.000Z',
  accounts: ['account-a', 'account-b'].map(id => ({
    upstream_id: id, name: id, enabled: true, health: 'active', in_flight: 0, selections: 0,
    utilization: null, quota_observed_at: null, quota_fresh: false, unavailable_until: null, cooldowns: [],
    accept_new_sessions: true, recent_sessions: id === 'account-a' ? 1 : 0,
  })),
};
const check: ConversationCheck = {
  conversation, blockers: [], eligible_upstream_ids: ['account-b'], requires_full_context: true,
  can_request_migration: true, can_close: true, requires_uncertain_acknowledgement: false, history: [],
};
const install = (detail: ConversationCheck) => {
  const actions: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), 'http://localhost'), init);
    if (request.url.endsWith('/check')) return Response.json(detail);
    if (request.url.endsWith('/action')) { actions.push(await request.json()); return new Response(null, { status: 204 }); }
    return Response.json(page);
  });
  renderInApp(<SubscriptionConversationsDialog pool={pool} initialPage={page} open onOpenChange={() => {}} onChanged={async () => {}} />);
  return actions;
};

test('conversation diagnostics render the actual phase and request only a versioned next-turn handoff', async () => {
  const actions = install(check);
  expect(screen.getByRole('table', { name: 'Durable conversation bindings' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Check / details' }));
  await screen.findByText('Version 2 · 2 context items · 0 completed migrations');
  fireEvent.click(screen.getByRole('button', { name: 'Request safe handoff next turn' }));
  await waitFor(() => expect(actions).toEqual([{ action: 'request-migration', expected_version: 2, acknowledge_uncertain: false }]));
});

test('opaque state visibly blocks the migration action instead of offering a force switch', async () => {
  install({ ...check, can_request_migration: false, blockers: ['opaque_context'], conversation: { ...conversation, portable: false } });
  fireEvent.click(screen.getByRole('button', { name: 'Check / details' }));
  await screen.findByText('Opaque, signed or unverified state requires the original account');
  expect(screen.getByRole('button', { name: 'Request safe handoff next turn' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: /force/i })).toBeNull();
});

test('closing uncertainty requires the separate stopped-upstream confirmation and never requests a replay', async () => {
  const uncertain: ConversationCheck = {
    ...check, can_request_migration: false, blockers: ['execution_uncertain'],
    requires_uncertain_acknowledgement: true, conversation: { ...conversation, phase: 'uncertain' },
  };
  const actions = install(uncertain);
  fireEvent.click(screen.getByRole('button', { name: 'Check / details' }));
  await screen.findByText('The previous request may have executed; automatic replay is forbidden');
  fireEvent.click(screen.getByRole('button', { name: 'Close branch' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm stopped' }));
  await waitFor(() => expect(actions).toEqual([{ action: 'close', expected_version: 2, acknowledge_uncertain: true }]));
});
