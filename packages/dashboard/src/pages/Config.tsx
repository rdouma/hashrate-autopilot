import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { NumberField } from '../components/NumberField';
import { api, UnauthorizedError, type AppConfig } from '../lib/api';
import { LOCALE_PRESETS, useLocale } from '../lib/locale';

const EH_PER_PH = 1000;

type Section = {
  /** Stable English identity used for keys and structural decisions (e.g. inserting the payout-source card before "Profit & Loss"). The visible `title` is translated via `t\`...\``; this stays untranslated. */
  id: string;
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
      kind: 'integer_spinner';
      unit: string;
      help?: string;
      min: number;
      step: number;
    }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'price_sat_per_eh_day';
      help?: string;
    }
  | { key: keyof AppConfig; label: string; kind: 'text'; help?: string }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'text_with_presets';
      help?: string;
      presets: ReadonlyArray<{ label: string; template: string }>;
    }
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

function useSections(): Section[] {
  const { i18n } = useLingui();
  void i18n;
  return useMemo<Section[]>(
    () => [
      {
        id: 'hashrate-targets',
        title: t`Hashrate targets`,
        description: t`Where the autopilot aims, and the floor below which it starts escalating.`,
        fields: [
          { key: 'target_hashrate_ph', label: t`Target hashrate`, kind: 'decimal', unit: 'PH/s' },
          { key: 'minimum_floor_hashrate_ph', label: t`Minimum floor`, kind: 'decimal', unit: 'PH/s' },
          {
            key: 'cheap_target_hashrate_ph',
            label: t`Cheap-mode target`,
            kind: 'decimal',
            unit: 'PH/s',
            help: t`When the market is cheap (below the hashprice threshold), scale up to this target instead of the normal one. Set to 0 to disable.`,
          },
          {
            key: 'cheap_threshold_pct',
            label: t`Cheap threshold`,
            kind: 'integer',
            unit: '%',
            help: t`0 = disabled. Example: 95 = activate cheap mode when the best ask on the orderbook is below 95% of the break-even hashprice from Ocean. Under CLOB you pay the matched ask, so this is the price we can actually reach.`,
          },
          {
            key: 'cheap_sustained_window_minutes',
            label: t`Cheap-mode sustained window`,
            kind: 'integer',
            unit: 'min',
            help: t`Only engage cheap-mode when the rolling average of best-ask vs hashprice over this many minutes is below the threshold. Avoids flapping on single-tick market spikes. 0 = evaluate per tick (legacy). Requires ≥5 samples in the window before honouring it; below that falls back to the spot check.`,
          },
        ],
      },
      {
        id: 'pool-destination',
        title: t`Pool destination`,
        description: t`Where rented hashrate lands. Change only if your pool endpoint moves. The BTC payout address sits here too — the worker identity below is auto-derived from it whenever you edit the address, same as the first-run wizard.`,
        fields: [
          {
            key: 'destination_pool_url',
            label: t`Pool URL`,
            kind: 'text',
            help: t`Must be reachable from the public internet — Braiins probes it.`,
            fullWidth: true,
          },
          {
            key: 'btc_payout_address',
            label: t`BTC payout address`,
            kind: 'text',
            help: t`The BTC address Ocean TIDES credits payouts to. Editing this auto-updates the worker identity below.`,
            fullWidth: true,
          },
          {
            key: 'destination_pool_worker_name',
            label: t`Worker identity`,
            kind: 'text',
            help: t`Format: <btc-address>.<label>. Ocean TIDES credits shares by the address prefix — anything else routes shares to nobody.`,
            fullWidth: true,
          },
          {
            key: 'datum_api_url',
            label: t`Datum stats API (optional)`,
            kind: 'text',
            help: t`Optional. Datum Gateway's /umbrel-api endpoint — e.g. http://192.168.1.121:7152. Leave empty to disable; the Datum panel will show "not configured". See docs/setup-datum-api.md for the Umbrel-side port-exposure recipe.`,
            fullWidth: true,
          },
        ],
      },
      {
        id: 'pricing',
        title: t`Pricing`,
        description: t`The bid tracks the cheapest ask with enough depth for your target, plus a small premium. Two hard ceilings sit above that so the premium can never run away. Entered in sat/PH/day.`,
        fields: [
          {
            key: 'overpay_sat_per_eh_day',
            label: t`Overpay above fillable`,
            kind: 'price_sat_per_eh_day',
            help: t`Per-tick bid = fillable_ask + this. Braiins matches pay-your-bid, so this is the real premium you pay over the cheapest available price. Higher = more resilient to short upward market moves, bigger premium; lower = closer to the cheapest fillable price, more sensitive to noise. 300 sat/PH/day is a reasonable starting point.`,
          },
          {
            key: 'max_bid_sat_per_eh_day',
            label: t`Maximum`,
            kind: 'price_sat_per_eh_day',
            help: t`Hard ceiling. If fillable + overpay would exceed this, the bid is clamped down to this value (and may not fill).`,
          },
          {
            key: 'max_overpay_vs_hashprice_sat_per_eh_day',
            label: t`Max premium over hashprice`,
            kind: 'price_sat_per_eh_day',
            help: t`Optional dynamic ceiling. On each tick the effective cap = min(Maximum, hashprice + this). Stops the autopilot from wildly overpaying when hashprice drops sharply and the fixed Maximum alone would still allow it. Set to 0 to disable.`,
          },
        ],
      },
      {
        id: 'budget',
        title: t`Budget`,
        description: t`How big a single bid is. Set to 0 to use the full available wallet balance on each create — simpler mental model, no manual slicing.`,
        fields: [
          {
            key: 'bid_budget_sat',
            label: t`Per-bid budget`,
            kind: 'integer',
            unit: 'sat',
            fullWidth: true,
            help: t`0 = use the full available wallet balance each CREATE (clamped to 1 BTC — the Braiins per-bid hard cap). Any positive value pins every new bid to that exact amount regardless of balance.`,
          },
        ],
      },
      {
        id: 'daemon-startup',
        title: t`Daemon startup`,
        description: t`How the daemon chooses its run mode when it boots.`,
        fields: [
          {
            key: 'boot_mode',
            label: t`Boot mode`,
            kind: 'radio',
            fullWidth: true,
            options: [
              {
                value: 'ALWAYS_DRY_RUN',
                label: t`Always dry-run (safest)`,
                help: t`Every restart resets to DRY_RUN. You explicitly flip to LIVE from the dashboard.`,
              },
              {
                value: 'LAST_MODE',
                label: t`Resume last mode`,
                help: t`Keep whatever run mode was active before the restart. PAUSED is demoted to DRY_RUN.`,
              },
              {
                value: 'ALWAYS_LIVE',
                label: t`Always live (for trusted deployments)`,
                help: t`Boot directly into LIVE. Use only when the autopilot is proven and the box reboots should not interrupt bidding.`,
              },
            ],
          },
        ],
      },
      {
        id: 'block-explorer',
        title: t`Block explorer`,
        description: t`Used for click-through from the Ocean panel's "last pool block" row and the block-marker tooltips on the Hashrate chart. \`{hash}\` and \`{height}\` placeholders are substituted.`,
        fields: [
          {
            key: 'block_explorer_url_template',
            label: t`URL template`,
            kind: 'text_with_presets',
            fullWidth: true,
            help: t`Pick a preset or paste your own template — at least one placeholder ({hash} or {height}) is required. Example custom: http://umbrel.local:3006/block/{hash}.`,
            presets: [
              { label: 'mempool.space', template: 'https://mempool.space/block/{hash}' },
              { label: 'blockstream.info', template: 'https://blockstream.info/block/{hash}' },
              { label: 'blockchair.com', template: 'https://blockchair.com/bitcoin/block/{hash}' },
              { label: 'btcscan.org', template: 'https://btcscan.org/block/{hash}' },
              { label: 'btc.com', template: 'https://btc.com/btc/block/{hash}' },
            ],
          },
        ],
      },
      {
        id: 'profit-and-loss',
        title: t`Profit & Loss`,
        description: t`Controls how the P&L panel computes the "spent" figure that feeds the net result.`,
        sideBySide: true,
        fields: [
          {
            key: 'spent_scope',
            label: t`Spend scope`,
            kind: 'select',
            options: [
              { value: 'autopilot', label: t`Autopilot only (autopilot-tagged bids)` },
              { value: 'account', label: t`Whole account (all settled bids ever)` },
            ],
            help: t`"Autopilot only" sums consumed across bids the daemon has tagged in its ledger — accurate for what *this* autopilot has cost. "Whole account" sums counters_committed.amount_consumed_sat across every bid on /v1/spot/bid — covers active + historical bids (including any placed before the autopilot was switched on). May lag the latest hour of active-bid consumption.`,
          },
        ],
      },
      {
        id: 'btc-price-oracle',
        title: t`BTC price oracle`,
        description: t`Fetches the BTC/USD spot price from a public exchange API. Enables a sats/USD denomination toggle in the dashboard header. No API key required — uses unauthenticated public endpoints.`,
        sideBySide: true,
        fields: [
          {
            key: 'btc_price_source',
            label: t`Price source`,
            kind: 'select',
            options: [
              { value: 'none', label: t`Disabled (sats only)` },
              { value: 'coingecko', label: 'CoinGecko' },
              { value: 'coinbase', label: 'Coinbase' },
              { value: 'bitstamp', label: 'Bitstamp' },
              { value: 'kraken', label: 'Kraken' },
            ],
            help: t`Polled every 5 minutes. The daemon never makes decisions based on fiat price — this is purely a display convenience. Set to "Disabled" if you want a sats-only dashboard.`,
          },
        ],
      },
      {
        id: 'chart-smoothing',
        title: t`Chart smoothing`,
        description: t`Rolling-mean window applied to the hashrate chart. 1 = raw (no smoothing). Ocean is excluded — its /user_hashrate endpoint already returns a server-side 5-min average, so set these to 5 to line all three series up on the same cadence.`,
        fields: [
          {
            key: 'braiins_hashrate_smoothing_minutes',
            label: t`Braiins (delivered)`,
            kind: 'integer_spinner',
            unit: 'min',
            min: 1,
            step: 5,
          },
          {
            key: 'datum_hashrate_smoothing_minutes',
            label: t`Datum (received)`,
            kind: 'integer_spinner',
            unit: 'min',
            min: 1,
            step: 5,
          },
          {
            key: 'braiins_price_smoothing_minutes',
            label: t`Braiins (price, effective)`,
            kind: 'integer_spinner',
            unit: 'min',
            min: 1,
            step: 5,
            help: t`Rolling-mean window for the Price chart's \`our bid\` and \`effective\` lines. Useful when the effective line is noisy at tick resolution. Hashprice / max bid are not smoothed — they're market-wide signals.`,
          },
          {
            key: 'show_effective_rate_on_price_chart',
            label: t`Show effective rate on price chart`,
            kind: 'boolean',
            fullWidth: true,
            help: t`Off by default. The emerald effective-rate line (what Braiins actually charged, from counter deltas) is dramatically more volatile than bid / fillable / hashprice — when enabled it auto-scales the Y-axis and visibly squashes the finer bot movements into a thin band. The hero PRICE card and the AVG COST / PH DELIVERED stat already show the same number without hijacking the chart. Flip on when you want to eyeball settlement behaviour directly, accept the loss of flatter-line detail in exchange.`,
          },
          {
            key: 'show_share_log_on_hashrate_chart',
            label: t`Show share_log % on hashrate chart`,
            kind: 'boolean',
            fullWidth: true,
            help: t`Off by default. When enabled, the Hashrate chart renders our share of Ocean's TIDES window (share_log %) as a violet line on a right-side Y-axis labelled "% of Ocean", formatted to 4 decimals. Useful for tracking how our slice of the pool drifts as Ocean's total hashrate grows or our delivered PH/s fluctuates. The controller does not read this signal — display only.`,
          },
        ],
      },
      {
        id: 'log-retention',
        title: t`Log retention`,
        description: t`Two append-only logs back the dashboard. tick_metrics powers every chart; decisions is a per-tick forensic log split by whether the autopilot proposed any action. Pruning runs hourly and on daemon boot. 0 on any field = keep forever.`,
        fields: [
          {
            key: 'tick_metrics_retention_days',
            label: t`Tick metrics`,
            kind: 'integer',
            unit: 'days',
            fullWidth: true,
            help: t`Compact numeric time series — one row per tick (~1,440/day) with hashrate, prices, share-log %, spend. This is what backs the Hashrate / Price / Overpay charts, so set it to the longest range you want to be able to chart. Cheap on disk: a year is ~525k small rows.`,
          },
          {
            key: 'decisions_uneventful_retention_days',
            label: t`Decisions log — uneventful`,
            kind: 'integer',
            unit: 'days',
            help: t`Decision-log rows where the autopilot proposed no action this tick (the vast majority). Heavy JSON state snapshots — the main disk-bloat lever, prune aggressively. The per-tick measurements (price, hashrate, share log) are still kept in tick_metrics regardless of this setting.`,
          },
          {
            key: 'decisions_eventful_retention_days',
            label: t`Decisions log — eventful`,
            kind: 'integer',
            unit: 'days',
            help: t`Decision-log rows where the autopilot proposed at least one bid action. Rare (~10% of ticks) and high-value: this is the forensic record for "why did the autopilot create / edit / cancel that bid?" Cheap to keep long.`,
          },
        ],
      },
    ],
    // Re-derive when locale changes so all `t\`...\`` strings re-evaluate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.locale],
  );
}

export function Config() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();
  const { i18n } = useLingui();
  void i18n;
  const sections = useSections();

  const query = useQuery({ queryKey: ['config'], queryFn: api.config });

  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data?.config) setDraft(query.data.config);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: async (cfg: AppConfig) => {
      const result = await api.updateConfig(cfg);
      // Force a tick immediately so any observe-time config (e.g.
      // datum_api_url, pool URL) produces fresh numbers before the
      // next interval fires. Without this, the Status page sits on
      // the last-tick snapshot for up to a full tick interval after
      // the save and the "nothing changed" feel is jarring. tick-now
      // is the same endpoint the manual operator button uses — safe
      // to call; best-effort so a tick failure doesn't mask the
      // successful save.
      try {
        await api.tickNow();
      } catch {
        /* best-effort — next regular tick will pick the change up */
      }
      return result;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['status'] });
      qc.invalidateQueries({ queryKey: ['finance'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
      // btc_price_source lives on the config but the header's
      // DenominationToggle reads `btcPrice` off the `['btc-price']`
      // query — without this invalidation, enabling the oracle
      // wouldn't surface the sats/USD toggle until the next 5-min
      // poll or a page reload.
      qc.invalidateQueries({ queryKey: ['btc-price'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (!draft)
    return (
      <div className="text-slate-400">
        <Trans>loading…</Trans>
      </div>
    );

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    if (key === 'btc_payout_address') {
      // Auto-bind worker identity to the address — same shape as the
      // first-run wizard. When the operator edits the BTC payout
      // address, follow with `destination_pool_worker_name` if its
      // current value is the obvious "<oldAddr>.<label>" derivation
      // (or empty). Preserves any custom label the operator typed;
      // never silently overwrites a worker that intentionally points
      // at a different address.
      const nextAddr = typeof value === 'string' ? value : '';
      const oldAddr = (draft.btc_payout_address as string) ?? '';
      const oldWorker = (draft.destination_pool_worker_name as string) ?? '';
      const looksLikeOldDerivation =
        oldAddr.length > 0 && oldWorker.startsWith(oldAddr + '.');
      let nextWorker = oldWorker;
      if (looksLikeOldDerivation || oldWorker.length === 0) {
        const label =
          oldWorker.length > 0
            ? oldWorker.slice(oldAddr.length + 1) || 'autopilot'
            : 'autopilot';
        nextWorker = nextAddr.length > 0 ? `${nextAddr}.${label}` : '';
      }
      setDraft({
        ...draft,
        btc_payout_address: nextAddr,
        destination_pool_worker_name: nextWorker,
      });
      return;
    }
    setDraft({ ...draft, [key]: value });
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-24">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-2xl text-slate-100">
            <Trans>Configuration</Trans>
          </h2>
          <p className="text-sm text-slate-500">
            <Trans>All values live-editable. Save to apply.</Trans>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => query.data?.config && setDraft(query.data.config)}
            disabled={mutation.isPending}
            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-50"
          >
            <Trans>revert</Trans>
          </button>
          <button
            onClick={() => mutation.mutate(draft)}
            disabled={mutation.isPending}
            className="px-4 py-1.5 text-sm bg-amber-400 text-slate-900 font-medium rounded hover:bg-amber-300 disabled:opacity-50"
          >
            {mutation.isPending ? <Trans>saving…</Trans> : <Trans>save</Trans>}
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
          <Trans>saved.</Trans>
        </div>
      )}

      <DisplaySettingsSection />

      {(() => {
        const nodes: React.ReactNode[] = [];
        let i = 0;
        while (i < sections.length) {
          const section = sections[i] as Section;
          // Insert the custom payout-source section right before "Profit & Loss"
          if (section.id === 'profit-and-loss') {
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
            while (i < sections.length && (sections[i] as Section).sideBySide) {
              group.push(sections[i] as Section);
              i += 1;
            }
            const firstId = (group[0] as Section).id;
            nodes.push(
              <div
                key={`side-by-side-${firstId}`}
                className="grid grid-cols-1 sm:grid-cols-2 gap-6"
              >
                {group.map((s) => (
                  <SectionCard
                    key={s.id}
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
              key={section.id}
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

/**
 * Specialised renderer for `bid_budget_sat`. 0 is a sentinel meaning
 * "use the full available wallet balance per CREATE_BID" (#40); when
 * the user has that set, we surface the currently-resolved figure
 * live from the status query so the field isn't opaque.
 */
function BidBudgetField({
  spec,
  value,
  locale,
  onChange,
}: {
  spec: Extract<FieldSpec, { kind: 'integer' }>;
  value: number;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  // Shares the cache key with Layout's 30s-interval status query, so
  // this is a dedupe, not an extra network call.
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status });
  const availableSat = statusQuery.data?.balances?.[0]?.available_balance_sat ?? null;
  const BRAIINS_MAX_AMOUNT_SAT = 100_000_000; // 1 BTC per-bid cap
  const isFullWallet = value === 0;
  const resolvedSat =
    availableSat !== null ? Math.min(availableSat, BRAIINS_MAX_AMOUNT_SAT) : null;

  // Active owned bid defers the next CREATE until it drains. Surface
  // that — without it, the "Currently ≈ X sat" figure reads as "what
  // the autopilot will spend this tick" when actually no create will
  // fire until the running bid finishes.
  const activeOwnedBid = statusQuery.data?.bids?.find(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const activeRemainingSat = activeOwnedBid?.amount_remaining_sat ?? null;

  // Subscribe to locale changes so the t`...` strings below re-render.
  const { i18n } = useLingui();
  void i18n;

  // Pre-format the dynamic numeric pieces so the surrounding sentence
  // can stay inside one <Trans> for translator context, instead of
  // being shredded into a dozen string fragments.
  const remainingSatStr =
    activeRemainingSat !== null ? activeRemainingSat.toLocaleString(locale) : '';
  const resolvedSatStr = resolvedSat !== null ? resolvedSat.toLocaleString(locale) : '';
  const isCapped = availableSat !== null && availableSat > BRAIINS_MAX_AMOUNT_SAT;

  return (
    <label className="block">
      <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
      {/* Narrow input; hint below spans full panel width (fullWidth=true on
          the field spec makes the <label> a col-span-2 grid cell). */}
      <div className="max-w-[200px]">
        <NumberField
          value={value ?? 0}
          onChange={(n) => onChange(spec.key, n as never)}
          step="integer"
          locale={locale}
          suffix={spec.unit}
        />
      </div>
      {isFullWallet && (
        <span className="block text-xs text-amber-300 mt-1">
          {activeOwnedBid ? (
            <>
              {activeRemainingSat !== null && activeRemainingSat > 0 ? (
                resolvedSat !== null ? (
                  isCapped ? (
                    <Trans>
                      A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes — at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat, capped at 1 BTC) will be used.
                    </Trans>
                  ) : (
                    <Trans>
                      A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes — at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat) will be used.
                    </Trans>
                  )
                ) : (
                  <Trans>
                    A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes — at that point the full available wallet balance will be used.
                  </Trans>
                )
              ) : resolvedSat !== null ? (
                isCapped ? (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes — at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat, capped at 1 BTC) will be used.
                  </Trans>
                ) : (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes — at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat) will be used.
                  </Trans>
                )
              ) : (
                <Trans>
                  A bid is currently running. The next CREATE fires when it finishes — at that point the full available wallet balance will be used.
                </Trans>
              )}
            </>
          ) : (
            <>
              {resolvedSat !== null ? (
                isCapped ? (
                  <Trans>
                    Full wallet balance per bid. Currently ≈ {resolvedSatStr} sat (capped at 1 BTC).
                  </Trans>
                ) : (
                  <Trans>Full wallet balance per bid. Currently ≈ {resolvedSatStr} sat.</Trans>
                )
              ) : (
                <Trans>Full wallet balance per bid. Awaiting wallet balance from the daemon.</Trans>
              )}
            </>
          )}
        </span>
      )}
      {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
    </label>
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
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>Display</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            How numbers and dates render in this browser. Doesn't change the
            UI language. Saved locally — every operator can pick their own.
          </Trans>
        </p>
      </header>
      <label className="block max-w-md">
        <span className="block text-sm text-slate-300 mb-1">
          <Trans>Number &amp; date format</Trans>
        </span>
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
          <Trans>
            "system default" follows your browser. The other entries lock
            to a specific format regardless of browser language.
          </Trans>
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
  const { i18n } = useLingui();
  void i18n;

  const PAYOUT_OPTIONS: ReadonlyArray<{
    value: AppConfig['payout_source'];
    label: string;
    help: string;
  }> = [
    {
      value: 'none',
      label: t`Do not scan`,
      help: t`No on-chain balance tracking. The Profit & Loss panel won't show collected BTC.`,
    },
    {
      value: 'electrs',
      label: t`Electrs (recommended)`,
      help: t`Fast and lightweight. Polled every minute. Instant balance lookups via your Electrum server.`,
    },
    {
      value: 'bitcoind',
      label: t`Bitcoin Core RPC`,
      help: t`Uses scantxoutset -- CPU-heavy, 30+ seconds per scan. Polled hourly. Use only if you don't have Electrs.`,
    },
  ];

  const payoutAddr = (draft.btc_payout_address as string) ?? '';

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>On-chain payouts</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            How the daemon checks your BTC payout balance. Pick a backend and fill in the
            connection details. Requires a restart to take effect.
          </Trans>
        </p>
      </header>

      <div className="space-y-4">
        {/* BTC payout address is now edited in the Pool destination
            section (so the auto-bound worker identity sits next to it).
            Show a read-only mirror here so the operator can confirm
            which address this section is observing. */}
        <div className="bg-slate-900/40 border border-slate-800 rounded p-3 text-xs text-slate-400">
          {payoutAddr.length > 0 ? (
            <Trans>
              Observing payouts to <code className="text-slate-200 break-all">{payoutAddr}</code>.
              Edit this in the <strong>Pool destination</strong> section above — the worker
              identity is auto-derived from it.
            </Trans>
          ) : (
            <Trans>
              Observing payouts to <span className="text-amber-400">(no address set)</span>. Edit
              this in the <strong>Pool destination</strong> section above — the worker identity
              is auto-derived from it.
            </Trans>
          )}
        </div>

        {/* Source radio */}
        <fieldset>
          <legend className="block text-sm text-slate-300 mb-2">
            <Trans>Balance-check backend</Trans>
          </legend>
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
              <span className="block text-sm text-slate-300 mb-1">
                <Trans>Electrs host</Trans>
              </span>
              <input
                type="text"
                value={(draft.electrs_host as string | null) ?? ''}
                onChange={(e) => onChange('electrs_host', (e.target.value || null) as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                <Trans>e.g. 192.168.1.121 or umbrel.local</Trans>
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">
                <Trans>Electrs port</Trans>
              </span>
              <NumberField
                value={(draft.electrs_port as number | null) ?? 0}
                onChange={(n) => onChange('electrs_port', (n || null) as never)}
                step="integer"
                locale={locale}
                noGrouping
              />
              <span className="block text-xs text-slate-500 mt-1">
                <Trans>Default 50001.</Trans>
              </span>
            </label>
          </div>
        )}

        {/* Bitcoin Core RPC fields */}
        {source === 'bitcoind' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 pt-1">
            <label className="block sm:col-span-2">
              <span className="block text-sm text-slate-300 mb-1">
                <Trans>Bitcoin Core RPC URL</Trans>
              </span>
              <input
                type="text"
                value={draft.bitcoind_rpc_url ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_url', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                <Trans>e.g. http://192.168.1.121:8332 — your Bitcoin Core RPC endpoint.</Trans>
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">
                <Trans>RPC username</Trans>
              </span>
              <input
                type="text"
                value={draft.bitcoind_rpc_user ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_user', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                <Trans>RPC username from your bitcoin.conf.</Trans>
              </span>
            </label>
            <label className="block">
              <span className="block text-sm text-slate-300 mb-1">
                <Trans>RPC password</Trans>
              </span>
              <input
                type="password"
                value={draft.bitcoind_rpc_password ?? ''}
                onChange={(e) => onChange('bitcoind_rpc_password', e.target.value as never)}
                className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="block text-xs text-slate-500 mt-1">
                <Trans>RPC password — stored in the config database, not in logs.</Trans>
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
  const { i18n } = useLingui();
  void i18n;

  if (spec.key === 'bid_budget_sat' && spec.kind === 'integer') {
    return <BidBudgetField spec={spec} value={value as number} locale={locale} onChange={onChange} />;
  }

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
    // Two failure modes worth surfacing distinctly:
    //   1. No period at all → Ocean credits shares to nobody.
    //   2. Period exists but the prefix isn't the configured BTC payout
    //      address → Ocean credits shares to a *different* address
    //      (or nobody, if the typo'd prefix isn't a real address).
    // The second is the trap the operator hit in the wizard; mirror
    // the wizard's prefix-match check here so the regular Config
    // page is just as protective.
    const isWorker = spec.key === 'destination_pool_worker_name';
    const addr = (draft.btc_payout_address as string | null) ?? '';
    const noPeriod = isWorker && v.length > 0 && !v.includes('.');
    const prefixMismatch =
      isWorker &&
      v.length > 0 &&
      v.includes('.') &&
      addr.length > 0 &&
      !(v.startsWith(addr + '.') && v.length > addr.length + 1);
    const showWarning = noPeriod || prefixMismatch;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <input
          type="text"
          value={v}
          onChange={(e) => onChange(spec.key, e.target.value as never)}
          className={
            'w-full bg-slate-800 border rounded px-3 py-1.5 text-sm font-mono ' +
            (showWarning ? 'border-amber-600' : 'border-slate-700')
          }
        />
        {noPeriod && (
          <span className="block text-xs text-amber-400 mt-1">
            <Trans>
              ⚠ No period found. Ocean TIDES requires "&lt;BTC address&gt;.&lt;label&gt;".
              Without the address prefix, shares go uncredited.
            </Trans>
          </span>
        )}
        {prefixMismatch && (
          <span className="block text-xs text-red-400 mt-1 leading-snug">
            <Trans>
              <strong>Mismatch:</strong> the worker identity must start with{' '}
              <code className="text-slate-200">{addr}.</code> — otherwise Ocean credits shares
              to a different address (or nobody). Edit the BTC payout address above; this
              field follows it automatically.
            </Trans>
          </span>
        )}
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === 'text_with_presets') {
    const v = (value as string | null) ?? '';
    const activePreset = spec.presets.find((p) => p.template === v);
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <input
          type="text"
          value={v}
          onChange={(e) => onChange(spec.key, e.target.value as never)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
        />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {spec.presets.map((p) => {
            const active = p.template === v;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => onChange(spec.key, p.template as never)}
                className={
                  'px-2 py-0.5 rounded text-[11px] border ' +
                  (active
                    ? 'bg-slate-700 border-slate-500 text-slate-100'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-slate-200')
                }
              >
                {p.label}
              </button>
            );
          })}
          {!activePreset && v && (
            <span className="px-2 py-0.5 rounded text-[11px] border border-slate-700 bg-slate-900 text-slate-500 italic">
              <Trans>custom</Trans>
            </span>
          )}
        </div>
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === 'integer_spinner') {
    const current = ((value as number | null) ?? spec.min) as number;
    // Ladder {min, step, 2·step, 3·step, …} — e.g. min=1, step=5 →
    // 1, 5, 10, 15, 20… Native <input step=5 min=1> can't express
    // this because its step rule only yields min + n·step (→ 1, 6,
    // 11), so we drive the up/down with explicit buttons that call
    // the ladder helpers below. Typed values snap to the nearest
    // rung on blur.
    const stepUp = (n: number): number => {
      if (n < spec.step) return spec.step;
      return Math.floor(n / spec.step) * spec.step + spec.step;
    };
    const stepDown = (n: number): number => {
      if (n <= spec.step) return spec.min;
      return Math.ceil(n / spec.step) * spec.step - spec.step;
    };
    const snapToLadder = (n: number): number => {
      if (n <= spec.min) return spec.min;
      const multipleRung = Math.max(spec.step, Math.round(n / spec.step) * spec.step);
      return Math.abs(n - spec.min) < Math.abs(n - multipleRung) ? spec.min : multipleRung;
    };
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <div className="flex items-center gap-2">
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => onChange(spec.key, stepDown(current) as never)}
              disabled={current <= spec.min}
              className="px-2 bg-slate-800 border border-slate-700 rounded-l text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-sm"
              aria-label={t`decrease`}
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={current}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange(spec.key, snapToLadder(Math.round(n)) as never);
              }}
              className="bg-slate-800 border-t border-b border-slate-700 px-3 py-1.5 text-sm font-mono w-16 text-center"
            />
            <button
              type="button"
              onClick={() => onChange(spec.key, stepUp(current) as never)}
              className="px-2 bg-slate-800 border border-slate-700 rounded-r text-slate-300 hover:bg-slate-700 text-sm"
              aria-label={t`increase`}
            >
              +
            </button>
          </div>
          <span className="text-xs text-slate-500">{spec.unit}</span>
        </div>
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  if (spec.kind === 'price_sat_per_eh_day') {
    // Display + edit in sat/PH/day; store as sat/EH/day. Nullable
    // fields (e.g. max_overpay_vs_hashprice) surface as 0 in the
    // input; the daemon coerces 0 back to null on the save round-trip
    // via the config Zod schema so "0" reads as "disabled".
    const raw = value as number | null;
    const displayValue = raw === null ? 0 : raw / EH_PER_PH;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <NumberField
          value={displayValue}
          onChange={(n) =>
            onChange(spec.key, (n > 0 ? Math.round(n * EH_PER_PH) : 0) as never)
          }
          step="integer"
          locale={locale}
          min={0}
          suffix={t`sat/PH/day`}
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
