import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { NumberField } from '../components/NumberField';
import { api, UnauthorizedError, type AppConfig } from '../lib/api';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';

const EH_PER_PH = 1000;

type Section = {
  title: string;
  description?: string;
  fields: FieldSpec[];
};

type FieldSpec =
  | { key: keyof AppConfig; label: string; kind: 'decimal'; unit: string; help?: string }
  | { key: keyof AppConfig; label: string; kind: 'integer'; unit: string; help?: string }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'price_sat_per_eh_day';
      help?: string;
    }
  | { key: keyof AppConfig; label: string; kind: 'text'; help?: string }
  | { key: keyof AppConfig; label: string; kind: 'boolean'; help?: string };

const SECTIONS: Section[] = [
  {
    title: 'Hashrate targets',
    description: 'Where the autopilot aims, and the floor below which it starts escalating.',
    fields: [
      { key: 'target_hashrate_ph', label: 'Target hashrate', kind: 'decimal', unit: 'PH/s' },
      { key: 'minimum_floor_hashrate_ph', label: 'Minimum floor', kind: 'decimal', unit: 'PH/s' },
    ],
  },
  {
    title: 'Pool destination',
    description: 'Where rented hashrate lands. Change only if your pool endpoint moves.',
    fields: [
      { key: 'destination_pool_url', label: 'Pool URL', kind: 'text' },
      { key: 'destination_pool_worker_name', label: 'Worker name', kind: 'text' },
    ],
  },
  {
    title: 'Pricing caps',
    description: 'Hard ceilings on how much you are willing to pay. Entered in sat/PH/day (displayed natively).',
    fields: [
      {
        key: 'max_price_sat_per_eh_day',
        label: 'Normal maximum',
        kind: 'price_sat_per_eh_day',
        help: 'Everyday ceiling. Above this we hibernate instead of bidding.',
      },
      {
        key: 'emergency_max_price_sat_per_eh_day',
        label: 'Emergency maximum',
        kind: 'price_sat_per_eh_day',
        help: 'Higher cap allowed once we have been below floor for the emergency timer.',
      },
    ],
  },
  {
    title: 'Fill strategy',
    description:
      'How the autopilot competes in the orderbook: target = cheapest-available-ask + overpay allowance.',
    fields: [
      {
        key: 'max_overpay_vs_ask_sat_per_eh_day',
        label: 'Overpay vs cheapest ask',
        kind: 'price_sat_per_eh_day',
        help: 'If target exceeds cheapest-available-ask + this, we hibernate instead.',
      },
      {
        key: 'fill_escalation_step_sat_per_eh_day',
        label: 'Escalation step',
        kind: 'price_sat_per_eh_day',
        help: 'Raise the bid by this much per escalation window when stuck below floor.',
      },
      {
        key: 'fill_escalation_after_minutes',
        label: 'Escalation window',
        kind: 'integer',
        unit: 'min',
      },
      {
        key: 'hibernate_on_expensive_market',
        label: 'Hibernate when market is too expensive',
        kind: 'boolean',
        help: 'If target > normal cap, PAUSE instead of bidding. Uncheck to just wait quietly.',
      },
    ],
  },
  {
    title: 'Budget',
    description: 'How big a single bid is. Use the "days of runway" helper above to size this relative to market price.',
    fields: [
      { key: 'bid_budget_sat', label: 'Per-bid budget', kind: 'integer', unit: 'sat' },
      {
        key: 'monthly_budget_ceiling_sat',
        label: 'Monthly budget ceiling',
        kind: 'integer',
        unit: 'sat',
      },
    ],
  },
  {
    title: 'Alerts & timers',
    fields: [
      { key: 'below_floor_alert_after_minutes', label: 'Below-floor alert', kind: 'integer', unit: 'min' },
      {
        key: 'below_floor_emergency_cap_after_minutes',
        label: 'Emergency cap timer',
        kind: 'integer',
        unit: 'min',
      },
      {
        key: 'zero_hashrate_loud_alert_after_minutes',
        label: 'Zero-hashrate loud alert',
        kind: 'integer',
        unit: 'min',
      },
      {
        key: 'pool_outage_blip_tolerance_seconds',
        label: 'Pool outage blip tolerance',
        kind: 'integer',
        unit: 's',
      },
      {
        key: 'api_outage_alert_after_minutes',
        label: 'API outage alert',
        kind: 'integer',
        unit: 'min',
      },
      { key: 'wallet_runway_alert_days', label: 'Wallet runway alert', kind: 'integer', unit: 'days' },
    ],
  },
  {
    title: 'Quiet hours & 2FA',
    fields: [
      { key: 'quiet_hours_start', label: 'Quiet hours start (HH:MM)', kind: 'text' },
      { key: 'quiet_hours_end', label: 'Quiet hours end (HH:MM)', kind: 'text' },
      { key: 'quiet_hours_timezone', label: 'Timezone (IANA)', kind: 'text' },
      {
        key: 'confirmation_timeout_minutes',
        label: '2FA confirmation timeout',
        kind: 'integer',
        unit: 'min',
      },
      { key: 'handover_window_minutes', label: 'Handover window', kind: 'integer', unit: 'min' },
    ],
  },
  {
    title: 'Wiring',
    fields: [
      { key: 'btc_payout_address', label: 'BTC payout address', kind: 'text' },
      { key: 'telegram_chat_id', label: 'Telegram chat ID', kind: 'text' },
    ],
  },
];

export function Config() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();

  const query = useQuery({ queryKey: ['config'], queryFn: api.config });

  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data?.config) setDraft(query.data.config);
  }, [query.data]);

  const status = useQuery({ queryKey: ['status'], queryFn: api.status });

  const mutation = useMutation({
    mutationFn: (cfg: AppConfig) => api.updateConfig(cfg),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const [budgetDays, setBudgetDays] = useState<number>(0);

  const currentAskPricePerPh = status.data?.market?.best_ask_sat_per_ph_day ?? null;
  const computedBudgetSat = useMemo(() => {
    if (!draft) return null;
    if (!Number.isFinite(budgetDays) || budgetDays <= 0) return null;
    const price = currentAskPricePerPh ?? draft.max_price_sat_per_eh_day / EH_PER_PH;
    return Math.round(budgetDays * draft.target_hashrate_ph * price);
  }, [budgetDays, draft, currentAskPricePerPh]);

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (!draft) return <div className="text-slate-400">loading…</div>;

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setDraft({ ...draft, [key]: value });
  };

  return (
    <div className="space-y-6 max-w-4xl pb-24">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-2xl text-slate-100">Configuration</h2>
          <p className="text-sm text-slate-500">All values live-editable. Save to apply.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => query.data?.config && setDraft(query.data.config)}
            disabled={mutation.isPending}
            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-50"
          >
            revert
          </button>
          <button
            onClick={() => mutation.mutate(draft)}
            disabled={mutation.isPending}
            className="px-4 py-1.5 text-sm bg-amber-400 text-slate-900 font-medium rounded hover:bg-amber-300 disabled:opacity-50"
          >
            {mutation.isPending ? 'saving…' : 'save'}
          </button>
        </div>
      </header>

      {error && (
        <div className="bg-red-900/30 border border-red-800 text-red-200 rounded p-3 text-sm whitespace-pre-wrap">
          {error}
        </div>
      )}
      {mutation.isSuccess && !error && (
        <div className="bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded p-3 text-sm">
          saved.
        </div>
      )}

      <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-sm uppercase tracking-wider text-amber-400 mb-2">Budget helper</h3>
        <p className="text-xs text-slate-500 mb-3">
          How many days of runway do you want per bid? We'll size <code>bid_budget_sat</code> using
          current market price × {draft.target_hashrate_ph} PH/s target.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">days of runway</label>
            <NumberField
              value={budgetDays}
              onChange={setBudgetDays}
              locale={intlLocale}
              min={0}
              className="w-32"
            />
          </div>
          <div className="text-sm text-slate-300">
            →{' '}
            {computedBudgetSat === null
              ? '—'
              : `${formatNumber(computedBudgetSat, {}, intlLocale)} sat`}
            {currentAskPricePerPh && (
              <span className="block text-xs text-slate-500">
                at current cheapest ask{' '}
                {formatNumber(currentAskPricePerPh, {}, intlLocale)} sat/PH/day
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() =>
              computedBudgetSat !== null && update('bid_budget_sat', computedBudgetSat)
            }
            disabled={computedBudgetSat === null}
            className="px-3 py-1.5 text-xs border border-slate-700 text-slate-200 rounded hover:bg-slate-800 disabled:opacity-50"
          >
            apply to bid_budget_sat
          </button>
        </div>
      </section>

      {SECTIONS.map((section) => (
        <section key={section.title} className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <header className="mb-3">
            <h3 className="text-sm uppercase tracking-wider text-amber-400">{section.title}</h3>
            {section.description && (
              <p className="text-xs text-slate-500 mt-1">{section.description}</p>
            )}
          </header>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {section.fields.map((f) => (
              <Field
                key={f.key as string}
                spec={f}
                draft={draft}
                locale={intlLocale}
                onChange={update}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Field({
  spec,
  draft,
  locale,
  onChange,
}: {
  spec: FieldSpec;
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const value = draft[spec.key];

  if (spec.kind === 'boolean') {
    return (
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(spec.key, e.target.checked as never)}
          className="mt-1 accent-amber-400"
        />
        <span>
          <span className="text-sm text-slate-200">{spec.label}</span>
          {spec.help && <span className="block text-xs text-slate-500 mt-0.5">{spec.help}</span>}
        </span>
      </label>
    );
  }

  if (spec.kind === 'text') {
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <input
          type="text"
          value={value as string}
          onChange={(e) => onChange(spec.key, e.target.value as never)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
        />
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === 'price_sat_per_eh_day') {
    // Display + edit in sat/PH/day; store as sat/EH/day.
    const displayValue = (value as number) / EH_PER_PH;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <NumberField
          value={displayValue}
          onChange={(n) => onChange(spec.key, Math.round(n * EH_PER_PH) as never)}
          step="integer"
          locale={locale}
          min={0}
          suffix="sat/PH/day"
        />
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  return (
    <label className="block">
      <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
      <NumberField
        value={value as number}
        onChange={(n) => onChange(spec.key, n as never)}
        step={spec.kind === 'integer' ? 'integer' : 'any'}
        locale={locale}
        suffix={spec.unit}
      />
      {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}
