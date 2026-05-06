import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { NumberField } from '../components/NumberField';
import {
  api,
  UnauthorizedError,
  type AppConfig,
  type StorageEstimateBucket,
  type StorageEstimateResponse,
} from '../lib/api';
import { blockFoundSoundUrl } from '../lib/block-found-sound';
import { useDenomination } from '../lib/denomination';
import { formatAge } from '../lib/format';
import { LOCALE_PRESETS, useLocale } from '../lib/locale';

// #98 - auto-save defaults on; toggle persists per-browser.
const AUTOSAVE_STORAGE_KEY = 'braiins.configAutoSave';
const AUTOSAVE_DEBOUNCE_MS = 800;

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
            help: t`0 = disabled. Example: 95 = activate cheap mode when the best ask on the orderbook is below 95% of the break-even hashprice from Ocean. Braiins matches pay-your-bid (the bid IS the price we pay), and the autopilot tracks the fillable ask plus a small overpay - so a cheap best ask reliably translates into a cheap bid.`,
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
        description: t`Where rented hashrate lands. Change only if your pool endpoint moves. The BTC payout address sits here too - the worker identity below is auto-derived from it whenever you edit the address, same as the first-run wizard.`,
        fields: [
          {
            key: 'destination_pool_url',
            label: t`Pool URL`,
            kind: 'text',
            help: t`Must be reachable from the public internet - Braiins probes it.`,
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
            help: t`Format: <btc-address>.<label>. Ocean TIDES credits shares by the address prefix - anything else routes shares to nobody.`,
            fullWidth: true,
          },
          {
            key: 'datum_api_url',
            label: t`Datum stats API (optional)`,
            kind: 'text',
            help: t`Optional. Datum Gateway's /umbrel-api endpoint - e.g. http://192.168.1.121:7152. Leave empty to disable; the Datum panel will show "not configured". See docs/setup-datum-api.md for the Umbrel-side port-exposure recipe.`,
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
        description: t`How big a single bid is. Set to 0 to use the full available wallet balance on each create - simpler mental model, no manual slicing.`,
        fields: [
          {
            key: 'bid_budget_sat',
            label: t`Per-bid budget`,
            kind: 'integer',
            unit: 'sat',
            fullWidth: true,
            help: t`0 = use the full available wallet balance each CREATE (clamped to 1 BTC - the Braiins per-bid hard cap). Any positive value pins every new bid to that exact amount regardless of balance.`,
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
            help: t`Pick a preset or paste your own template - at least one placeholder ({hash} or {height}) is required. Example custom: http://umbrel.local:3006/block/{hash}.`,
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
            help: t`"Autopilot only" sums consumed across bids the daemon has tagged in its ledger - accurate for what *this* autopilot has cost. "Whole account" sums counters_committed.amount_consumed_sat across every bid on /v1/spot/bid - covers active + historical bids (including any placed before the autopilot was switched on). May lag the latest hour of active-bid consumption.`,
          },
        ],
      },
      {
        id: 'btc-price-oracle',
        title: t`BTC price oracle`,
        description: t`Fetches the BTC/USD spot price from a public exchange API. Enables a sats/USD denomination toggle in the dashboard header. No API key required - uses unauthenticated public endpoints.`,
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
            help: t`Polled every 5 minutes. The daemon never makes decisions based on fiat price - this is purely a display convenience. Set to "Disabled" if you want a sats-only dashboard.`,
          },
        ],
      },
      {
        id: 'chart-smoothing',
        title: t`Chart smoothing`,
        description: t`Rolling-mean window applied to the hashrate chart. 1 = raw (no smoothing). Ocean is excluded - its /user_hashrate endpoint already returns a server-side 5-min average, so set these to 5 to line all three series up on the same cadence.`,
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
            help: t`Rolling-mean window for the Price chart's \`our bid\` and \`effective\` lines. Useful when the effective line is noisy at tick resolution. Hashprice / max bid are not smoothed - they're market-wide signals.`,
          },
          // `show_effective_rate_on_price_chart` and
          // `show_share_log_on_hashrate_chart` removed from the UI
          // here: both are now picked via the right-axis dropdown
          // above each chart on Status. Schema columns kept for
          // migration safety but are no longer read by the chart code.
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
            help: t`Compact numeric time series - one row per tick (~1,440/day) with hashrate, prices, share-log %, spend. This is what backs the Hashrate / Price / Overpay charts, so set it to the longest range you want to be able to chart. Cheap on disk: a year is ~525k small rows.`,
          },
          {
            key: 'decisions_uneventful_retention_days',
            label: t`Decisions log - uneventful`,
            kind: 'integer',
            unit: 'days',
            help: t`Decision-log rows where the autopilot proposed no action this tick (the vast majority). Heavy JSON state snapshots - the main disk-bloat lever, prune aggressively. The per-tick measurements (price, hashrate, share log) are still kept in tick_metrics regardless of this setting.`,
          },
          {
            key: 'decisions_eventful_retention_days',
            label: t`Decisions log - eventful`,
            kind: 'integer',
            unit: 'days',
            help: t`Decision-log rows where the autopilot proposed at least one bid action. Rare (~10% of ticks) and high-value: this is the forensic record for "why did the autopilot create / edit / cancel that bid?" Cheap to keep long.`,
          },
        ],
      },
      {
        id: 'block-found-sound',
        title: t`Block-found notification`,
        description: t`Play a sound when a new pool block is detected paying our payout address. Off by default. Pick one of the bundled cues, upload your own, or leave it disabled. The cue fires once per new reward_events row; the dashboard tab needs to be open.`,
        fields: [
          {
            key: 'block_found_sound',
            label: t`Sound`,
            kind: 'select',
            fullWidth: true,
            options: [
              { value: 'off', label: t`Off` },
              { value: 'cartoon-cowbell', label: t`Cartoon cowbell` },
              { value: 'glass-drop-and-roll', label: t`Glass drop & roll` },
              { value: 'metallic-clank-1', label: t`Metallic clank 1` },
              { value: 'metallic-clank-2', label: t`Metallic clank 2` },
              { value: 'custom', label: t`Custom (uploaded)` },
            ],
            help: t`Browsers block audio until the page sees a user click; logging in counts. The first poll after a fresh page load establishes a silent baseline so you don't get a sound for every backlog row.`,
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
  // #98 - page-load snapshot is the target Revert restores to. Set once
  // on the very first config load and never updated; subsequent server
  // refreshes (auto-save invalidations, manual saves) leave it alone so
  // Revert always means "discard everything I touched on this page
  // visit." `lastSavedSnapshot` tracks the most-recently-persisted draft
  // and drives the dirty/unsaved-changes indicator + the autosave
  // debounce gate.
  const [pageLoadSnapshot, setPageLoadSnapshot] = useState<AppConfig | null>(null);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<AppConfig | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [autoSave, setAutoSaveState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(AUTOSAVE_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const setAutoSave = (next: boolean) => {
    setAutoSaveState(next);
    try {
      window.localStorage.setItem(AUTOSAVE_STORAGE_KEY, String(next));
    } catch {
      /* private mode / quota - silently degrade to per-tab */
    }
  };

  // Initial-load only: seed draft + snapshots from the first config
  // payload. Guarded on `draft === null` so subsequent refetches (auto-
  // save invalidations especially) do not stomp the live form.
  useEffect(() => {
    if (query.data?.config && draft === null) {
      setDraft(query.data.config);
      setPageLoadSnapshot(query.data.config);
      setLastSavedSnapshot(query.data.config);
    }
  }, [query.data, draft]);

  const mutation = useMutation({
    mutationFn: async (cfg: AppConfig) => {
      const result = await api.updateConfig(cfg);
      // Force a tick immediately so any observe-time config (e.g.
      // datum_api_url, pool URL) produces fresh numbers before the
      // next interval fires. Without this, the Status page sits on
      // the last-tick snapshot for up to a full tick interval after
      // the save and the "nothing changed" feel is jarring. tick-now
      // is the same endpoint the manual operator button uses - safe
      // to call; best-effort so a tick failure doesn't mask the
      // successful save.
      try {
        await api.tickNow();
      } catch {
        /* best-effort - next regular tick will pick the change up */
      }
      return { result, savedDraft: cfg };
    },
    onSuccess: ({ savedDraft }) => {
      setError(null);
      setLastSavedSnapshot(savedDraft);
      setLastSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['status'] });
      qc.invalidateQueries({ queryKey: ['finance'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
      // btc_price_source lives on the config but the header's
      // DenominationToggle reads `btcPrice` off the `['btc-price']`
      // query - without this invalidation, enabling the oracle
      // wouldn't surface the sats/USD toggle until the next 5-min
      // poll or a page reload.
      qc.invalidateQueries({ queryKey: ['btc-price'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  // Dirty check by deep-equal of the JSON shape. AppConfig is a flat
  // object of primitives, so the stringify cost is trivial vs. a hand-
  // rolled equality. Falsy when either side is null (still loading).
  const isDirty =
    draft !== null &&
    lastSavedSnapshot !== null &&
    JSON.stringify(draft) !== JSON.stringify(lastSavedSnapshot);

  // #98 - debounced autosave. Fires AUTOSAVE_DEBOUNCE_MS after the last
  // edit, only when (a) auto-save is on, (b) the form is dirty vs the
  // last persisted draft, (c) no save is currently in flight, and
  // (d) the same dirty draft hasn't already errored on its previous
  // attempt (avoids retry-storming a Zod-rejected payload on every
  // keystroke during the debounce window). Cleanup cancels the pending
  // timer on every dependency change so a flurry of edits collapses
  // into one save.
  const lastAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSave) return;
    if (!draft || !isDirty) return;
    if (mutation.isPending) return;
    const draftKey = JSON.stringify(draft);
    if (mutation.isError && lastAttemptedRef.current === draftKey) return;
    const timer = window.setTimeout(() => {
      lastAttemptedRef.current = draftKey;
      mutation.mutate(draft);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, autoSave, isDirty, mutation]);

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
      // Auto-bind worker identity to the address - same shape as the
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
      <header className="sticky top-0 z-30 -mx-4 px-4 py-3 bg-slate-950/85 backdrop-blur border-b border-slate-800 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl text-slate-100">
            <Trans>Configuration</Trans>
          </h2>
          <p className="text-sm text-slate-500">
            {autoSave ? (
              <Trans>Auto-save on. Edits persist about a second after you stop typing.</Trans>
            ) : (
              <Trans>Auto-save off. Changes only persist when you click Save.</Trans>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveStatus
            isPending={mutation.isPending}
            isError={mutation.isError}
            errorMessage={(mutation.error as Error | null)?.message ?? null}
            isDirty={isDirty}
            lastSavedAt={lastSavedAt}
            autoSave={autoSave}
          />
          <label className="flex items-center gap-2 text-xs text-slate-300 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="accent-amber-400"
            />
            <Trans>auto-save</Trans>
          </label>
          <button
            onClick={() => pageLoadSnapshot && setDraft(pageLoadSnapshot)}
            disabled={mutation.isPending || pageLoadSnapshot === null || !isDirty}
            title={t`Restore the values that were on this page when you opened it.`}
            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-50"
          >
            <Trans>revert</Trans>
          </button>
          {!autoSave && (
            <button
              onClick={() => mutation.mutate(draft)}
              disabled={mutation.isPending || !isDirty}
              className="px-4 py-1.5 text-sm bg-amber-400 text-slate-900 font-medium rounded hover:bg-amber-300 disabled:opacity-50"
            >
              {mutation.isPending ? <Trans>saving…</Trans> : <Trans>save</Trans>}
            </button>
          )}
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
  const denomination = useDenomination();
  // Shares the cache key with Layout's 30s-interval status query, so
  // this is a dedupe, not an extra network call.
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status });
  const availableSat = statusQuery.data?.balances?.[0]?.available_balance_sat ?? null;
  const BRAIINS_MAX_AMOUNT_SAT = 100_000_000; // 1 BTC per-bid cap
  const isFullWallet = value === 0;
  const resolvedSat =
    availableSat !== null ? Math.min(availableSat, BRAIINS_MAX_AMOUNT_SAT) : null;

  // Active owned bid defers the next CREATE until it drains. Surface
  // that - without it, the "Currently ≈ X sat" figure reads as "what
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

  // Budget is sat-canonical in storage. The currency toggle changes
  // input scale: sats -> integer sat, BTC -> 8-decimal BTC. USD is
  // not a useful input mode (the operator's mental model is "I want
  // a 0.001 BTC budget", not "$104.50"), so we fall back to sat for
  // input when USD is the active toggle.
  const useBtc = denomination.mode === 'btc';
  const displayValue = useBtc ? (value ?? 0) / 100_000_000 : (value ?? 0);
  const suffix = useBtc ? '₿' : spec.unit;
  return (
    <label className="block">
      <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
      {/* Narrow input; hint below spans full panel width (fullWidth=true on
          the field spec makes the <label> a col-span-2 grid cell). */}
      <div className="max-w-[200px]">
        <NumberField
          value={displayValue}
          onChange={(n) => {
            const sat = useBtc ? Math.round(n * 100_000_000) : Math.round(n);
            onChange(spec.key, sat as never);
          }}
          step={useBtc ? 'any' : 'integer'}
          locale={locale}
          suffix={suffix}
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
                      A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat, capped at 1 BTC) will be used.
                    </Trans>
                  ) : (
                    <Trans>
                      A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat) will be used.
                    </Trans>
                  )
                ) : (
                  <Trans>
                    A bid is currently running (≈ {remainingSatStr} sat left). The next CREATE fires when it finishes - at that point the full available wallet balance will be used.
                  </Trans>
                )
              ) : resolvedSat !== null ? (
                isCapped ? (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat, capped at 1 BTC) will be used.
                  </Trans>
                ) : (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} sat) will be used.
                  </Trans>
                )
              ) : (
                <Trans>
                  A bid is currently running. The next CREATE fires when it finishes - at that point the full available wallet balance will be used.
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
        {section.id === 'log-retention' && (
          <LogRetentionTotalHint draft={draft} locale={locale} />
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
      {section.id === 'block-found-sound' && (
        <BlockFoundSoundExtras draft={draft} />
      )}
    </section>
  );
}

/**
 * Test-button + custom-upload addendum for the block-found-sound
 * section. Sits below the dropdown rendered by the standard `select`
 * field. Test plays whatever the dropdown currently points at (no
 * save required - audition before commit). Upload is JSON
 * base64-encoded to avoid pulling in @fastify/multipart for one
 * tiny one-shot upload.
 */
function BlockFoundSoundExtras({ draft }: { draft: AppConfig }) {
  const { i18n } = useLingui();
  void i18n;
  const choice = draft.block_found_sound;
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Whether a custom blob is currently on the daemon. Drives:
  //   - "Replace file…" vs "Choose file…" button label
  //   - Whether picking 'custom' from the dropdown auto-opens the
  //     OS file picker (auto-open only when no blob exists yet -
  //     a return visit shouldn't pop a dialog you didn't ask for)
  const blobStatus = useQuery({
    queryKey: ['block-found-sound-status'],
    queryFn: () => api.blockFoundSoundStatus(),
    staleTime: 30_000,
  });
  const hasBlob = blobStatus.data?.has_blob === true;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const prevChoiceRef = useRef<typeof choice>(choice);
  const queryClient = useQueryClient();

  // Auto-open the OS file picker when the user flips the dropdown to
  // 'custom' for the FIRST time (no blob uploaded yet). On return
  // visits with a blob already on file, picking 'custom' just makes
  // the existing sound active - they can use the visible "Replace
  // file…" button if they want to swap.
  useEffect(() => {
    if (prevChoiceRef.current !== 'custom' && choice === 'custom' && !hasBlob) {
      const t = setTimeout(() => fileRef.current?.click(), 0);
      prevChoiceRef.current = choice;
      return () => clearTimeout(t);
    }
    prevChoiceRef.current = choice;
    return undefined;
  }, [choice, hasBlob]);

  const playPreview = async () => {
    setUploadError(null);
    try {
      let src: string | null;
      let objectUrl: string | null = null;
      if (choice === 'custom') {
        // Custom sounds live behind an auth-gated /api route; HTML5
        // <audio> doesn't send Basic Auth, so the element gets 401
        // and reports "media resource not suitable". Fetch through
        // our authenticated path, wrap as a blob: URL, point the
        // element at that. Revoke after a short delay - long enough
        // for play() to lock the resource, short enough that we
        // don't leak handles across previews.
        objectUrl = await api.blockFoundSoundBlobUrl();
        src = objectUrl;
      } else {
        src = blockFoundSoundUrl(choice);
      }
      if (!src) return;
      const a = new Audio(src);
      a.play().catch((err: Error) => {
        setUploadError(`Audio play failed: ${err.message}`);
      });
      if (objectUrl) {
        // Wait for the audio to start before revoking; revoking
        // synchronously kills playback. 30s is well past any
        // sensible cue length.
        const toRevoke = objectUrl;
        setTimeout(() => URL.revokeObjectURL(toRevoke), 30_000);
      }
    } catch (err) {
      setUploadError(`Audio play failed: ${(err as Error).message}`);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadStatus(t`Uploading…`);
    try {
      if (file.size > 200 * 1024) {
        throw new Error(`File is ${(file.size / 1024).toFixed(0)} KB, max is 200 KB`);
      }
      const buf = await file.arrayBuffer();
      // Browser btoa won't take a binary string of arbitrary bytes;
      // walk the array in 8-bit chunks to build the base64 input.
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i] as number);
      }
      const b64 = btoa(bin);
      const resp = await api.uploadBlockFoundSound(b64, file.type || 'audio/mpeg', file.name || null);
      if (!resp.ok) {
        throw new Error(resp.error ?? 'unknown upload error');
      }
      setUploadStatus(t`Uploaded - now active.`);
      if (fileRef.current) fileRef.current.value = '';
      // Refresh the has-blob status so the button label flips from
      // "Choose file…" to "Replace file…" and the filename display
      // updates without a page reload.
      void queryClient.invalidateQueries({ queryKey: ['block-found-sound-status'] });
    } catch (err) {
      setUploadStatus(null);
      setUploadError((err as Error).message);
    }
  };

  const filename = blobStatus.data?.filename ?? null;
  const blobBytes = blobStatus.data?.bytes ?? null;
  const blobKb = blobBytes !== null ? (blobBytes / 1024).toFixed(1) : null;

  return (
    <div className="mt-2 space-y-3">
      {/* Hidden file input stays mounted so the auto-open useEffect
          above can call .click() on it. */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/mp3,audio/ogg,audio/wav,audio/x-wav,audio/webm"
        onChange={onUpload}
        className="hidden"
      />
      {/* Custom-upload row: button + filename info, tight under the
          dropdown. Only renders when 'custom' is the active choice. */}
      {choice === 'custom' && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="px-3 py-1 rounded border border-slate-700 text-slate-200 hover:bg-slate-800"
            >
              {hasBlob ? <Trans>Replace file…</Trans> : <Trans>Choose file…</Trans>}
            </button>
            {hasBlob && filename && blobKb && (
              <span className="text-slate-300">
                <Trans>Currently: <span className="font-mono">{filename}</span> ({blobKb} KB)</Trans>
              </span>
            )}
            {hasBlob && !filename && blobKb && (
              <span className="text-slate-400">
                <Trans>Currently: uploaded file ({blobKb} KB)</Trans>
              </span>
            )}
          </div>
          <p className="text-slate-500">
            <Trans>MP3 / OGG / WAV / WebM, max 200 KB.</Trans>
          </p>
          {uploadStatus && <p className="text-emerald-300">{uploadStatus}</p>}
          {uploadError && <p className="text-red-400">{uploadError}</p>}
        </div>
      )}
      {/* Test sound stays in its own border-separated row below. */}
      <div className="pt-3 border-t border-slate-800 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={playPreview}
          disabled={!choice || choice === 'off'}
          className={
            'px-3 py-1 rounded border ' +
            (!choice || choice === 'off'
              ? 'border-slate-700 text-slate-600 cursor-not-allowed'
              : 'border-slate-700 text-slate-200 hover:bg-slate-800')
          }
        >
          <Trans>Test sound</Trans>
        </button>
        <span className="text-slate-500"><Trans>Plays whatever's selected above (no save needed).</Trans></span>
      </div>
    </div>
  );
}

/**
 * Estimated cap on disk usage from current retention settings,
 * rendered under the section description. Reads
 * `/api/storage-estimate` (rows-per-day + bytes-per-row, sampled
 * server-side from recent rows). Excludes index overhead and SQLite
 * page padding, so it's a planning aid, not a guarantee.
 */
function LogRetentionTotalHint({
  draft,
  locale,
}: {
  draft: AppConfig;
  locale: string | undefined;
}) {
  const { i18n } = useLingui();
  void i18n;
  const query = useQuery({
    queryKey: ['storage-estimate'],
    queryFn: api.storageEstimate,
    staleTime: 60_000,
  });
  if (!query.data) return null;
  const total = retentionTotalBytes(draft, query.data);
  const dailyTotal = retentionDailyBytes(query.data);
  const totalStr = formatBytes(total, locale);
  const dailyStr = formatBytes(dailyTotal, locale);
  const dbStr =
    query.data.db_file_bytes !== null ? formatBytes(query.data.db_file_bytes, locale) : null;
  return (
    <p className="text-xs text-amber-300/80 mt-1">
      {dbStr !== null ? (
        <Trans>
          Estimated cap at current settings: ~ {totalStr} (logs only, indexes
          excluded). Logs grow ~ {dailyStr}/day. Database file is currently
          {' '}
          {dbStr}.
        </Trans>
      ) : (
        <Trans>
          Estimated cap at current settings: ~ {totalStr} (logs only, indexes
          excluded). Logs grow ~ {dailyStr}/day.
        </Trans>
      )}
    </p>
  );
}

function retentionTotalBytes(draft: AppConfig, est: StorageEstimateResponse): number {
  // 0 days = "keep forever", which we render as the daily growth rate
  // rather than a finite cap; it contributes 0 to the cap projection.
  return (
    bucketProjection(draft.tick_metrics_retention_days, est.tick_metrics) +
    bucketProjection(
      draft.decisions_uneventful_retention_days,
      est.decisions_uneventful,
    ) +
    bucketProjection(draft.decisions_eventful_retention_days, est.decisions_eventful)
  );
}

function retentionDailyBytes(est: StorageEstimateResponse): number {
  return (
    est.tick_metrics.rows_per_day * est.tick_metrics.bytes_per_row +
    est.decisions_uneventful.rows_per_day * est.decisions_uneventful.bytes_per_row +
    est.decisions_eventful.rows_per_day * est.decisions_eventful.bytes_per_row
  );
}

function bucketProjection(days: number, bucket: StorageEstimateBucket): number {
  if (days <= 0) return 0;
  return days * bucket.rows_per_day * bucket.bytes_per_row;
}

function formatBytes(n: number, locale: string | undefined): string {
  if (!Number.isFinite(n) || n <= 0) {
    return (0).toLocaleString(locale) + ' B';
  }
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (n < KB) return `${Math.round(n).toLocaleString(locale)} B`;
  if (n < MB)
    return `${(n / KB).toLocaleString(locale, { maximumFractionDigits: 1 })} KB`;
  if (n < GB)
    return `${(n / MB).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
  return `${(n / GB).toLocaleString(locale, { maximumFractionDigits: 2 })} GB`;
}

/**
 * Per-knob retention input with a dynamic "~ X/day · ~ Y at N days"
 * hint sourced from `/api/storage-estimate`. When days = 0 (keep
 * forever), shows daily growth without a finite cap.
 */
function RetentionField({
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
  const { i18n } = useLingui();
  void i18n;

  const query = useQuery({
    queryKey: ['storage-estimate'],
    queryFn: api.storageEstimate,
    staleTime: 60_000,
  });

  const bucket = pickBucketForKey(spec.key, query.data);
  const days = value ?? 0;
  const dailyBytes = bucket ? bucket.rows_per_day * bucket.bytes_per_row : null;
  const totalBytes = dailyBytes !== null && days > 0 ? dailyBytes * days : null;

  const dailyStr = dailyBytes !== null ? formatBytes(dailyBytes, locale) : null;
  const totalStr = totalBytes !== null ? formatBytes(totalBytes, locale) : null;
  const daysStr = days.toLocaleString(locale);

  return (
    <label className="block">
      <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
      <div className="max-w-[200px]">
        <NumberField
          value={value ?? 0}
          onChange={(n) => onChange(spec.key, n as never)}
          step="integer"
          locale={locale}
          suffix={spec.unit}
        />
      </div>
      {dailyStr !== null && (
        <span className="block text-xs text-amber-300/80 mt-1">
          {days === 0 ? (
            <Trans>No auto-prune; growing ~ {dailyStr}/day</Trans>
          ) : (
            <Trans>~ {dailyStr}/day · ~ {totalStr} at {daysStr} days</Trans>
          )}
        </span>
      )}
      {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
    </label>
  );
}

function pickBucketForKey(
  key: keyof AppConfig,
  data: StorageEstimateResponse | undefined,
): StorageEstimateBucket | undefined {
  if (!data) return undefined;
  if (key === 'tick_metrics_retention_days') return data.tick_metrics;
  if (key === 'decisions_uneventful_retention_days') return data.decisions_uneventful;
  if (key === 'decisions_eventful_retention_days') return data.decisions_eventful;
  return undefined;
}

/**
 * Per-browser display preferences. Lives outside the daemon-config
 * SECTIONS because it's local-only (saved to localStorage), not pushed
 * to the autopilot. Format-first labels - "1.234,56 · 16 apr 2026" -
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
            UI language. Saved locally - every operator can pick their own.
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
              Edit this in the <strong>Pool destination</strong> section above - the worker
              identity is auto-derived from it.
            </Trans>
          ) : (
            <Trans>
              Observing payouts to <span className="text-amber-400">(no address set)</span>. Edit
              this in the <strong>Pool destination</strong> section above - the worker identity
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
          <ElectrsFields draft={draft} locale={locale} onChange={onChange} />
        )}

        {/* Bitcoin Core RPC fields - always shown, not gated on the
            balance-check radio. These creds drive THREE features and
            only one of them is on-chain payouts: the BIP 110 crown
            marker on the Hashrate chart (#94) and the BIP 110 scan
            card on Status (#95) both call bitcoind even when Electrs
            is the selected payout backend. Hiding the fields when
            payout != bitcoind made the operator think BIP 110 was
            broken because the values that the scanner used were the
            saved (potentially stale) ones, with no UI to type fresh
            values into. */}
        <BitcoindRpcFields draft={draft} onChange={onChange} />
      </div>
    </section>
  );
}

function SaveStatus({
  isPending,
  isError,
  errorMessage,
  isDirty,
  lastSavedAt,
  autoSave,
}: {
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  isDirty: boolean;
  lastSavedAt: number | null;
  autoSave: boolean;
}) {
  // Tick once a minute so the "saved 3m ago" string ages without
  // requiring a re-render from elsewhere. Cheap; the indicator is
  // tiny and there is at most one of these on the page.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (isPending) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-300">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-slate-600 border-t-amber-300 animate-spin" />
        <Trans>saving…</Trans>
      </span>
    );
  }
  if (isError) {
    return (
      <span
        className="text-xs text-red-400 max-w-xs truncate"
        title={errorMessage ?? undefined}
      >
        <Trans>save failed:</Trans> {errorMessage}
      </span>
    );
  }
  if (isDirty && autoSave) {
    return (
      <span className="text-xs text-amber-300">
        <Trans>unsaved changes…</Trans>
      </span>
    );
  }
  if (isDirty && !autoSave) {
    return (
      <span className="text-xs text-amber-300">
        <Trans>unsaved changes</Trans>
      </span>
    );
  }
  if (lastSavedAt !== null) {
    return (
      <span className="text-xs text-slate-500">
        <Trans>saved {formatAge(lastSavedAt)}</Trans>
      </span>
    );
  }
  return null;
}

function ElectrsFields({
  draft,
  locale,
  onChange,
}: {
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;

  const test = useMutation({
    mutationFn: () =>
      api.electrsTest({
        host: (draft.electrs_host as string | null) ?? '',
        port: (draft.electrs_port as number | null) ?? 0,
      }),
  });

  return (
    <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_120px_auto] gap-x-3 gap-y-2 pt-1 items-start">
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
          <Trans>Port</Trans>
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
      <div className="self-start mt-[26px]">
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
        >
          {test.isPending ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
        </button>
      </div>
      {(test.data || test.isError) && (
        <div className="col-span-2 sm:col-span-3 text-xs font-mono break-words">
          {test.data && test.data.ok && (
            <span className="text-emerald-300">
              <Trans>OK</Trans> · <Trans>genesis version</Trans>{' '}
              {test.data.genesis_version ?? '?'}
            </span>
          )}
          {test.data && !test.data.ok && (
            <span className="text-red-400">{test.data.error}</span>
          )}
          {test.isError && (
            <span className="text-red-400">{(test.error as Error).message}</span>
          )}
        </div>
      )}
    </div>
  );
}

function BitcoindRpcFields({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;

  const test = useMutation({
    mutationFn: () =>
      api.bitcoindTest({
        url: draft.bitcoind_rpc_url ?? '',
        user: draft.bitcoind_rpc_user ?? '',
        password: draft.bitcoind_rpc_password ?? '',
      }),
  });

  return (
    <div className="pt-3 border-t border-slate-800 space-y-3">
      <header>
        <h4 className="text-xs uppercase tracking-wider text-slate-400">
          <Trans>Bitcoin Core RPC connection</Trans>
        </h4>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            Used by the on-chain payout balance check (when "Bitcoin Core RPC" is
            selected as the backend above), AND by the{' '}
            <a
              href="https://bip110.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:underline"
            >
              BIP 110
            </a>{' '}
            crown marker on the Hashrate chart and the BIP 110 scan card on Status
            - those last two call bitcoind regardless of which payout backend is
            selected. The Test button below validates the values currently in the
            form, before saving.
          </Trans>
        </p>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <label className="block sm:col-span-2">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Bitcoin Core RPC URL</Trans>
          </span>
          <div className="flex gap-2">
            <input
              type="text"
              value={draft.bitcoind_rpc_url ?? ''}
              onChange={(e) => onChange('bitcoind_rpc_url', e.target.value as never)}
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
            >
              {test.isPending ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
            </button>
          </div>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>e.g. http://192.168.1.121:8332 - your Bitcoin Core RPC endpoint.</Trans>
          </span>
          {test.data && test.data.ok && (
            <div className="mt-2 text-xs text-emerald-300 font-mono">
              <Trans>OK</Trans> · {test.data.chain ?? '?'} ·{' '}
              <Trans>blocks</Trans> {test.data.blocks?.toLocaleString() ?? '-'} ·{' '}
              <Trans>headers</Trans> {test.data.headers?.toLocaleString() ?? '-'}
            </div>
          )}
          {test.data && !test.data.ok && (
            <div className="mt-2 text-xs text-red-400 font-mono break-words">
              {test.data.error}
            </div>
          )}
          {test.isError && (
            <div className="mt-2 text-xs text-red-400 font-mono break-words">
              {(test.error as Error).message}
            </div>
          )}
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
            <Trans>RPC password - stored in the config database, not in logs.</Trans>
          </span>
        </label>
      </div>
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
  const { i18n } = useLingui();
  void i18n;
  const denomination = useDenomination();

  if (spec.key === 'bid_budget_sat' && spec.kind === 'integer') {
    return <BidBudgetField spec={spec} value={value as number} locale={locale} onChange={onChange} />;
  }

  if (
    spec.kind === 'integer' &&
    (spec.key === 'tick_metrics_retention_days' ||
      spec.key === 'decisions_uneventful_retention_days' ||
      spec.key === 'decisions_eventful_retention_days')
  ) {
    return <RetentionField spec={spec} value={value as number} locale={locale} onChange={onChange} />;
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
              <code className="text-slate-200">{addr}.</code> - otherwise Ocean credits shares
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
    // Ladder {min, step, 2·step, 3·step, …} - e.g. min=1, step=5 →
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
    // Storage stays sat/EH/day (canonical schema unit). Display +
    // edit follow the operator's toggles: sat|BTC currency × TH|PH|EH
    // hashrate unit. USD is intentionally not a price-input mode -
    // the operator's mental model is "I want overpay 300 sat", not
    // "$0.0000003"; if USD is selected we fall back to sat for the
    // input so the field stays usable. Nullable fields (e.g.
    // max_overpay_vs_hashprice) surface as 0; the daemon coerces 0
    // back to null on the save round-trip via the Zod schema so "0"
    // reads as "disabled".
    const raw = value as number | null;
    const useBtc = denomination.mode === 'btc';
    const unit = denomination.hashrateUnit;
    const unitFactor = unit === 'TH' ? 0.001 : unit === 'EH' ? 1000 : 1;
    // sat/EH/day -> sat/<unit>/day: scale-by-PH then by unitFactor.
    // sat/EH/day = 1000 × sat/PH/day, so divide by 1000 first.
    const satPerUnitDay = raw === null ? 0 : (raw / EH_PER_PH) * unitFactor;
    const displayValue = useBtc ? satPerUnitDay / 100_000_000 : satPerUnitDay;
    const suffix = useBtc ? `₿/${unit}/day` : `sat/${unit}/day`;
    // BTC needs many decimals to be usable for typical 47k sat/PH/day
    // values (~ 0.00047 ₿/PH/day); sat at TH needs 3 decimals to keep
    // single-tick spreads visible. Otherwise integer.
    const stepKind: 'integer' | 'any' =
      useBtc || unit === 'TH' ? 'any' : 'integer';
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <NumberField
          value={displayValue}
          onChange={(n) => {
            // Reverse the scaling chain to land back in sat/EH/day
            // for storage. n=0 means "disabled" -> store 0 (Zod
            // collapses to null where the schema permits).
            if (n <= 0) {
              onChange(spec.key, 0 as never);
              return;
            }
            const sat = useBtc ? n * 100_000_000 : n;
            const satPerPhDay = sat / unitFactor;
            const satPerEhDay = Math.round(satPerPhDay * EH_PER_PH);
            onChange(spec.key, satPerEhDay as never);
          }}
          step={stepKind}
          locale={locale}
          min={0}
          suffix={suffix}
        />
        {spec.help && <span className="block text-xs text-slate-500 mt-1">{spec.help}</span>}
      </label>
    );
  }

  // Hashrate fields (target / floor / cheap-target) - declared with
  // unit: 'PH/s'; scale display by the toggle but keep storage in PH/s.
  if (
    (spec.kind === 'decimal' || spec.kind === 'integer') &&
    spec.unit === 'PH/s'
  ) {
    const raw = (value as number | null) ?? 0;
    const unit = denomination.hashrateUnit;
    const factor = unit === 'TH' ? 1000 : unit === 'EH' ? 0.001 : 1;
    const displayValue = raw * factor;
    const suffix = `${unit}/s`;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        <NumberField
          value={displayValue}
          onChange={(n) => onChange(spec.key, (n / factor) as never)}
          step="any"
          locale={locale}
          suffix={suffix}
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
