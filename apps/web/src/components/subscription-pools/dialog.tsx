import { useCallback, useMemo, useState } from 'react';

import { poolConcurrencyValue, type PoolUpstreamOption, type SubscriptionPoolView } from './data';
import { api, callApi } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { ChoiceGroup } from '../ui/choice-group';
import { DialogShell } from '../ui/dialog-shell';
import { Checkbox, Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SettingsCard, SettingsSwitch } from '../ui/settings-card';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Field, Text } = fluentComponents;

export function SubscriptionPoolDialog({ record, pools, upstreams, open, onOpenChange, onSaved }: {
  record: SubscriptionPoolView | null;
  pools: readonly SubscriptionPoolView[];
  upstreams: readonly PoolUpstreamOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [name, setName] = useState(record?.name ?? '');
  const [provider, setProvider] = useState<'codex' | 'claude-code'>(record?.provider ?? 'codex');
  const [enabled, setEnabled] = useState(record?.enabled ?? true);
  const [unlimited, setUnlimited] = useState(record?.max_concurrent_requests === null);
  const [limit, setLimit] = useState(String(record?.max_concurrent_requests ?? 50));
  const [members, setMembers] = useState<string[]>(record?.upstream_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const values = useMemo(() => ({ name, provider, enabled, unlimited, limit, members }), [name, provider, enabled, unlimited, limit, members]);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ values, onClose: close });
  const used = new Set(pools.filter(pool => pool.id !== record?.id).flatMap(pool => pool.upstream_ids));
  const options = upstreams.filter(upstream => upstream.kind === provider);

  const save = async () => {
    if (saving) return;
    if (!name.trim()) { setError(t('dashboard.subscriptionPools.validation.name')); return; }
    if (members.length === 0) { setError(t('dashboard.subscriptionPools.validation.members')); return; }
    const parsed = Number(limit);
    if (!unlimited && (limit.trim() === '' || !Number.isSafeInteger(parsed) || parsed < 1)) {
      setError(t('dashboard.subscriptionPools.validation.concurrency'));
      return;
    }
    const body = {
      name: name.trim(), provider, enabled, max_concurrent_requests: poolConcurrencyValue(unlimited, limit),
      upstream_ids: members,
    };
    setSaving(true);
    setError(null);
    const toast = toasts.start(t('dashboard.subscriptionPools.saving'));
    try {
      const result = record
        ? await callApi(() => api.api['subscription-pools'][':id'].$put({ param: { id: record.id }, json: body }))
        : await callApi(() => api.api['subscription-pools'].$post({ json: body }));
      if (result.error) {
        toast.settle();
        setError(result.error.message);
        return;
      }
      toast.succeed(t('dashboard.subscriptionPools.saved'));
      onOpenChange(false);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return <>{discardConfirmation}<DialogShell
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabled={saving} type="submit">{t('dashboard.subscriptionPools.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
    onSubmit={() => void save()}
    open={open}
    title={<DialogTitle>{t(record ? 'dashboard.subscriptionPools.edit' : 'dashboard.subscriptionPools.create')}</DialogTitle>}
    width="editor"
  >
    {error && <OutcomeMessageBar>{error}</OutcomeMessageBar>}
    <Field label={t('dashboard.subscriptionPools.name')}>
      <Input disabled={saving} maxLength={100} onChange={(_, data) => setName(data.value)} value={name} />
    </Field>
    <Field label={t('dashboard.subscriptionPools.provider')}>
      <ChoiceGroup
        ariaLabel={t('dashboard.subscriptionPools.provider')}
        disabled={saving}
        items={[{ value: 'codex', label: t('provider.codex') }, { value: 'claude-code', label: t('provider.claude-code') }]}
        onChange={value => {
          if (value !== 'codex' && value !== 'claude-code') throw new Error('Unsupported subscription pool provider');
          setProvider(value);
          setMembers([]);
        }}
        readOnly={record !== null}
        value={provider}
      />
    </Field>
    <SettingsCard
      action={<SettingsSwitch checked={enabled} disabled={saving} label={t('dashboard.subscriptionPools.enabled')} onChange={setEnabled} />}
      description={t('dashboard.subscriptionPools.enabledDescription')}
      header={t('dashboard.subscriptionPools.enabled')}
    />
    <Field label={t('dashboard.subscriptionPools.concurrency')}>
      <ChoiceGroup
        ariaLabel={t('dashboard.subscriptionPools.concurrency')}
        disabled={saving}
        items={[{ value: 'limited', label: t('dashboard.subscriptionPools.limited') }, { value: 'unlimited', label: t('dashboard.subscriptionPools.unlimited') }]}
        onChange={value => setUnlimited(value === 'unlimited')}
        value={unlimited ? 'unlimited' : 'limited'}
      />
    </Field>
    {!unlimited && <Field label={t('dashboard.subscriptionPools.limit')}>
      <Input disabled={saving} min={1} onChange={(_, data) => setLimit(data.value)} type="number" value={limit} />
    </Field>}
    <Text>{t('dashboard.subscriptionPools.concurrencyHint')}</Text>
    <div aria-label={t('dashboard.subscriptionPools.members')} className="grid gap-2" role="group">
      <Text weight="semibold">{t('dashboard.subscriptionPools.members')}</Text>
      {options.length === 0 && <Text>{t('dashboard.subscriptionPools.noAccounts')}</Text>}
      {options.map(upstream => <Checkbox
        checked={members.includes(upstream.id)}
        disabled={saving || used.has(upstream.id)}
        key={upstream.id}
        label={upstream.name}
        onChange={(_, data) => setMembers(current => data.checked
          ? [...current, upstream.id] : current.filter(id => id !== upstream.id))}
      />)}
    </div>
    <Text>{t('dashboard.subscriptionPools.membersHint')}</Text>
  </DialogShell></>;
}
