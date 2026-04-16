import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { NumberField } from '../components/NumberField';
import { api, UnauthorizedError, type AppConfig } from '../lib/api';
import { LOCALE_PRESETS, useLocale } from '../lib/locale';

const EH_PER_PH = 1000;

type Section = {
  title: string;
  description?: string;
  fields: FieldSpec[];
};

type FieldSpec = (
  | { key: keyof AppConfig; label: string; kind: 'decimal'; unit: string; help?: string }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'integer';
      unit: string;
      help?: string;
      noGrouping?: boolean;
    }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'price_sat_per_eh_day';
      help?: string;
    }
  | { key: keyof AppConfig; label: string; kind: 'text'; help?: string }
  | { key: keyof AppConfig; label: string; kind: 'boolean'; help?: string }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'radio';
      help?: string;
      options: ReadonlyArray<{ value: string; label: string; help?: string }>;
    }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'select';
      help?: string;
      options: ReadonlyArray<{ value: string; label: string }>;
    }
) & { fullWidth?: boolean };

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
    description:
      'Where rented hashrate lands. Change only if your pool endpoint moves.',
    fields: [
      {
        key: 'destination_pool_url',
        label: 'Pool URL',
        kind: 'text',
        help: 'Must be reachable from the public internet — Braiins probes it.',
        fullWidth: true,
      },
      {
        key: 'destination_pool_worker_name',
        label: 'Worker identity',
        kind: 'text',
        help: 'For Ocean TIDES this must be "<your BTC payout address>.<label>" — e.g. bc1qxyz….rig1. Without the address prefix your hashrate is credited to no one.',
        fullWidth: true,
      },
    ],
  },
  {
    title: 'Pricing caps',
    description: 'Hard ceilings on how much you are willing to pay. Entered in sat/PH/day (displayed natively).',
    fields: [
      {
        key: 'max_bid_sat_per_eh_day',
        label: 'Normal maximum',
        kind: 'price_sat_per_eh_day',
        help: 'Everyday ceiling. Above this we hibernate instead of bidding.',
      },
      {
        key: 'emergency_max_bid_sat_per_eh_day',
        label: 'Emergency maximum',
        kind: 'price_sat_per_eh_day',
        help: 'Higher cap allowed once we have been below floor for the emergency timer.',
      },
    ],
  },
  {
    title: 'Fill strategy',
    description:
      'Target price = min(fillable + max overpay, max bid). Fillable = depth-aware price at which your full target hashrate is available.',
    fields: [
      {
        key: 'overpay_sat_per_eh_day',
        label: 'Overpay',
        kind: 'price_sat_per_eh_day',
        help: 'How much above the fillable ask we bid. Target = fillable + this, capped by max bid. Not a maximum — every tick aims for exactly this overpay (the cap only kicks in if it would push us above max bid).',
      },
      {
        key: 'min_lower_delta_sat_per_eh_day',
        label: 'Min lower delta',
        kind: 'price_sat_per_eh_day',
        help: 'Deadband: only auto-lower when overpay vs target exceeds this. Avoids burning the Braiins 10-min cooldown for a few-sat saving.',
      },
      {
        key: 'escalation_mode',
        label: 'Escalation mode',
        kind: 'select',
        options: [
          { value: 'dampened', label: 'Dampened (step up slowly)' },
          { value: 'market', label: 'Market (jump to target)' },
        ],
        help: 'How to adjust upward when below floor. "Dampened" steps up by escalation step; "Market" jumps directly to target.',
      },
      {
        key: 'fill_escalation_step_sat_per_eh_day',
        label: 'Escalation step',
        kind: 'price_sat_per_eh_day',
        help: 'Raise the bid by this much per escalation window when stuck below floor (dampened mode only).',
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
    title: 'Daemon startup',
    description: 'How the daemon chooses its run mode when it boots.',
    fields: [
      {
        key: 'boot_mode',
        label: 'Boot mode',
        kind: 'radio',
        fullWidth: true,
        options: [
          {
            value: 'ALWAYS_DRY_RUN',
            label: 'Always dry-run (safest)',
            help: 'Every restart resets to DRY_RUN. You explicitly flip to LIVE from the dashboard.',
          },
          {
            value: 'LAST_MODE',
            label: 'Resume last mode',
            help: 'Keep whatever run mode was active before the restart. PAUSED is demoted to DRY_RUN.',
          },
          {
            value: 'ALWAYS_LIVE',
            label: 'Always live (for trusted deployments)',
            help: 'Boot directly into LIVE. Use only when the autopilot is proven and the box reboots should not interrupt bidding.',
          },
        ],
      },
    ],
  },
  {
    title: 'Bitcoin node (optional)',
    description:
      'Enter your BTC payout address to see what you have collected on-chain. Electrs is much faster and polled every minute; plain bitcoind uses scantxoutset (heavy) and is polled hourly.',
    fields: [
      {
        key: 'btc_payout_address',
        label: 'BTC payout address',
        kind: 'text',
        help: 'The same address used in your worker identity (bech32 only — bc1q… / bc1p…).',
        fullWidth: true,
      },
      {
        key: 'electrs_host',
        label: 'Electrs host (recommended)',
        kind: 'text',
        help: 'e.g. 192.168.1.121 or umbrel.local — leave empty to use bitcoind only.',
      },
      {
        key: 'electrs_port',
        label: 'Electrs port',
        kind: 'integer',
        unit: '',
        help: 'Default 50001.',
        noGrouping: true,
      },
    ],
  },
  {
    title: 'Money panel',
    description:
      'Controls how the Money panel computes the "spent" figure that feeds the net result.',
    fields: [
      {
        key: 'spent_scope',
        label: 'Spend scope',
        kind: 'select',
        options: [
          { value: 'autopilot', label: 'Autopilot only (autopilot-tagged bids)' },
          { value: 'account', label: 'Whole account (all settled bids ever)' },
        ],
        help: '"Autopilot only" sums consumed across bids the daemon has tagged in its ledger — accurate for what *this* autopilot has cost. "Whole account" sums every settlement on /v1/account/transaction — covers bids that existed before the autopilot was switched on, so it pairs honestly with Ocean\'s lifetime earnings.',
      },
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

  const mutation = useMutation({
    mutationFn: (cfg: AppConfig) => api.updateConfig(cfg),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
    onError: (err: Error) => setError(err.message),
  });

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

      <DisplaySettingsSection />

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
              <div
                key={f.key as string}
                className={f.fullWidth ? 'sm:col-span-2' : ''}
              >
                <Field spec={f} draft={draft} locale={intlLocale} onChange={update} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Per-browser display preferences. Lives outside the daemon-config
 * SECTIONS because it's local-only (saved to localStorage), not pushed
 * to the autopilot. Format-first labels — "1.234,56 · 16 apr 2026" —
 * because the picker controls *how numbers and dates look*, not the
 * UI language. UI strings stay English regardless until proper i18n
 * (#1) lands.
 */
function DisplaySettingsSection() {
  const { selected, setSelected } = useLocale();
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">Display</h3>
        <p className="text-xs text-slate-500 mt-1">
          How numbers and dates render in this browser. Doesn't change the
          UI language. Saved locally — every operator can pick their own.
        </p>
      </header>
      <label className="block max-w-md">
        <span className="block text-sm text-slate-300 mb-1">Number &amp; date format</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
        >
          {LOCALE_PRESETS.map((p) => (
            <option key={p.code} value={p.code}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="block text-xs text-slate-500 mt-1">
          "system default" follows your browser. The other entries lock
          to a specific format regardless of browser language.
        </span>
      </label>
    </section>
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

  if (spec.kind === 'radio') {
    const current = value as string;
    return (
      <fieldset>
        <legend className="block text-sm text-slate-300 mb-2">{spec.label}</legend>
        <div className="space-y-2">
          {spec.options.map((opt) => (
            <label
              key={opt.value}
              className={
                'flex items-start gap-2 p-2 rounded border cursor-pointer transition ' +
                (current === opt.value
                  ? 'border-amber-500 bg-amber-950/20'
                  : 'border-slate-800 hover:bg-slate-800/40')
              }
            >
              <input
                type="radio"
                name={spec.key as string}
                value={opt.value}
                checked={current === opt.value}
                onChange={() => onChange(spec.key, opt.value as never)}
                className="mt-1 accent-amber-400"
              />
              <span>
                <span className="text-sm text-slate-200">{opt.label}</span>
                {opt.help && (
                  <span className="block text-xs text-slate-500 mt-0.5">{opt.help}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        {spec.help && <span className="block text-xs text-slate-500 mt-2">{spec.help}</span>}
      </fieldset>
    );
  }

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

  if (spec.kind === 'select') {
    const current = value as string;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <select
          value={current}
          onChange={(e) => onChange(spec.key, e.target.value as never)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm"
        >
          {spec.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === 'text') {
    const v = (value as string | null) ?? '';
    // Ocean/TIDES worker-name sanity check: should be <btc-addr>.<label>.
    // Warn when the value has no period (no payout address prefix) —
    // that's the "worker mines but nobody gets credited" trap.
    const showWorkerWarning =
      spec.key === 'destination_pool_worker_name' && v.length > 0 && !v.includes('.');
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <input
          type="text"
          value={v}
          onChange={(e) => onChange(spec.key, e.target.value as never)}
          className={
            'w-full bg-slate-800 border rounded px-3 py-1.5 text-sm font-mono ' +
            (showWorkerWarning ? 'border-amber-600' : 'border-slate-700')
          }
        />
        {showWorkerWarning && (
          <span className="block text-xs text-amber-400 mt-1">
            ⚠ No period found. Ocean TIDES requires "&lt;BTC address&gt;.&lt;label&gt;".
            Without the address prefix, shares go uncredited.
          </span>
        )}
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
        value={(value as number | null) ?? 0}
        onChange={(n) => onChange(spec.key, n as never)}
        step={spec.kind === 'integer' ? 'integer' : 'any'}
        locale={locale}
        suffix={spec.unit}
        noGrouping={spec.kind === 'integer' && (spec as { noGrouping?: boolean }).noGrouping}
      />
      {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}
