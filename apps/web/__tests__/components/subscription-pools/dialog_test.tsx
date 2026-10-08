import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { poolConcurrencyValue, type PoolUpstreamOption } from '../../../src/components/subscription-pools/data';
import { SubscriptionPoolDialog } from '../../../src/components/subscription-pools/dialog';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { renderInApp } from '../../render';

const upstreams: PoolUpstreamOption[] = [
  { id: 'codex', name: 'Codex account', kind: 'codex', enabled: true, hue: 100, cachedModelCount: 1 },
  { id: 'claude', name: 'Claude account', kind: 'claude-code', enabled: true, hue: 200, cachedModelCount: 1 },
];

afterEach(() => { vi.restoreAllMocks(); });

const renderDialog = () => renderInApp(<MemoryRouter><OutcomeToastProvider>
  <SubscriptionPoolDialog record={null} pools={[]} upstreams={upstreams} open onOpenChange={() => {}} onSaved={async () => {}} />
</OutcomeToastProvider></MemoryRouter>);

describe('subscription pool editor', () => {
  it('defaults to exactly 50 per account and selects only accounts of the chosen provider', () => {
    renderDialog();
    const input = screen.getByRole('spinbutton');
    if (!(input instanceof HTMLInputElement)) throw new Error('Concurrency input is not an input element');
    expect(input.value).toBe('50');
    expect(screen.getByRole('checkbox', { name: 'Codex account' })).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'Claude account' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code' }));
    expect(screen.getByRole('checkbox', { name: 'Claude account' })).toBeDefined();
  });

  it('unlimited saves an explicit null rather than zero and does not send credentials', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request ? new Request(input, init)
        : new Request(new URL(String(input), 'http://localhost'), init);
      bodies.push(await request.json());
      return Response.json({ id: 'new-pool' }, { status: 201 });
    });
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: 'Pool name' }), { target: { value: 'Subscriptions' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex account' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }));
    expect(screen.queryByRole('spinbutton')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      name: 'Subscriptions', provider: 'codex', enabled: true, max_concurrent_requests: null, upstream_ids: ['codex'],
    });
  });

  it('numeric validation never interprets invalid numbers as unlimited', () => {
    expect(poolConcurrencyValue(false, '50')).toBe(50);
    expect(poolConcurrencyValue(true, '')).toBeNull();
    for (const value of ['', '0', '-1', '2.5', 'NaN']) expect(() => poolConcurrencyValue(false, value)).toThrow();
  });
});
