import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { NumberField } from '../components/NumberField';
import { api, UnauthorizedError, type AppConfig } from '../lib/api';
import { LOCALE_PRESETS, useLocale } from '../lib/locale';

const EH_PER_PH = 1000;

type Section = {
  title: string;
  description?: string;
  fields: FieldSpec[];
  /** Render this section in a half-width column so an adjacent `sideBySide` section can sit next to it. */
  sideBySide?: boolean;
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
      {
        key: 'cheap_target_hashrate_ph',
        label: 'Cheap-mode target',
        kind: 'decimal',
        unit: 'PH/s',
        help: 'When the market is cheap (below the hashprice threshold), scale up to this target instead of the normal one. Set to 0 to disable.',
      },
      {
        key: 'cheap_threshold_pct',
        label: 'Cheap threshold',
        kind: 'integer',
        unit: '%',
        help: '0 = disabled. Example: 95 = activate cheap mode when the fillable ask is below 95% of the break-even hashprice from Ocean.',
      },
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
        label: 'Maximum',
        kind: 'price_sat_per_eh_day',
        help: 'Hard ceiling. Above this the autopilot silently skips the tick.',
      },
    ],
  },
  {
    title: 'Fill strategy',
    description:
      'Target price = min(fillable + overpay, max bid). Fillable = depth-aware price at which your full target hashrate is available.',
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
        help: 'How long below floor before escalating the bid price. Only applies when hashrate is below the configured floor.',
      },
      {
        key: 'lower_patience_minutes',
        label: 'Wait before lowering',
        kind: 'integer',
        unit: 'min',
        help: 'How long the autopilot must be continuously above floor before it will lower the bid price. Prevents chasing short market dips that reverse within minutes — each unnecessary lower burns the Braiins 10-min price-decrease cooldown.',
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
    title: 'Profit & Loss',
    description:
      'Controls how the P&L panel computes the "spent" figure that feeds the net result.',
    sideBySide: true,
    fields: [
      {
        key: 'spent_scope',
        label: 'Spend scope',
        kind: 'select',
        options: [
          { value: 'autopilot', label: 'Autopilot only (autopilot-tagged bids)' },
          { value: 'account', label: 'Whole account (all settled bids ever)' },
        ],
        help: '"Autopilot only" sums consumed across bids the daemon has tagged in its ledger — accurate for what *this* autopilot has cost. "Whole account" sums counters_estimate.amount_consumed_sat across every bid on /v1/spot/bid — covers active + historical bids (including any placed before the autopilot was switched on) and reflects in-flight consumption before the hourly settlement ledger catches up.',
      },
    ],
  },
  {
    title: 'BTC price oracle',
    description:
      'Fetches the BTC/USD spot price from a public exchange API. Enables a sats/USD denomination toggle in the dashboard header. No API key required — uses unauthenticated public endpoints.',
    sideBySide: true,
    fields: [
      {
        key: 'btc_price_source',
        label: 'Price source',
        kind: 'select',
        options: [
          { value: 'none', label: 'Disabled (sats only)' },
          { value: 'coingecko', label: 'CoinGecko' },
          { value: 'coinbase', label: 'Coinbase' },
          { value: 'bitstamp', label: 'Bitstamp' },
          { value: 'kraken', label: 'Kraken' },
        ],
        help: 'Polled every 5 minutes. The daemon never makes decisions based on fiat price — this is purely a display convenience. Set to "Disabled" if you want a sats-only dashboard.',
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
      qc.invalidateQueries({ queryKey: ['finance'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
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
    <div className="space-y-6 max-w-3xl mx-auto pb-24">
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

      {(() => {
        const nodes: React.ReactNode[] = [];
        let i = 0;
        while (i < SECTIONS.length) {
          const section = SECTIONS[i] as Section;
          // Insert the custom payout-source section right before "Profit & Loss"
          if (section.title === 'Profit & Loss') {
            nodes.push(
              <PayoutSourceSection
                key="payout-source"
                draft={draft}
                locale={intlLocale}
                onChange={update}
              />,
            );
          }
          // Group consecutive sideBySide sections into one row.
          if (section.sideBySide) {
            const group: Section[] = [];
            while (i < SECTIONS.length && (SECTIONS[i] as Section).sideBySide) {
              group.push(SECTIONS[i] as Section);
              i += 1;
            }
            const firstTitle = (group[0] as Section).title;
            nodes.push(
              <div
                key={`side-by-side-${firstTitle}`}
                className="grid grid-cols-1 sm:grid-cols-2 gap-6"
              >
                {group.map((s) => (
                  <SectionCard
                    key={s.title}
                    section={s}
                    draft={draft}
                    locale={intlLocale}
                    onChange={update}
                  />
                ))}
              </div>,
            );
            continue;
          }
          nodes.push(
            <SectionCard
              key={section.title}
              section={section}
              draft={draft}
              locale={intlLocale}
              onChange={update}
            />,
          );
          i += 1;
        }
        return nodes;
      })()}
    </div>
  );
}

function SectionCard({
  section,
  draft,
  locale,
  onChange,
}: {
  section: Section;
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  // In a side-by-side row each card is already half-width; use a single
  // column inside so the dropdown and its help text span the panel.
  const gridCls = section.sideBySide
    ? 'grid grid-cols-1 gap-y-3'
    : 'grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3';
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-full">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">{section.title}</h3>
        {section.description && (
          <p className="text-xs text-slate-500 mt-1">{section.description}</p>
        )}
      </header>
      <div className={gridCls}>
        {section.fields.map((f) => (
          <div
            key={f.key as string}
            className={!section.sideBySide && f.fullWidth ? 'sm:col-span-2' : ''}
          >
            <Field spec={f} draft={draft} locale={locale} onChange={onChange} />
          </div>
        ))}
      </div>
    </section>
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

/**
 * Custom section for payout observation source selection. Replaces the
 * old flat "Bitcoin node (optional)" section with a radio-driven layout
 * that shows only the fields relevant to the selected backend.
 */
function PayoutSourceSection({
  draft,
  locale,
  onChange,
}: {
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const source = draft.payout_source;

  const PAYOUT_OPTIONS: ReadonlyArray<{
    value: AppConfig['payout_source'];
    label: string;
    help: string;
  }> = [
    {
      value: 'none',
      label: 'Do not scan',
      help: "No on-chain balance tracking. The Profit & Loss panel won't show collected BTC.",
    },
    {
      value: 'electrs',
      label: 'Electrs (recommended)',
      help: 'Fast and lightweight. Polled every minute. Instant balance lookups via your Electrum server.',
    },
    {
      value: 'bitcoind',
      label: 'Bitcoin Core RPC',
      help: 'Uses scantxoutset -- CPU-heavy, 30+ seconds per scan. Polled hourly. Use only if you don\'t have Electrs.',
    },
  ];

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">On-chain payouts</h3>
        <p className="text-xs text-slate-500 mt-1">
          How the daemon checks your BTC payout balance. Pick a backend and fill in the
          connection details. Requires a restart to take effect.
        </p>
      </header>

      <div className="space-y-4">
        {/* BTC payout address — always visible */}
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">BTC payout address</span>
          <input
            type="text"
            value={(draft.btc_payout_address as string) ?? ''}
            onChange={(e) => onChange('btc_payout_address', e.target.value as never)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <span className="block text-xs text-slate-500 mt-1">
            The same address used in your worker identity (bech32 only — bc1q... / bc1p...).
          </span>
        </label>

        {/* Source radio */}
        <fieldset>
          <legend className="block text-sm text-slate-300 mb-2">Balance-check backend</legend>
          <div className="space-y-2">
            {PAYOUT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={
                  'flex items-start gap-2 p-2 rounded border cursor-pointer transition ' +
                  (source === opt.value
                    ? 'border-amber-500 bg-amber-950/20'
                    : 'border-slate-800 hover:bg-slate-800/40')
                }
              >
                <input
                  type="radio"
                  name="payout_source"
                  value={opt.value}
                  checked={source === opt.value}
                  onChange={() => onChange('payout_source', opt.value as never)}
                  className="mt-1 accent-amber-400"
                />
                <span>
                  <span className="text-sm text-slate-200">{opt.label}</span>
                  <span className="block text-xs text-slate-500 mt-0.5">{opt.help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Electrs fields */}
        {source === 'electrs' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 pt-1">
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">Electrs host</span>
              <input
                type="text"
                value={(draft.electrs_host as string | null) ?? ''}
                onChange={(e) => onChange('electrs_host', (e.target.value || null) as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                e.g. 192.168.1.121 or umbrel.local
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">Electrs port</span>
              <NumberField
                value={(draft.electrs_port as number | null) ?? 0}
                onChange={(n) => onChange('electrs_port', (n || null) as never)}
                step="integer"
                locale={locale}
                noGrouping
              />
              <span className="block text-xs text-slate-500 mt-1">Default 50001.</span>
            </label>
          </div>
        )}

        {/* Bitcoin Core RPC fields */}
        {source === 'bitcoind' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 pt-1">
            <label className="block sm:col-span-2">
              <span className="block text-sm text-slate-300 mb-1">Bitcoin Core RPC URL</span>
              <input
                type="text"
                value={draft.bitcoind_rpc_url ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_url', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                e.g. http://192.168.1.121:8332 — your Bitcoin Core RPC endpoint.
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">RPC username</span>
              <input
                type="text"
                value={draft.bitcoind_rpc_user ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_user', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                RPC username from your bitcoin.conf.
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">RPC password</span>
              <input
                type="password"
                value={draft.bitcoind_rpc_password ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_password', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                RPC password — stored in the config database, not in logs.
              </span>
            </label>
          </div>
        )}
      </div>
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
