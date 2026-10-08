import { useCallback, useState } from 'react';

import type { Route } from './+types/dashboard-providers-subscription-pools';
import { requireDashboardAdmin } from './guards';
import { api, callApi, callApiNoContent } from '../api/client';
import { SubscriptionConversationsDialog } from '../components/subscription-pools/conversations';
import type { ConversationPage, PoolUpstreamOption, SubscriptionPoolView } from '../components/subscription-pools/data';
import { SubscriptionPoolDialog } from '../components/subscription-pools/dialog';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListEmptyState } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { SectionHeader } from '../components/ui/section-header';
import { SettingsSwitch } from '../components/ui/settings-card';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';
import { dateTime } from '../lib/format-time';
import { useLocale } from '../lib/use-locale';

const { Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } = fluentComponents;

interface LoaderData {
  pools: SubscriptionPoolView[] | null;
  upstreams: PoolUpstreamOption[] | null;
  error: string | null;
}

const loadData = async (previous: LoaderData, signal?: AbortSignal): Promise<LoaderData> => {
  const [pools, upstreams] = await Promise.all([
    callApi(() => api.api['subscription-pools'].$get(undefined, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get(undefined, { init: { signal } })),
  ]);
  return {
    pools: pools.error ? previous.pools : pools.data,
    upstreams: upstreams.error ? previous.upstreams : upstreams.data,
    error: pools.error?.message ?? upstreams.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadData({ pools: null, upstreams: null, error: null });
}

export default function DashboardProvidersSubscriptionPools({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [data, setData] = useState(loaderData);
  const [mutating, setMutating] = useState(false);
  const editor = useDialogInvocation<SubscriptionPoolView | null>();
  const deletion = useDialogInvocation<SubscriptionPoolView>();
  const conversations = useDialogInvocation<{ pool: SubscriptionPoolView; page: ConversationPage }>();
  const load = useCallback(async (signal: AbortSignal) => {
    const next = await loadData(data, signal);
    if (!signal.aborted) setData(next);
  }, [data]);
  const { refresh, refreshing } = useRefresh(load);
  const remove = async () => {
    const target = deletion.invocation?.value;
    if (!target || mutating) return;
    setMutating(true);
    const result = await callApiNoContent(() => api.api['subscription-pools'][':id'].$delete({ param: { id: target.id } }));
    setMutating(false);
    if (result.error) { setData(current => ({ ...current, error: result.error.message })); return; }
    deletion.close();
    await refresh();
  };
  const reset = async (pool: SubscriptionPoolView) => {
    if (mutating) return;
    setMutating(true);
    const result = await callApiNoContent(() => api.api['subscription-pools'][':id']['reset-cooldowns'].$post({ param: { id: pool.id } }));
    setMutating(false);
    if (result.error) setData(current => ({ ...current, error: result.error.message }));
    else await refresh();
  };
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const toggleIntake = async (pool: SubscriptionPoolView, upstreamId: string, accept: boolean) => {
    if (mutating) return;
    setMutating(true);
    try {
      const result = await callApiNoContent(() => api.api['subscription-pools'][':id'].members[':upstreamId'].$patch({
        param: { id: pool.id, upstreamId }, json: { accept_new_sessions: accept },
      }));
      if (result.error) setData(current => ({ ...current, error: result.error.message }));
      else await refresh();
    } finally { setMutating(false); }
  };
  const showConversations = async (pool: SubscriptionPoolView) => {
    if (mutating) return;
    setMutating(true);
    try {
      const result = await callApi(() => api.api['subscription-pools'][':id'].conversations.$get({ param: { id: pool.id }, query: { offset: '0' } }));
      if (result.error) setData(current => ({ ...current, error: result.error.message }));
      else conversations.open({ pool, page: result.data });
    } finally { setMutating(false); }
  };

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions
        createDisabled={data.pools === null || data.upstreams === null}
        createLabel={t('dashboard.subscriptionPools.create')}
        disabled={mutating}
        onCreate={() => editor.open(null)}
        onRefresh={() => void refresh()}
        refreshLabel={t('dashboard.subscriptionPools.refresh')}
        refreshing={refreshing}
      />}
      description={t('dashboard.subscriptionPools.description')}
      title={t('dashboard.subscriptionPools.title')}
    />
    {data.error && <OutcomeMessageBar>{data.error}</OutcomeMessageBar>}
    <OutcomeMessageBar intent="info">{t('dashboard.subscriptionPools.routingHint')}</OutcomeMessageBar>
    {data.pools?.length === 0 && <Panel><ResourceListEmptyState>{t('dashboard.subscriptionPools.empty')}</ResourceListEmptyState></Panel>}
    {data.pools?.map(pool => <Panel key={pool.id}>
      <SectionHeader
        actions={<div className="flex flex-wrap gap-2">
          <Button disabled={mutating} onClick={() => editor.open(pool)}>{t('dashboard.subscriptionPools.edit')}</Button>
          <Button disabled={mutating} onClick={() => void showConversations(pool)}>{t('dashboard.subscriptionPools.sessions.show')}</Button>
          <Button disabled={mutating} onClick={() => void reset(pool)}>{t('dashboard.subscriptionPools.reset')}</Button>
          <Button disabled={mutating} onClick={() => deletion.open(pool)}>{t('dashboard.subscriptionPools.delete')}</Button>
        </div>}
        description={`${t(`provider.${pool.provider}`)} · ${t(pool.enabled ? 'common.on' : 'common.off')} · ${pool.max_concurrent_requests === null
          ? t('dashboard.subscriptionPools.unlimited') : t('dashboard.subscriptionPools.limitReadout', { limit: String(pool.max_concurrent_requests) })}`}
        level={2}
        title={pool.name}
      />
      <ScrollArea axes="horizontal">
        <Table aria-label={t('dashboard.subscriptionPools.accounts')}>
          <TableHeader><TableRow>
            {(['account', 'health', 'inFlight', 'sessions', 'intake', 'quota', 'observed', 'cooldown'] as const).map(column =>
              <TableHeaderCell key={column}>{t(`dashboard.subscriptionPools.columns.${column}`)}</TableHeaderCell>)}
          </TableRow></TableHeader>
          <TableBody>{pool.accounts.map(account => <TableRow key={account.upstream_id}>
            <TableCell>{account.name}</TableCell>
            <TableCell>{account.enabled ? t(`dashboard.subscriptionPools.health.${account.health}`) : t('dashboard.subscriptionPools.health.disabled')}</TableCell>
            <TableCell>{account.in_flight}</TableCell>
            <TableCell>{account.recent_sessions}</TableCell>
            <TableCell><SettingsSwitch checked={account.accept_new_sessions} disabled={mutating}
              label={t('dashboard.subscriptionPools.intakeLabel', { name: account.name })}
              onChange={value => void toggleIntake(pool, account.upstream_id, value)}
            /></TableCell>
            <TableCell>{account.utilization === null ? t('dashboard.subscriptionPools.unknown') : percent.format(account.utilization)}</TableCell>
            <TableCell>{dateTime(account.quota_observed_at, locale)}</TableCell>
            <TableCell>
              {account.unavailable_until !== null && <Text>{dateTime(account.unavailable_until, locale)}</Text>}
              {account.cooldowns.map(cooldown => <div key={cooldown.modelKey}>
                <Text>{cooldown.modelKey}</Text><Text>{dateTime(cooldown.until, locale)}</Text>
              </div>)}
              {account.unavailable_until === null && account.cooldowns.length === 0 && t('dashboard.subscriptionPools.none')}
            </TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </ScrollArea>
    </Panel>)}
    {editor.invocation && data.pools && data.upstreams && <SubscriptionPoolDialog
      key={editor.invocation.key}
      onOpenChange={open => { if (!open) editor.close(); }}
      onSaved={refresh}
      open={editor.isOpen}
      pools={data.pools}
      record={editor.invocation.value}
      upstreams={data.upstreams}
    />}
    {conversations.invocation && <SubscriptionConversationsDialog
      key={conversations.invocation.key}
      initialPage={conversations.invocation.value.page}
      onChanged={refresh}
      onOpenChange={value => { if (!value) conversations.close(); }}
      open={conversations.isOpen}
      pool={conversations.invocation.value.pool}
    />}
    {deletion.invocation && <ConfirmDialog
      actionLabel={t('dashboard.subscriptionPools.delete')}
      busy={mutating}
      error={data.error}
      message={t('dashboard.subscriptionPools.deleteHint')}
      onConfirm={() => void remove()}
      onOpenChange={open => { if (!open) deletion.close(); }}
      open={deletion.isOpen}
      title={t('dashboard.subscriptionPools.deleteTitle', { name: deletion.invocation.value.name })}
    />}
  </section>;
}
