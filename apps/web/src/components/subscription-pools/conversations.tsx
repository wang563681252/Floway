import { useCallback, useMemo, useState } from 'react';

import { conversationReason, type ConversationCheck, type ConversationPage, type ConversationView, type SubscriptionPoolView } from './data';
import { api, callApi, callApiNoContent } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefreshOnChange } from '../ui/use-refresh';

const { Button, DialogActions, DialogTitle, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } = fluentComponents;

export function SubscriptionConversationsDialog({ pool, initialPage, open, onOpenChange, onChanged }: {
  pool: SubscriptionPoolView;
  initialPage: ConversationPage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [page, setPage] = useState(initialPage);
  const [offset, setOffset] = useState(initialPage.offset);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const closure = useDialogInvocation<ConversationView>();
  const query = useMemo(() => ({ offset }), [offset]);
  const load = useCallback(async (signal: AbortSignal) => {
    const result = await callApi(() => api.api['subscription-pools'][':id'].conversations.$get({
      param: { id: pool.id }, query: { offset: String(query.offset) },
    }, { init: { signal } }));
    if (signal.aborted) return false;
    if (result.error) { setError(result.error.message); return false; }
    setPage(result.data);
    setError(null);
    setDetail(null);
    return true;
  }, [pool.id, query.offset]);
  const restoreQuery = useCallback((value: { offset: number }) => setOffset(value.offset), []);
  const { refresh, refreshing } = useRefreshOnChange(query, 0, load, restoreQuery);
  const accountName = (id: string) => pool.accounts.find(account => account.upstream_id === id)?.name ?? t('dashboard.subscriptionPools.sessions.removedAccount');
  const check = async (conversation: ConversationView) => {
    if (busy || refreshing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await callApi(() => api.api['subscription-pools'][':id'].conversations[':conversationId'].check.$get({
        param: { id: pool.id, conversationId: conversation.id },
      }));
      if (result.error) setError(result.error.message);
      else setDetail(result.data);
    } finally { setBusy(false); }
  };
  const act = async (conversation: ConversationView, action: 'request-migration' | 'cancel-migration' | 'close') => {
    if (busy || refreshing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await callApiNoContent(() => api.api['subscription-pools'][':id'].conversations[':conversationId'].action.$post({
        param: { id: pool.id, conversationId: conversation.id },
        json: { action, expected_version: conversation.version, acknowledge_uncertain: action === 'close' && conversation.phase === 'uncertain' },
      }));
      if (result.error) { setError(result.error.message); return; }
      closure.close();
      await refresh();
      await onChanged();
    } finally { setBusy(false); }
  };

  return <>
    <DialogShell
      actions={<DialogActions>
        <Button disabled={busy || refreshing || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.page_size))}>{t('dashboard.subscriptionPools.sessions.previous')}</Button>
        <Button disabled={busy || refreshing || page.offset + page.page_size >= page.total} onClick={() => setOffset(page.offset + page.page_size)}>{t('dashboard.subscriptionPools.sessions.next')}</Button>
        <Button disabled={busy || refreshing} onClick={() => void refresh()}>{t('dashboard.subscriptionPools.refresh')}</Button>
        <Button disabled={busy} onClick={() => onOpenChange(false)}>{t('dashboard.subscriptionPools.sessions.dismiss')}</Button>
      </DialogActions>}
      onOpenChange={(_, data) => { if (!busy) onOpenChange(data.open); }}
      open={open}
      title={<DialogTitle>{t('dashboard.subscriptionPools.sessions.title', { name: pool.name })}</DialogTitle>}
      width="editor"
    >
      {error && <OutcomeMessageBar>{error}</OutcomeMessageBar>}
      <OutcomeMessageBar intent="info">{t('dashboard.subscriptionPools.sessions.hint')}</OutcomeMessageBar>
      <Text>{t('dashboard.subscriptionPools.sessions.count', { shown: String(page.conversations.length), total: String(page.total) })}</Text>
      <ScrollArea axes="horizontal">
        <Table aria-label={t('dashboard.subscriptionPools.sessions.table')}>
          <TableHeader><TableRow>
            {(['id', 'account', 'key', 'phase', 'activity', 'context', 'actions'] as const).map(column =>
              <TableHeaderCell key={column}>{t(`dashboard.subscriptionPools.sessions.columns.${column}`)}</TableHeaderCell>)}
          </TableRow></TableHeader>
          <TableBody>{page.conversations.map(conversation => <TableRow key={conversation.id}>
            <TableCell><Text block title={conversation.id} truncate wrap={false}>{conversation.id.slice(0, 12)}</Text></TableCell>
            <TableCell>{accountName(conversation.upstream_id)}</TableCell>
            <TableCell><Text block title={conversation.api_key_id} truncate wrap={false}>{conversation.api_key_id}</Text></TableCell>
            <TableCell>{t(`dashboard.subscriptionPools.sessions.phases.${conversation.phase}`)}</TableCell>
            <TableCell>{dateTime(conversation.last_seen_at, locale)}</TableCell>
            <TableCell>{t(conversation.portable ? 'dashboard.subscriptionPools.sessions.replayable' : 'dashboard.subscriptionPools.sessions.nonportable')}</TableCell>
            <TableCell><Button disabled={busy || refreshing} onClick={() => void check(conversation)}>{t('dashboard.subscriptionPools.sessions.check')}</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </ScrollArea>
      {page.total === 0 && <Text>{t('dashboard.subscriptionPools.sessions.empty')}</Text>}
      {detail && <Panel>
        <SectionHeader level={3} title={detail.conversation.id.slice(0, 12)} />
        <Text>{t('dashboard.subscriptionPools.sessions.detail', {
          version: String(detail.conversation.version), items: String(detail.conversation.context_items), migrations: String(detail.conversation.migrations),
        })}</Text>
        <Text>{t(`dashboard.subscriptionPools.sessions.reasons.${conversationReason(detail.conversation.blocked_reason)}`)}</Text>
        {detail.conversation.target_upstream_id !== null && <Text>{t('dashboard.subscriptionPools.sessions.pendingTarget', { name: accountName(detail.conversation.target_upstream_id) })}</Text>}
        <OutcomeMessageBar intent="info">{t('dashboard.subscriptionPools.sessions.precheckHint')}</OutcomeMessageBar>
        {detail.blockers.filter(reason => reason !== detail.conversation.blocked_reason).map(reason => <Text key={reason}>{t(`dashboard.subscriptionPools.sessions.reasons.${conversationReason(reason)}`)}</Text>)}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || refreshing || !detail.can_request_migration || detail.conversation.migration_requested}
            onClick={() => void act(detail.conversation, 'request-migration')}
          >{t('dashboard.subscriptionPools.sessions.requestMigration')}</Button>
          <Button disabled={busy || refreshing || !detail.conversation.migration_requested || ['preparing', 'dispatched', 'uncertain', 'closed'].includes(detail.conversation.phase)}
            onClick={() => void act(detail.conversation, 'cancel-migration')}
          >{t('dashboard.subscriptionPools.sessions.cancelMigration')}</Button>
          <Button disabled={busy || refreshing || !detail.can_close} onClick={() => closure.open(detail.conversation)}>{t('dashboard.subscriptionPools.sessions.close')}</Button>
        </div>
        <SectionHeader level={3} title={t('dashboard.subscriptionPools.sessions.history')} />
        {detail.history.length === 0 && <Text>{t('dashboard.subscriptionPools.none')}</Text>}
        {detail.history.map(migration => <Text key={migration.version}>{t('dashboard.subscriptionPools.sessions.historyEntry', {
          from: accountName(migration.fromUpstreamId), to: accountName(migration.toUpstreamId), time: dateTime(migration.occurredAt, locale),
        })}</Text>)}
      </Panel>}
    </DialogShell>
    {closure.invocation && <ConfirmDialog
      actionLabel={t(closure.invocation.value.phase === 'uncertain' ? 'dashboard.subscriptionPools.sessions.confirmStopped' : 'dashboard.subscriptionPools.sessions.close')}
      busy={busy}
      error={error}
      message={t(closure.invocation.value.phase === 'uncertain' ? 'dashboard.subscriptionPools.sessions.uncertainCloseHint' : 'dashboard.subscriptionPools.sessions.closeHint')}
      onConfirm={() => {
        const target = closure.invocation?.value;
        if (!target) throw new Error('Conversation close confirmation lost its target');
        void act(target, 'close');
      }}
      onOpenChange={value => { if (!value) closure.close(); }}
      open={closure.isOpen}
      title={t('dashboard.subscriptionPools.sessions.closeTitle')}
    />}
  </>;
}
