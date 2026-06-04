import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChartColorPicker } from '../components/ChartColorPicker';
import { NumberField } from '../components/NumberField';
import { SatSymbol } from '../components/SatSymbol';
import { StaleUrlBanner } from '../components/StaleUrlBanner';
import {
  CHART_COLOR_DEFAULTS,
  type ChartColorKey,
  getChartColor,
  parseOverrides,
  serializeOverrides,
} from '../lib/chartColors';
import {
  api,
  UnauthorizedError,
  type AlertSeverity,
  type AppConfig,
  type DatumTestResponse,
  type DdnsTestResponse,
  type PoolUrlTestResponse,
  type StorageEstimateBucket,
  type StorageEstimateResponse,
} from '../lib/api';
import { blockFoundSoundUrl } from '../lib/block-found-sound';
import { useDenomination } from '../lib/denomination';
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  formatAge,
  formatTimestampSample,
} from '../lib/format';
import {
  DATE_LAYOUT_PRESETS,
  NUMBER_LOCALE_PRESETS,
  useDateTimeLocale,
  useLocale,
  useTemperatureUnit,
  type DateLayout,
  type TemperatureUnit,
} from '../lib/locale';

// #98 - auto-save defaults on; toggle persists per-browser.
const AUTOSAVE_STORAGE_KEY = 'hashrate-autopilot.configAutoSave';
const AUTOSAVE_DEBOUNCE_MS = 800;

const EH_PER_PH = 1000;

type Section = {
  /** Stable English identity used for keys and structural decisions (e.g. inserting the payout-source card before "Profit & Loss"). The visible `title` is translated via `t\`...\``; this stays untranslated. */
  id: string;
  title: string;
  description?: React.ReactNode;
  fields: FieldSpec[];
  /** Render this section in a half-width column so an adjacent `sideBySide` section can sit next to it. */
  sideBySide?: boolean;
  /** Field grid column count at sm+ breakpoint. Defaults to 2. Use 3 for sections with three short related fields (e.g. chart-smoothing). */
  columns?: 2 | 3;
};

type FieldSpec = (
  | { key: keyof AppConfig; label: string; kind: 'decimal'; unit: React.ReactNode; help?: string }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'integer';
      unit: React.ReactNode;
      help?: string;
      noGrouping?: boolean;
    }
  | {
      key: keyof AppConfig;
      label: string;
      kind: 'integer_spinner';
      unit: React.ReactNode;
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
      presets: ReadonlyArray<{
        label: string;
        template: string;
        /** When set, picking this preset ALSO writes `template` to the named sibling field. Used by the block-explorer section to keep the block + tx URL templates in sync via a single preset click. */
        secondary?: { key: keyof AppConfig; template: string };
      }>;
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
        ],
      },
      {
        // #136: cheap-mode lifted into its own section with an
        // explicit enable checkbox. Was previously three fields
        // mixed into Hashrate Targets, with "set the threshold to 0
        // to disable" as the implicit on/off knob - operator found
        // that confusing.
        id: 'cheap-mode',
        title: t`Cheap mode`,
        description: t`When our bid drops below the break-even hashprice from Ocean, scale up to a higher target so we capture more hashrate while it's cheap. Tick "Enable cheap mode" to edit the fields below.`,
        fields: [
          {
            key: 'cheap_target_hashrate_ph',
            label: t`Cheap-mode target`,
            kind: 'decimal',
            unit: 'PH/s',
            help: t`When the bid is cheap (below the hashprice threshold), scale up to this target instead of the normal one.`,
          },
          {
            key: 'cheap_threshold_pct',
            label: t`Cheap threshold`,
            kind: 'integer',
            unit: '%',
            help: t`Example: 95 = activate cheap mode when our bid (fillable ask + overpay - the price we actually post under pay-your-bid) is below 95% of the break-even hashprice from Ocean. Compares our bid, not the order book's cheapest level - a cheap best-ask isn't useful if our overpay puts the bid above hashprice anyway.`,
          },
          {
            key: 'cheap_sustained_window_minutes',
            label: t`Cheap-mode sustained window`,
            kind: 'integer',
            unit: 'min',
            help: t`Only engage cheap-mode when every tick in the last N minutes had our bid below the threshold, and there are at least N ticks of complete data (one per minute at the 60 s cadence). Literal sustained-below: one outlier doesn't trigger, one missing tick keeps it off. 0 = per-tick spot check (legacy).`,
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
            help: t`Optional. The HTTP API exposed by Datum Gateway - e.g. http://192.168.1.121:7152. Leave empty to disable; the Datum panel will show "not configured".`,
            fullWidth: true,
          },
        ],
      },
      {
        id: 'pricing',
        title: t`Pricing`,
        description: <Trans>The bid tracks the cheapest ask with enough depth for your target, plus a small premium. Two hard ceilings sit above that so the premium can never run away. Entered in <SatSymbol />/PH/day.</Trans>,
        fields: [
          {
            key: 'overpay_sat_per_eh_day',
            label: t`Overpay above fillable`,
            kind: 'price_sat_per_eh_day',
            help: t`Per-tick bid = fillable_ask + this. Braiins matches pay-your-bid, so this is the real premium you pay over the cheapest available price. Higher = more cushion before the bid drifts under fillable on short upward market moves, bigger steady-state premium. Lower = closer to the cheapest fillable price and more frequent bid adjustments. The edit-price deadband is a percentage of this value (see Fee protection below).`,
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
        // #222: fee-protection section. Two knobs that together control
        // exposure to Braiins's marketplace fees (the marketplace is
        // currently in beta with fee_rate_pct = 0; this section is
        // pre-armed for the day that changes).
        id: 'fee-protection',
        title: t`Fee protection`,
        description: t`Braiins's marketplace fees are currently zero (beta). These two knobs pre-arm the autopilot for the day that changes: an automatic halt when fees exceed your comfort level, and a configurable edit deadband to keep the bid-adjustment count down.`,
        fields: [
          {
            key: 'max_acceptable_fee_pct',
            label: t`Max acceptable fee`,
            kind: 'decimal',
            unit: '%',
            help: t`When any active bid carries a fee_rate_pct above this, the mutation gate blocks CREATE_BID, EDIT_PRICE, and EDIT_SPEED. CANCEL_BID is still allowed so you (or the Datum-down auto-cancel) can bail out of a fee-bearing bid. Default 0 = halt the moment Braiins exits beta and charges any fee at all, matching the existing beta_exit Telegram alert. Set higher (e.g. 0.5) to tolerate a known fee without stopping the autopilot.`,
          },
          {
            key: 'bid_edit_deadband_pct',
            label: t`Edit-price deadband`,
            kind: 'decimal',
            unit: '%',
            help: t`Percentage of overpay below which the autopilot does NOT issue an EDIT_PRICE. Default 20 reproduces the legacy hard-coded behavior (overpay / 5). Raise to 50 to halve edit frequency and tolerate ~2x more price jitter before re-pricing - useful as a chart-noise reducer today, and as a per-edit-fee mitigation if Braiins ever introduces an EDIT fee. tick_size is always the hard floor; Braiins rejects sub-tick edits regardless.`,
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
            unit: <SatSymbol />,
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
        description: t`Used for click-through from the Ocean panel's "last pool block" row, block-marker tooltips on the Hashrate chart, and on-chain payout dots on the Price chart. Block links use \`{hash}\` / \`{height}\`; transaction links use \`{txid}\` / \`{hash}\`. Picking a preset sets both URLs at once.`,
        fields: [
          {
            key: 'block_explorer_url_template',
            label: t`Block URL template`,
            kind: 'text_with_presets',
            fullWidth: true,
            help: t`At least one placeholder ({hash} or {height}) is required. Example custom: http://umbrel.local:3006/block/{hash}.`,
            presets: [
              {
                label: 'mempool.space',
                template: 'https://mempool.space/block/{hash}',
                secondary: {
                  key: 'block_explorer_tx_url_template',
                  template: 'https://mempool.space/tx/{txid}',
                },
              },
              {
                label: 'blockstream.info',
                template: 'https://blockstream.info/block/{hash}',
                secondary: {
                  key: 'block_explorer_tx_url_template',
                  template: 'https://blockstream.info/tx/{txid}',
                },
              },
              {
                label: 'blockchair.com',
                template: 'https://blockchair.com/bitcoin/block/{hash}',
                secondary: {
                  key: 'block_explorer_tx_url_template',
                  template: 'https://blockchair.com/bitcoin/transaction/{txid}',
                },
              },
              {
                label: 'btcscan.org',
                template: 'https://btcscan.org/block/{hash}',
                secondary: {
                  key: 'block_explorer_tx_url_template',
                  template: 'https://btcscan.org/tx/{txid}',
                },
              },
              {
                label: 'btc.com',
                template: 'https://btc.com/btc/block/{hash}',
                secondary: {
                  key: 'block_explorer_tx_url_template',
                  template: 'https://btc.com/btc/transaction/{txid}',
                },
              },
            ],
          },
          {
            key: 'block_explorer_tx_url_template',
            label: t`Transaction URL template`,
            kind: 'text',
            fullWidth: true,
            help: t`At least one placeholder ({txid} or {hash}) is required. Auto-populated when you click a preset above; override here for custom self-hosted explorers (e.g. http://umbrel.local:3006/tx/{txid}).`,
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
        columns: 3,
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
        id: 'chart-markers',
        title: t`Chart markers`,
        description: t`Bid-event markers (CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL) on the price chart. The dashboard already hides them on long ranges (1w / 1m / 1y / All) where individual markers lose meaning; the cap below adds a count-based rule on top of that.`,
        fields: [
          {
            key: 'chart_max_markers',
            label: t`Max markers shown`,
            kind: 'integer',
            unit: 'markers',
            fullWidth: true,
            help: t`When more than this many markers would render on the price chart, the dashboard hides EDIT_PRICE markers first (CREATE / EDIT_SPEED / CANCEL stay because they're rare and diagnostic). If even after hiding EDIT_PRICE the count still exceeds the cap, all markers are hidden. 0 = no count-based filter (all markers render subject to the existing per-range rule). Useful at low-overpay settings where EDIT_PRICE fires every couple of minutes and clutters the chart.`,
          },
        ],
      },
      {
        id: 'log-retention',
        title: t`Log retention`,
        description: t`Three append-only logs back the dashboard: tick_metrics powers every chart, decisions is a per-tick forensic log split by whether the autopilot proposed any action, and alerts is the Telegram notification history. Pruning runs hourly and on daemon boot. 0 on any field = keep forever.`,
        fields: [
          // 2x2 layout per operator request:
          //   Row 1:  Tick metrics              │  Alerts
          //   Row 2:  Decisions - uneventful    │  Decisions - eventful
          // Tick metrics was previously full-width, leaving Alerts
          // alone on a row by itself.
          {
            key: 'tick_metrics_retention_days',
            label: t`Tick metrics`,
            kind: 'integer',
            unit: 'days',
            help: t`Compact numeric time series - one row per tick (~1,440/day) with hashrate, prices, share-log %, spend. This is what backs the Hashrate / Price / Overpay charts, so set it to the longest range you want to be able to chart. Cheap on disk: a year is ~525k small rows. Default 0 = keep forever.`,
          },
          {
            key: 'alerts_retention_days',
            label: t`Alerts`,
            kind: 'integer',
            unit: 'days',
            help: t`Telegram notification history. Small rows (just title + body strings); the in-flight retry ladder is preserved regardless of this setting - only resolved alerts (sent / failed / muted / gave_up) are eligible for pruning. Default 0 = keep forever.`,
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
            help: t`Decision-log rows where the autopilot proposed at least one bid action. Rare (~10% of ticks) and high-value: this is the forensic record for "why did the autopilot create / edit / cancel that bid?" Cheap to keep long. Default 0 = keep forever.`,
          },
        ],
      },
      {
        id: 'debug-api',
        title: t`Debug API`,
        description: t`Opt-in diagnostics endpoint. When enabled, GET /api/debug/dump returns a bundled JSON snapshot of tick_metrics, pool_blocks, alerts, bid_events, reward_events, config (safe fields only), and daemon info. Useful for remote triage - one curl gives you everything. When disabled (default), the endpoint returns 404.`,
        fields: [
          {
            key: 'debug_api_enabled',
            label: t`Enable debug API endpoint`,
            kind: 'boolean' as const,
            fullWidth: true,
            help: t`Flip this on, curl the endpoint, flip it back. Supports ?hours=N (default 24, max 168) and ?tables=tick_metrics, pool_blocks, alert_events, bid_events, reward_events, app_config, daemon_info to filter the response.`,
          },
        ],
      },
      {
        id: 'block-found-sound',
        title: t`Block-found notification`,
        description: t`Play a sound when a new pool block is detected paying our payout address. Off by default. Pick one of the bundled cues, upload your own, or leave it disabled. The cue fires once per new reward_events row; the dashboard tab needs to be open.`,
        // Sound select + Test button + custom-upload UI all live in
        // the BlockFoundSoundExtras component (so the Test button can
        // sit inline with the select, mirroring the Telegram section's
        // Test connection placement). FieldSpec list is empty for this
        // section.
        fields: [],
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
  }, [draft, autoSave, isDirty, mutation.isPending, mutation.isError]);

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
      {/* #113: same banner as on Status, mounted here too because the
          stale URL is a Config-page-side mistake the operator just
          made. */}
      <StaleUrlBanner />
      {/* #145: dropped `sticky top-0 z-30` - it collided with Layout's
          own sticky-top-0 z-30 nav cluster, and DOM-order put this
          header on top, occluding the global nav. The header now
          scrolls normally with the page (same behaviour as Status /
          Alerts). If sticky tab-row affordance is wanted back, build
          a tab-strip-only sticky inside Layout's sticky cluster so
          stacking is single-source. */}
      <header className="-mx-4 px-4 py-3 bg-slate-950/85 backdrop-blur border-b border-slate-800 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-auto sm:flex-1 sm:min-w-0">
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

      <ConfigTabsAndContent
        sections={sections}
        draft={draft}
        locale={intlLocale}
        onChange={update}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// #107: tabbed Config layout with cross-tab search.
// ---------------------------------------------------------------------------

type TabId = 'strategy' | 'pool' | 'notifications' | 'display';

const TAB_ORDER: TabId[] = ['strategy', 'pool', 'notifications', 'display'];

/**
 * Section IDs assigned to each tab. The order here is the visual order
 * within the tab. Custom sections (`payout-source`, `ddns`,
 * `notifications`) are rendered via ad-hoc components rather than the
 * generic SectionCard, so they share the namespace with regular section
 * IDs but get their own switch arm during rendering.
 */
const TAB_SECTIONS: Record<TabId, readonly string[]> = {
  // #222: fee-protection sits between pricing and budget - the two
  // knobs (max acceptable fee, edit deadband) modify the pricing
  // controller's behavior under marketplace fees.
  strategy: ['hashrate-targets', 'cheap-mode', 'pricing', 'fee-protection', 'budget', 'daemon-startup'],
  pool: ['pool-destination', 'ddns', 'payout-source', 'profit-and-loss', 'btc-price-oracle'],
  notifications: ['notifications', 'block-found-sound'],
  display: ['display-settings', 'chart-colors', 'solo-miners', 'block-explorer', 'chart-smoothing', 'chart-markers', 'log-retention', 'debug-api'],
};

function isTabId(s: string | null): s is TabId {
  return s === 'strategy' || s === 'pool' || s === 'notifications' || s === 'display';
}

function ConfigTabsAndContent({
  sections,
  draft,
  locale,
  onChange,
}: {
  sections: Section[];
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab: TabId = isTabId(searchParams.get('tab')) ? (searchParams.get('tab') as TabId) : 'strategy';

  const setActiveTab = (id: TabId) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const tabLabels: Record<TabId, string> = {
    strategy: t`Strategy`,
    pool: t`Pool & Payout`,
    notifications: t`Notifications`,
    display: t`Display & Logging`,
  };

  // Custom sections need synthetic title + searchable labels for the
  // search dropdown (they don't go through useSections).
  const customSectionMeta: Record<string, { title: string; labels: string[] }> = {
    'payout-source': {
      title: t`Payout source`,
      labels: [
        t`Bitcoin Knots RPC`,
        t`Electrs`,
        t`Disabled (no payout tracking)`,
        t`Include historical Ocean payouts in lifetime earnings`,
        t`Backfill now`,
        t`Pre-installation earnings`,
      ],
    },
    ddns: {
      title: t`Dynamic DNS`,
      labels: [
        t`Provider`,
        t`Hostname`,
        t`Username (DDNS Key user)`,
        t`Credential (DDNS Key password / token)`,
      ],
    },
    notifications: {
      title: t`Notifications`,
      labels: [t`Telegram bot token`, t`Chat ID`, t`Instance label (optional)`, t`Send messages to Telegram`, t`Retry interval`, t`Wallet runway below`, t`Ocean pool-block credited`],
    },
    'display-settings': {
      title: t`Display`,
      labels: [
        t`Number format`,
        t`Date layout`,
        t`Temperature unit`,
        // Aliases - operators search by unit name, not by control label.
        'Celsius',
        'Fahrenheit',
        '°C',
        '°F',
      ],
    },
    // #238: per-series chart color overrides. Aliased with the
    // hashrate / price / event series names so an operator searching
    // for "max bid color" or "right axis purple" lands here.
    'chart-colors': {
      title: t`Chart colors`,
      labels: [
        t`delivered (Braiins)`,
        t`received (Datum)`,
        t`received (Ocean)`,
        t`target`,
        t`floor`,
        t`our pool blocks`,
        t`other pool blocks`,
        t`Hashrate right-axis line`,
        t`our bid`,
        t`fillable`,
        t`hashprice`,
        t`max bid`,
        t`unpaid (sat)`,
        t`Price right-axis line`,
        t`create event marker`,
        t`edit-price event marker`,
        t`edit-speed event marker`,
        t`cancel event marker`,
        // Generic aliases — operators search by intent, not by series key.
        'right axis color',
        'purple',
        'palette',
        'theme',
      ],
    },
    // #154 follow-up: block-found-sound's title is indexed via
    // useSections() fallback (the section is declared there with
    // empty fields[]), but the visible "Sound" picker + bundled
    // sound names live in an ad-hoc extras component invisible to
    // the field-level indexer. Register them here so an operator
    // searching for "cowbell" / "sound" / "test" finds the row.
    'block-found-sound': {
      title: t`Block-found notification`,
      labels: [
        t`Sound`,
        t`Test sound`,
        t`Cartoon cowbell`,
        t`Glass drop & roll`,
        t`Metallic clank 1`,
        t`Metallic clank 2`,
        t`Ocean mining found a block (voice)`,
        t`Custom (uploaded)`,
        // Alias terms operators are likely to type.
        'audio',
        'upload',
      ],
    },
    'solo-miners': {
      title: t`Solo miners (Bitaxe / AxeOS)`,
      labels: [
        t`Enable solo-mining monitoring`,
        t`Devices`,
        t`Add device`,
        t`Scan local network`,
        t`Alert thresholds`,
        t`ASIC overheating ceiling (°C, 0 = auto per model)`,
        t`ASIC overheating ceiling (°F, 0 = auto per model)`,
        t`Zero-hashrate alert after (minutes)`,
        t`Share-rejection threshold (%)`,
        t`Share-rejection window (minutes)`,
        // Aliases - operators search by product family, not by control label.
        'Nerdaxe',
        'ESP-Miner',
      ],
    },
  };

  const [search, setSearch] = useState('');
  const [highlightedSectionId, setHighlightedSectionId] = useState<string | null>(null);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as Array<{ tabId: TabId; sectionId: string; sectionTitle: string; fieldLabel?: string }>;
    const out: Array<{ tabId: TabId; sectionId: string; sectionTitle: string; fieldLabel?: string }> = [];
    for (const tab of TAB_ORDER) {
      for (const sid of TAB_SECTIONS[tab]) {
        const std = sections.find((s) => s.id === sid);
        if (std) {
          if (std.title.toLowerCase().includes(q)) {
            out.push({ tabId: tab, sectionId: sid, sectionTitle: std.title });
          }
          for (const f of std.fields) {
            if (f.label.toLowerCase().includes(q)) {
              out.push({ tabId: tab, sectionId: sid, sectionTitle: std.title, fieldLabel: f.label });
            }
          }
          continue;
        }
        const meta = customSectionMeta[sid];
        if (meta) {
          if (meta.title.toLowerCase().includes(q)) {
            out.push({ tabId: tab, sectionId: sid, sectionTitle: meta.title });
          }
          for (const lbl of meta.labels) {
            if (lbl.toLowerCase().includes(q)) {
              out.push({ tabId: tab, sectionId: sid, sectionTitle: meta.title, fieldLabel: lbl });
            }
          }
        }
      }
    }
    return out.slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sections, i18n.locale]);

  const jumpTo = (tabId: TabId, sectionId: string) => {
    setActiveTab(tabId);
    setSearch('');
    // Wait for the tab's content to mount before scrolling/highlighting.
    setTimeout(() => {
      const el = document.querySelector(`[data-section-id="${sectionId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setHighlightedSectionId(sectionId);
        setTimeout(() => setHighlightedSectionId(null), 1800);
      }
    }, 60);
  };

  const wrapHighlight = (sid: string, child: React.ReactNode) => (
    <div
      key={sid}
      data-section-id={sid}
      className={
        highlightedSectionId === sid
          ? 'ring-2 ring-amber-400 rounded-lg transition-shadow duration-300'
          : 'transition-shadow duration-300'
      }
    >
      {child}
    </div>
  );

  const renderSection = (sid: string): React.ReactNode => {
    if (sid === 'payout-source') {
      return wrapHighlight(
        sid,
        <PayoutSourceSection draft={draft} locale={locale} onChange={onChange} />,
      );
    }
    if (sid === 'ddns') {
      return wrapHighlight(sid, <DdnsSection draft={draft} onChange={onChange} />);
    }
    if (sid === 'notifications') {
      return wrapHighlight(
        sid,
        <NotificationsSection draft={draft} locale={locale} onChange={onChange} />,
      );
    }
    if (sid === 'display-settings') {
      return wrapHighlight(sid, <DisplaySettingsSection />);
    }
    if (sid === 'chart-colors') {
      return wrapHighlight(sid, <ChartColorsSection draft={draft} onChange={onChange} />);
    }
    if (sid === 'solo-miners') {
      return wrapHighlight(sid, <SoloMinersSection draft={draft} onChange={onChange} />);
    }
    const std = sections.find((s) => s.id === sid);
    if (!std) return null;
    return wrapHighlight(
      sid,
      <SectionCard section={std} draft={draft} locale={locale} onChange={onChange} />,
    );
  };

  // Build the active tab's body. Honors sideBySide grouping for any
  // run of consecutive sections in the tab whose definitions are
  // marked sideBySide.
  const activeSectionIds = TAB_SECTIONS[activeTab];
  const body: React.ReactNode[] = [];
  for (let i = 0; i < activeSectionIds.length; ) {
    const sid = activeSectionIds[i] as string;
    const std = sections.find((s) => s.id === sid);
    if (std?.sideBySide) {
      const group: string[] = [];
      while (i < activeSectionIds.length) {
        const sCandidate = sections.find((s) => s.id === activeSectionIds[i]);
        if (!sCandidate?.sideBySide) break;
        group.push(activeSectionIds[i] as string);
        i += 1;
      }
      body.push(
        <div key={`side-by-side-${group[0]}`} className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {group.map((g) => renderSection(g))}
        </div>,
      );
      continue;
    }
    body.push(renderSection(sid));
    i += 1;
  }

  return (
    <div className="space-y-4">
      {/* Tab bar + search. On `sm+` they sit side-by-side on one row;
          on mobile the search drops below the tab strip at full width
          so the tabs get their own scrollable lane without competing
          for width with a 160px-wide search box. The bottom border
          spans the tab strip only (search is its own row on mobile)
          so the active-tab underline still anchors to it. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        {/* On mobile we wrap the tabs (so all four are visible at once
            as a 2x2 grid - the operator couldn't tell there was a
            fourth tab when the strip was a horizontally-scrolling lane).
            On sm+ we revert to single-row + horizontal scroll. The
            touch-action: pan-x on the scrolling variant kills the
            vertical-drag bug where the strip bounced under finger
            scroll on iOS. */}
        <div className="flex flex-wrap sm:flex-nowrap gap-0 border-b border-slate-700 sm:overflow-x-auto sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden sm:[touch-action:pan-x]">
          {TAB_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={
                activeTab === id
                  ? 'px-4 py-2 text-sm whitespace-nowrap text-amber-400 border-b-2 border-amber-400 -mb-px font-medium'
                  : 'px-4 py-2 text-sm whitespace-nowrap text-slate-300 hover:text-amber-300 border-b-2 border-transparent'
              }
            >
              {tabLabels[id]}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:pb-1 w-full sm:max-w-[12rem]">
          <input
            type="search"
            placeholder={t`Search settings...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm placeholder:text-slate-500"
          />
          {searchResults.length > 0 && (
            <div className="absolute z-10 right-0 mt-1 w-[28rem] max-w-[90vw] bg-slate-900 border border-slate-700 rounded shadow-xl max-h-80 overflow-y-auto">
              {searchResults.map((r, i) => (
                <button
                  key={`${r.tabId}-${r.sectionId}-${r.fieldLabel ?? ''}-${i}`}
                  type="button"
                  onClick={() => jumpTo(r.tabId, r.sectionId)}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-800 border-b border-slate-800 last:border-0"
                >
                  <span className="text-amber-400 text-xs uppercase tracking-wide">
                    {tabLabels[r.tabId]}
                  </span>
                  <span className="text-slate-500 mx-1.5">›</span>
                  <span className="text-slate-300">{r.sectionTitle}</span>
                  {r.fieldLabel && (
                    <>
                      <span className="text-slate-500 mx-1.5">›</span>
                      <span className="text-slate-100 font-medium">{r.fieldLabel}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active tab body. */}
      <div className="space-y-4">
        {/* All sections - standard + ad-hoc - flow through
            TAB_SECTIONS / renderSection so the cross-tab search
            index sees them. DisplaySettings + SoloMiners are
            registered as ad-hoc cases on the Display tab (#151).
            Rendering order for the Display tab follows
            TAB_SECTIONS.display, which puts display-settings +
            solo-miners first. */}
        {body}
      </div>
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
                      A bid is currently running (≈ {remainingSatStr} <SatSymbol /> left). The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} <SatSymbol />, capped at 1 BTC) will be used.
                    </Trans>
                  ) : (
                    <Trans>
                      A bid is currently running (≈ {remainingSatStr} <SatSymbol /> left). The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} <SatSymbol />) will be used.
                    </Trans>
                  )
                ) : (
                  <Trans>
                    A bid is currently running (≈ {remainingSatStr} <SatSymbol /> left). The next CREATE fires when it finishes - at that point the full available wallet balance will be used.
                  </Trans>
                )
              ) : resolvedSat !== null ? (
                isCapped ? (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} <SatSymbol />, capped at 1 BTC) will be used.
                  </Trans>
                ) : (
                  <Trans>
                    A bid is currently running. The next CREATE fires when it finishes - at that point the full available wallet balance (currently ≈ {resolvedSatStr} <SatSymbol />) will be used.
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
                    Full wallet balance per bid. Currently ≈ {resolvedSatStr} <SatSymbol /> (capped at 1 BTC).
                  </Trans>
                ) : (
                  <Trans>Full wallet balance per bid. Currently ≈ {resolvedSatStr} <SatSymbol />.</Trans>
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
  const cols = section.columns ?? 2;
  const gridCls = section.sideBySide
    ? 'grid grid-cols-1 gap-y-3'
    : cols === 3
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3'
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
      {section.id === 'cheap-mode' ? (
        <CheapModeBody
          section={section}
          draft={draft}
          locale={locale}
          onChange={onChange}
          gridCls={gridCls}
        />
      ) : (
        <div className={gridCls}>
          {section.fields.map((f) => (
            <div
              key={f.key as string}
              className={
                !section.sideBySide && f.fullWidth
                  ? cols === 3
                    ? 'sm:col-span-3'
                    : 'sm:col-span-2'
                  : ''
              }
            >
              <Field spec={f} draft={draft} locale={locale} onChange={onChange} />
            </div>
          ))}
        </div>
      )}
      {section.id === 'block-found-sound' && (
        <BlockFoundSoundExtras draft={draft} onChange={onChange} />
      )}
    </section>
  );
}

/**
 * #136: bespoke body for the Cheap-mode section. Adds an explicit
 * "Enable cheap mode" checkbox at the top, then renders the three
 * cheap-mode fields underneath - greyed + non-interactive when the
 * checkbox is off, fully editable when it's on.
 *
 * Storage stays on `cheap_threshold_pct`: 0 = off, > 0 = on. Toggle
 * derives `enabled = cheap_threshold_pct > 0` so we don't need a
 * new column or migration. Toggling on writes 95 (the long-standing
 * default the operator's been using); toggling off writes 0. The
 * tile pattern wallet_runway already established this approach.
 *
 * Greying uses `opacity-50 pointer-events-none` on the wrapper so
 * the inputs visibly read as disabled and clicks/keys can't reach
 * them - the existing `Field` component doesn't take a disabled
 * prop, and adding one would touch every field type. The wrapper
 * approach is one line and reverts cleanly when the operator
 * toggles back on.
 */
function CheapModeBody({
  section,
  draft,
  locale,
  onChange,
  gridCls,
}: {
  section: Section;
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
  gridCls: string;
}) {
  const enabled = draft.cheap_threshold_pct > 0;
  const toggle = (next: boolean) => {
    // On: write a sensible default. The operator's prior config
    // value was probably 95 (or whatever they last set); we don't
    // remember it across the off->on flip in the simple-derive
    // approach, so just write 95 every toggle-on. Operators who
    // ran a different threshold tweak it back manually.
    onChange('cheap_threshold_pct', (next ? 95 : 0) as never);
  };
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
          className="accent-amber-400 h-4 w-4"
        />
        <span className="text-sm text-slate-100 font-semibold">
          <Trans>Enable cheap mode</Trans>
        </span>
      </label>
      <div
        className={
          (enabled ? '' : 'opacity-50 pointer-events-none ') + gridCls
        }
        aria-disabled={!enabled}
      >
        {section.fields.map((f) => (
          <div key={f.key as string}>
            <Field spec={f} draft={draft} locale={locale} onChange={onChange} />
          </div>
        ))}
      </div>
    </div>
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
function BlockFoundSoundExtras({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
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

  const SOUND_OPTIONS: Array<{ value: AppConfig['block_found_sound']; label: string }> = [
    { value: 'off', label: t`Off` },
    { value: 'cartoon-cowbell', label: t`Cartoon cowbell` },
    { value: 'glass-drop-and-roll', label: t`Glass drop & roll` },
    { value: 'metallic-clank-1', label: t`Metallic clank 1` },
    { value: 'metallic-clank-2', label: t`Metallic clank 2` },
    { value: 'ocean-mining-found-block', label: t`Ocean mining found a block (voice)` },
    { value: 'custom', label: t`Custom (uploaded)` },
  ];

  return (
    <div className="space-y-3">
      {/* Hidden file input stays mounted so the auto-open useEffect
          above can call .click() on it. */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/mp3,audio/ogg,audio/wav,audio/x-wav,audio/webm"
        onChange={onUpload}
        className="hidden"
      />
      {/* Sound select + Test button on a single row, mirroring the
          Telegram section's Chat ID + Test connection layout. */}
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">
          <Trans>Sound</Trans>
        </span>
        <div className="flex flex-wrap gap-2">
          <select
            value={choice}
            onChange={(e) =>
              onChange(
                'block_found_sound',
                e.target.value as AppConfig['block_found_sound'],
              )
            }
            className="flex-1 min-w-[12rem] bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm"
          >
            {SOUND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={playPreview}
            disabled={!choice || choice === 'off'}
            className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
          >
            <Trans>Test sound</Trans>
          </button>
        </div>
        <span className="block text-xs text-slate-500 mt-1">
          <Trans>
            Browsers block audio until the page sees a user click; logging in
            counts. The first poll after a fresh page load establishes a silent
            baseline so you don't get a sound for every backlog row. Test plays
            whatever's selected above (no save needed).
          </Trans>
        </span>
      </label>
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
    bucketProjection(draft.decisions_eventful_retention_days, est.decisions_eventful) +
    bucketProjection(draft.alerts_retention_days, est.alerts)
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
  if (key === 'alerts_retention_days') return data.alerts;
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
/**
 * #147: two independent dropdowns - number-separator preset on the
 * left, date-layout preset on the right. Month-name *language*
 * follows the UI language picker (top-right of the header) and has
 * no control here on purpose: an English-UI operator who picks
 * European number separators still sees `Apr` / `May`, not
 * `apr` / `mei`.
 */
function DisplaySettingsSection() {
  const {
    numberLocale,
    dateLayout,
    temperatureUnit,
    setNumberLocale,
    setDateLayout,
    setTemperatureUnit,
  } = useLocale();
  const dateTimeLocale = useDateTimeLocale();
  // Fixed sample timestamp for the date-layout preview labels: 2026-04-16, 17:00.
  // Picked to match the spec's worked example so the picker reads
  // exactly like the issue body.
  const sampleMs = new Date(2026, 3, 16, 17, 0, 0).getTime();
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>Display</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            How numbers and dates render in this browser. Month names follow
            the UI language picker (top-right). Saved locally - every operator
            can pick their own.
          </Trans>
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Number format</Trans>
          </span>
          <select
            value={numberLocale}
            onChange={(e) => setNumberLocale(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          >
            {NUMBER_LOCALE_PRESETS.map((p) => (
              <option key={p.code} value={p.code}>
                {numberLocaleLabel(p.code, p.sample)}
              </option>
            ))}
          </select>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>Thousands and decimal separators.</Trans>
          </span>
        </label>
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Date layout</Trans>
          </span>
          <select
            value={dateLayout}
            onChange={(e) => setDateLayout(e.target.value as DateLayout)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          >
            {DATE_LAYOUT_PRESETS.map((layout) => (
              <option key={layout} value={layout}>
                {dateLayoutLabel(layout, sampleMs, dateTimeLocale)}
              </option>
            ))}
          </select>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>Order, separators, 12h vs 24h. Month names always follow your UI language.</Trans>
          </span>
        </label>
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Temperature unit</Trans>
          </span>
          <select
            value={temperatureUnit}
            onChange={(e) => setTemperatureUnit(e.target.value as TemperatureUnit)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          >
            <option value="system">{t`system default`}</option>
            <option value="C">{t`Celsius (°C)`}</option>
            <option value="F">{t`Fahrenheit (°F)`}</option>
          </select>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>ASIC and VR temperatures on the Status page, the right-axis temperature plot, and the overheating-ceiling threshold. Stored internally in °C; conversion happens at display only.</Trans>
          </span>
        </label>
      </div>
    </section>
  );
}

function numberLocaleLabel(code: string, sample: string): string {
  if (code === 'system') return t`system default`;
  if (code === 'no-grouping') return t`${sample} (no grouping)`;
  return sample;
}

function dateLayoutLabel(layout: DateLayout, sampleMs: number, uiLocale: string): string {
  if (layout === 'system') return t`system default`;
  return formatTimestampSample(sampleMs, uiLocale, layout);
}

/**
 * #149: Solo-mining section. Houses the master toggle plus the
 * operator-curated list of Bitaxe / AxeOS devices. When the master
 * toggle is off only the toggle + a one-line blurb render - the
 * device list, add-form, and threshold inputs only appear once the
 * feature is opted in. The toggle stays discoverable so operators
 * can find the feature; everything behind it is gated.
 *
 * Live snapshot of per-device readings comes from /api/solo-miners
 * (in-memory poller cache), refreshed on a 5s interval so adding
 * an IP and waiting one tick shows live values without a page reload.
 */

/**
 * #238: per-series chart color picker rows grouped by chart.
 * Each row shows the series label + a ChartColorPicker. Changes write
 * back into the draft's `chart_color_overrides` JSON string via the
 * shared onChange; the Save button at the page top commits.
 */
function ChartColorsSection({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const overrides = parseOverrides(draft.chart_color_overrides);
  const setColor = (key: ChartColorKey, next: string | null) => {
    const updated = { ...overrides };
    if (next === null) {
      delete updated[key];
    } else {
      updated[key] = next;
    }
    onChange('chart_color_overrides', serializeOverrides(updated));
  };
  const resetAll = () => onChange('chart_color_overrides', '{}');

  const groups: { title: string; rows: Array<{ key: ChartColorKey; label: string }> }[] = [
    {
      // Hashrate + price chart line series (left + right axis). All
      // continuously-drawn paths and area fills live here.
      title: t`Lines`,
      rows: [
        { key: 'hashrate.delivered', label: t`delivered (Braiins)` },
        { key: 'hashrate.received_datum', label: t`received (Datum)` },
        { key: 'hashrate.received_ocean', label: t`received (Ocean)` },
        { key: 'hashrate.target', label: t`target` },
        { key: 'hashrate.floor', label: t`floor` },
        { key: 'hashrate.right_axis', label: t`hashrate right-axis line` },
        { key: 'price.our_bid', label: t`our bid` },
        { key: 'price.fillable', label: t`fillable` },
        { key: 'price.hashprice', label: t`hashprice` },
        { key: 'price.max_bid', label: t`max bid` },
        { key: 'price.right_axis', label: t`price right-axis line` },
      ],
    },
    {
      // Block + icon markers at the top of the chart. Each marker is
      // a glyph + a dashed connector to its data point; the colour
      // here drives both.
      title: t`Markers`,
      rows: [
        { key: 'hashrate.pool_block_ours', label: t`own pool block (crown)` },
        { key: 'hashrate.pool_block_others', label: t`pool block (cube)` },
        { key: 'hashrate.pool_block_bip110', label: t`BIP 110-signalling block` },
        { key: 'hashrate.marker_retarget', label: t`difficulty retarget (pickaxe)` },
        { key: 'hashrate.marker_ip_change', label: t`public-IP change (router)` },
        { key: 'price.marker_payout_gem', label: t`on-chain payout (gem)` },
        { key: 'price.marker_deposit', label: t`Braiins deposit (gem)` },
      ],
    },
    {
      // Per-tick bid-event markers (small glyphs on the bid line).
      title: t`Bid events`,
      rows: [
        { key: 'events.create', label: t`create` },
        { key: 'events.edit_price', label: t`edit price` },
        { key: 'events.edit_speed', label: t`edit speed` },
        { key: 'events.cancel', label: t`cancel` },
      ],
    },
  ];

  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm uppercase tracking-wider text-amber-400">
            <Trans>Chart colors</Trans>
          </h3>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            <Trans>
              Override the color of any named line or event marker on the Hashrate and Price charts.
              Click a swatch to pick from the curated palette or set a custom hex value.
              Saved on the daemon, so the choice follows you across devices.
            </Trans>
          </p>
        </div>
        <button
          type="button"
          onClick={resetAll}
          disabled={!anyOverride}
          className="shrink-0 text-xs text-amber-400 hover:underline disabled:text-slate-600 disabled:no-underline disabled:cursor-not-allowed whitespace-nowrap"
        >
          <Trans>Reset all to defaults</Trans>
        </button>
      </header>
      <div className="space-y-5 max-w-3xl">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
              {group.title}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {group.rows.map((row) => {
                const def = CHART_COLOR_DEFAULTS[row.key];
                const cur = getChartColor(row.key, overrides);
                return (
                  <div key={row.key} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-300">{row.label}</span>
                    <ChartColorPicker
                      value={cur}
                      defaultValue={def}
                      onChange={(next) => setColor(row.key, next)}
                      isOverridden={overrides[row.key] !== undefined}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SoloMinersSection({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const qc = useQueryClient();
  const enabled = draft.solo_mining_enabled;

  const list = useQuery({
    queryKey: ['solo-miners'],
    queryFn: api.soloMiners,
    refetchInterval: 5_000,
    // Keep the previous payload visible while the next refetch is in
    // flight so the list doesn't blank-out every 5s.
    placeholderData: (prev) => prev,
    enabled,
  });

  const [newLabel, setNewLabel] = useState('');
  const [newIp, setNewIp] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.createSoloMiner({ label: newLabel.trim(), ip: newIp.trim() }),
    onSuccess: (resp) => {
      if (resp.ok) {
        setNewLabel('');
        setNewIp('');
        setFormError(null);
        qc.invalidateQueries({ queryKey: ['solo-miners'] });
      } else {
        setFormError(resp.error ?? 'Unknown error');
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: (args: { id: number; body: Parameters<typeof api.updateSoloMiner>[1] }) =>
      api.updateSoloMiner(args.id, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['solo-miners'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteSoloMiner(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['solo-miners'] }),
  });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>Solo miners (Bitaxe / AxeOS)</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            Monitor a fleet of home Bitaxe / Nerdaxe / ESP-Miner units alongside the autopilot's
            rented Braiins hashrate. The daemon polls each device's /api/system/info every tick;
            hashrate, temperature, power draw, and share rates surface on the Status page.
          </Trans>
        </p>
      </header>

      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange('solo_mining_enabled', e.target.checked)}
          className="accent-amber-400 h-4 w-4"
        />
        <Trans>Enable solo-mining monitoring</Trans>
      </label>

      {enabled && (
        <div className="mt-4 space-y-4">
          <div>
            <h4 className="text-xs uppercase tracking-wider text-slate-400 mb-2">
              <Trans>Devices</Trans>
            </h4>
            {list.isPending && (
              <div className="text-xs text-slate-500"><Trans>loading…</Trans></div>
            )}
            {list.data && list.data.devices.length === 0 && (
              <div className="text-xs text-slate-500 italic">
                <Trans>No devices yet. Add one below.</Trans>
              </div>
            )}
            {list.data && list.data.devices.length > 0 && (
              // #158: wrap the table in overflow-x-auto with the table
              // taking its natural width (NOT w-full). On viewports
              // wide enough for the full table the wrapper is a no-op;
              // on iPhone (~390-430px viewport) the table extends past
              // the parent and the wrapper scrolls horizontally. This
              // replaces the previous w-full + w-52 hint pattern,
              // which still let the browser proportionally squeeze
              // every column on a narrow viewport so the IP cell
              // ended up ~140px no matter what the TH said. Trade-off:
              // horizontal scroll on phones, but the IP renders
              // correctly at full width regardless of viewport.
              <div className="overflow-x-auto">
                <table className="text-xs min-w-full table-fixed">
                  <colgroup>
                    <col className="w-8" />
                    <col className="w-32" />
                    <col className="w-52" />
                    <col className="w-8" />
                  </colgroup>
                  <thead className="text-slate-500 uppercase tracking-wider">
                    <tr>
                      {/* #155: column order = ON/off > Label > IP/host
                          > trash. table-fixed makes the col widths
                          binding rather than advisory. */}
                      <th className="text-left font-normal py-1 pr-3"><Trans>On</Trans></th>
                      <th className="text-left font-normal py-1 pr-3"><Trans>Label</Trans></th>
                      <th className="text-left font-normal py-1 pr-3"><Trans>IP / host</Trans></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-200">
                    {list.data.devices.map((d) => (
                      <SoloMinerRow
                        key={d.id}
                        device={d}
                        onSave={(body) => updateMutation.mutate({ id: d.id, body })}
                        onDelete={() => deleteMutation.mutate(d.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <h4 className="text-xs uppercase tracking-wider text-slate-400">
                <Trans>Add device</Trans>
              </h4>
              <ScanLocalNetworkButton />
            </div>
            {/* Mobile: stack the three children vertically so both
                inputs get full width (was: asymmetric wrap with Label
                clipped to ~192px and IP at ~280px, plus the Add
                button on a third row). sm+: side-by-side row. */}
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-end">
              <label className="block w-full sm:flex-1 sm:min-w-[12rem]">
                <span className="block text-[11px] text-slate-500 mb-0.5">
                  <Trans>Label</Trans>
                </span>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Garage Gamma"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
                />
              </label>
              <label className="block w-full sm:flex-1 sm:min-w-[12rem]">
                <span className="block text-[11px] text-slate-500 mb-0.5">
                  <Trans>IP / host</Trans>
                </span>
                <input
                  type="text"
                  value={newIp}
                  onChange={(e) => setNewIp(e.target.value)}
                  placeholder="192.168.1.127"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm font-mono"
                />
              </label>
              <button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !newLabel.trim() || !newIp.trim()}
                className="px-3 py-1 text-sm bg-amber-500/20 border border-amber-500 text-amber-200 rounded hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed self-stretch sm:self-auto"
              >
                {createMutation.isPending ? <Trans>adding…</Trans> : <Trans>Add</Trans>}
              </button>
            </div>
            {formError && (
              <div className="text-xs text-red-400">{formError}</div>
            )}
          </div>

          <SoloThresholdInputs draft={draft} onChange={onChange} />
        </div>
      )}
    </section>
  );
}

function SoloMinerRow({
  device,
  onSave,
  onDelete,
}: {
  device: import('../lib/api').SoloMinerDevice;
  onSave: (body: { label?: string; ip?: string; enabled?: boolean }) => void;
  onDelete: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const [label, setLabel] = useState(device.label);
  const [ip, setIp] = useState(device.ip);
  const dirty = label !== device.label || ip !== device.ip;
  return (
    <tr className="border-t border-slate-800">
      <td className="py-1 pr-3">
        <input
          type="checkbox"
          checked={device.enabled}
          onChange={(e) => onSave({ enabled: e.target.checked })}
          className="accent-amber-400 h-3.5 w-3.5"
          title={t`Uncheck to pause polling without deleting the device - label + IP are kept, alerts pause, re-enable in one click. Use the trash icon to delete permanently.`}
        />
      </td>
      <td className="py-1 pr-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs"
        />
      </td>
      <td className="py-1 pr-3">
        <input
          type="text"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono"
        />
      </td>
      <td className="py-1 text-right whitespace-nowrap">
        {dirty && (
          <button
            type="button"
            onClick={() => onSave({ label: label.trim(), ip: ip.trim() })}
            className="px-2 py-0.5 text-[11px] text-amber-300 border border-amber-700 rounded hover:bg-amber-500/10 mr-1"
          >
            <Trans>save</Trans>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm(t`Remove ${device.label}?`)) onDelete();
          }}
          aria-label={t`Remove device`}
          title={t`Delete this device permanently. To pause without deleting, uncheck the box at the left of the row.`}
          className="text-slate-400 hover:text-red-400 p-1 rounded transition-colors"
        >
          {/* Trash-can glyph (SVG); 14px to match the row's text-xs scale. */}
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

function SoloThresholdInputs({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const tempUnit = useTemperatureUnit();
  // #157: bidirectional °C ↔ °F at the display boundary. The
  // sentinel 0 ("auto per model") stays as 0 regardless of unit.
  const displayCeiling =
    draft.solo_overheating_threshold_celsius === 0
      ? 0
      : tempUnit === 'F'
        ? Math.round(celsiusToFahrenheit(draft.solo_overheating_threshold_celsius))
        : draft.solo_overheating_threshold_celsius;
  const onCeilingChange = (displayValue: number): void => {
    if (displayValue === 0) {
      onChange('solo_overheating_threshold_celsius', 0);
      return;
    }
    const c = tempUnit === 'F' ? Math.round(fahrenheitToCelsius(displayValue)) : displayValue;
    onChange('solo_overheating_threshold_celsius', c);
  };
  const ceilingLabel =
    tempUnit === 'F'
      ? t`ASIC overheating ceiling (°F, 0 = auto per model)`
      : t`ASIC overheating ceiling (°C, 0 = auto per model)`;
  const ceilingHelp =
    tempUnit === 'F'
      ? t`ASIC junction temperature only. Default 0 uses 167 °F across all BM13xx chips - matches AxeOS firmware's THROTTLE_TEMP, the point at which the miner itself reduces frequency. Any non-zero value here overrides it. The VR (voltage regulator) sensor uses a separate built-in ceiling of 212 °F (100 °C); AxeOS throttles the VR at 221 °F (105 °C) so we fire 5 °C earlier to give you headroom to react.`
      : t`ASIC junction temperature only. Default 0 uses 75 °C across all BM13xx chips - matches AxeOS firmware's THROTTLE_TEMP, the point at which the miner itself reduces frequency. Any non-zero value here overrides it. The VR (voltage regulator) sensor uses a separate built-in ceiling of 100 °C; AxeOS throttles the VR at 105 °C so we fire 5 °C earlier to give you headroom to react.`;
  return (
    <div className="border-t border-slate-800 pt-3 space-y-2">
      <h4 className="text-xs uppercase tracking-wider text-slate-400">
        <Trans>Alert thresholds</Trans>
      </h4>
      <p className="text-[11px] text-slate-500">
        <Trans>
          Per-event-class opt-outs live on the Notifications tab. Per-ASIC-model thermal
          ceilings are picked automatically; the override below applies a single global
          ceiling across every device.
        </Trans>
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SoloThresholdField label={ceilingLabel} help={ceilingHelp}>
          <NumberField
            value={displayCeiling}
            onChange={onCeilingChange}
            min={0}
            max={tempUnit === 'F' ? 302 : 150}
            step="integer"
          />
        </SoloThresholdField>
        <SoloThresholdField
          label={t`Zero-hashrate alert after (minutes)`}
          help={t`Consecutive minutes a device must report 0 hashrate (or be unreachable) before the alert fires.`}
        >
          <NumberField
            value={draft.solo_zero_hashrate_alert_after_minutes}
            onChange={(v) => onChange('solo_zero_hashrate_alert_after_minutes', v)}
            min={1}
            max={60}
            step="integer"
          />
        </SoloThresholdField>
        <SoloThresholdField
          label={t`Share-rejection threshold (%)`}
          help={t`Rolling-window rejection rate above which the alert fires. Default 10 %.`}
        >
          <NumberField
            value={draft.solo_share_rejection_threshold_pct}
            onChange={(v) => onChange('solo_share_rejection_threshold_pct', v)}
            min={0}
            max={100}
            step="any"
          />
        </SoloThresholdField>
        <SoloThresholdField
          label={t`Share-rejection window (minutes)`}
          help={t`Window over which the rejection rate is computed.`}
        >
          <NumberField
            value={draft.solo_share_rejection_window_minutes}
            onChange={(v) => onChange('solo_share_rejection_window_minutes', v)}
            min={5}
            max={1440}
            step="integer"
          />
        </SoloThresholdField>
      </div>
    </div>
  );
}

/**
 * Scan-local-network helper. Triggers a daemon-side /24 sweep,
 * shows a modal dialog with discovered AxeOS hosts, and lets the
 * operator confirm which ones to persist. Already-saved IPs are
 * rendered greyed-out + non-selectable so a repeat scan after
 * adding two units doesn't tempt the operator to dupe-insert.
 *
 * #156 follow-up: scan runs as a background sweep on the daemon
 * (concurrency 8, 1.5s per-IP timeout). Modal opens immediately on
 * click and polls /scan/status every ~400ms to render a progress
 * bar + live candidate list while the sweep is running. Replaces
 * the old one-shot 254-way `Promise.all` that intermittently came
 * back empty under Docker + Wi-Fi conditions.
 */
function ScanLocalNetworkButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Operator-editable candidate list, keyed by IP. We merge server
  // candidates into this map on each poll: new IPs get a fresh
  // default label + pick state; existing IPs keep the operator's
  // edits intact.
  const [edits, setEdits] = useState<
    Record<string, { label: string; pick: boolean }>
  >({});
  // #156: subnet-override input. On Umbrel the daemon's auto-detected /24
  // is the docker bridge (10.21.0.0/24), so the scan finds nothing - the
  // operator types their home LAN here (e.g. 192.168.1.0/24). Persist
  // across navigations so they don't re-type after the first scan.
  const [subnetOverride, setSubnetOverride] = useState<string>(() => {
    try {
      return localStorage.getItem('hashrate-autopilot.scan-cidr') ?? '';
    } catch {
      return '';
    }
  });
  const persistOverride = (v: string): void => {
    setSubnetOverride(v);
    try {
      if (v.trim()) localStorage.setItem('hashrate-autopilot.scan-cidr', v.trim());
      else localStorage.removeItem('hashrate-autopilot.scan-cidr');
    } catch {
      // Ignore - localStorage unavailable (private mode etc.).
    }
  };

  const statusQuery = useQuery({
    queryKey: ['solo-miners-scan-status'],
    queryFn: () => api.soloMinersScanStatus(),
    enabled: open,
    // Fast poll while the sweep is in flight; stop once we've reached
    // a terminal state so the modal isn't generating idle traffic.
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      return s === 'running' ? 400 : false;
    },
    refetchOnWindowFocus: false,
  });
  const status = statusQuery.data;

  // Merge newly-discovered candidates into the edits map. Existing
  // entries are left alone so operator label/pick edits survive
  // across polls.
  useEffect(() => {
    if (!status) return;
    setEdits((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const c of status.candidates) {
        if (!(c.ip in next)) {
          next[c.ip] = {
            label: defaultLabelFor(c),
            pick: !c.already_added,
          };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  const startMutation = useMutation({
    mutationFn: () => api.startSoloMinersScan(subnetOverride),
    onMutate: () => {
      setEdits({});
      setOpen(true);
    },
    onSuccess: () => {
      // Kick the status query so the progress UI populates without
      // waiting for the first refetch tick.
      void statusQuery.refetch();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const picked = (status?.candidates ?? []).filter(
        (c) => edits[c.ip]?.pick && !c.already_added,
      );
      for (const c of picked) {
        const label = (edits[c.ip]?.label ?? defaultLabelFor(c)).trim() || c.ip;
        await api.createSoloMiner({ label, ip: c.ip });
      }
    },
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['solo-miners'] });
    },
  });

  const onClose = (): void => {
    setOpen(false);
    // Keep the last scan's edits cached for the session - if the
    // operator reopens before refreshing, they see the most recent
    // results without re-triggering a sweep.
  };

  const candidates = status?.candidates ?? [];
  const isRunning = status?.state === 'running';
  const isDone = status?.state === 'done';
  const startError = startMutation.data && !startMutation.data.ok
    ? startMutation.data.error
    : null;
  const scanError = startError ?? status?.error ?? null;
  const total = status?.total ?? 0;
  const done = status?.done ?? 0;
  const progressPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const pickedCount = candidates.filter(
    (c) => edits[c.ip]?.pick && !c.already_added,
  ).length;

  return (
    <>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={subnetOverride}
          onChange={(e) => persistOverride(e.target.value)}
          placeholder="192.168.1.0/24"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="w-32 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-700"
          title={t`Subnet to scan (CIDR). Leave blank to auto-detect from the daemon's interface - required on Umbrel.`}
        />
        <button
          type="button"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || isRunning}
          className="text-[11px] text-amber-300 border border-amber-700 rounded px-2 py-0.5 hover:bg-amber-500/10 disabled:opacity-40"
        >
          {isRunning ? <Trans>scanning…</Trans> : <Trans>Scan local network</Trans>}
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={onClose}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-lg p-4 w-full max-w-2xl max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm text-slate-100">
                <Trans>Scan results</Trans>{' '}
                {status?.cidr && (
                  <span className="text-[11px] text-slate-500 font-mono ml-1">{status.cidr}</span>
                )}
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="text-slate-400 hover:text-slate-200 text-xs"
              >
                ✕
              </button>
            </div>
            {/* Progress bar - visible while running and on completion. */}
            {(isRunning || isDone) && total > 0 && (
              <div className="mb-3">
                <div className="flex items-baseline justify-between text-[11px] text-slate-500 mb-1">
                  <span>
                    {isRunning ? (
                      <Trans>
                        Probing {done} of {total}…
                      </Trans>
                    ) : (
                      <Trans>
                        Probed {total} hosts. Found {candidates.length} device(s).
                      </Trans>
                    )}
                  </span>
                  <span className="font-mono">{progressPct}%</span>
                </div>
                <div className="h-1 w-full bg-slate-800 rounded overflow-hidden">
                  <div
                    className={
                      isRunning
                        ? 'h-full bg-amber-400 transition-[width] duration-300'
                        : 'h-full bg-emerald-500 transition-[width] duration-300'
                    }
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}
            {scanError && (
              <div className="text-xs text-red-400 mb-2">{scanError}</div>
            )}
            {!scanError && isDone && candidates.length === 0 && (
              <div className="text-xs text-slate-500 italic">
                <Trans>No AxeOS devices found on the local subnet.</Trans>
              </div>
            )}
            {candidates.length > 0 && (
              <>
                <table className="w-full text-xs mb-3">
                  <thead className="text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="text-left font-normal py-1 pr-2"></th>
                      <th className="text-left font-normal py-1 pr-2"><Trans>IP</Trans></th>
                      <th className="text-left font-normal py-1 pr-2"><Trans>ASIC</Trans></th>
                      <th className="text-right font-normal py-1 pr-2"><Trans>Hashrate</Trans></th>
                      <th className="text-left font-normal py-1 pr-2"><Trans>Label</Trans></th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr
                        key={c.ip}
                        className={
                          c.already_added
                            ? 'border-t border-slate-800 opacity-50'
                            : 'border-t border-slate-800'
                        }
                      >
                        <td className="py-1 pr-2 text-center">
                          <input
                            type="checkbox"
                            checked={edits[c.ip]?.pick ?? false}
                            disabled={c.already_added}
                            onChange={(e) => {
                              const v = e.target.checked;
                              setEdits((prev) => ({
                                ...prev,
                                [c.ip]: {
                                  label: prev[c.ip]?.label ?? defaultLabelFor(c),
                                  pick: v,
                                },
                              }));
                            }}
                            className="accent-amber-400 h-3.5 w-3.5"
                          />
                        </td>
                        <td className="py-1 pr-2 font-mono">
                          {c.ip}
                          {c.already_added && (
                            <span className="ml-2 text-[10px] text-slate-500">
                              (<Trans>already added</Trans>)
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-2 text-slate-400">{c.asic_model ?? '-'}</td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-400">
                          {c.hashrate_ghs !== null
                            ? c.hashrate_ghs >= 1000
                              ? `${(c.hashrate_ghs / 1000).toFixed(2)} TH/s`
                              : `${c.hashrate_ghs.toFixed(0)} GH/s`
                            : '-'}
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            type="text"
                            value={edits[c.ip]?.label ?? defaultLabelFor(c)}
                            disabled={c.already_added}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((prev) => ({
                                ...prev,
                                [c.ip]: {
                                  label: v,
                                  pick: prev[c.ip]?.pick ?? !c.already_added,
                                },
                              }));
                            }}
                            className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs disabled:opacity-50"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1 text-xs text-slate-400 border border-slate-700 rounded hover:bg-slate-800"
                  >
                    <Trans>Cancel</Trans>
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmMutation.mutate()}
                    disabled={
                      confirmMutation.isPending || isRunning || pickedCount === 0
                    }
                    className="px-3 py-1 text-xs bg-amber-500/20 border border-amber-500 text-amber-200 rounded hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {confirmMutation.isPending ? (
                      <Trans>adding…</Trans>
                    ) : (
                      <Trans>
                        Add {pickedCount} selected
                      </Trans>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function defaultLabelFor(c: {
  ip: string;
  asic_model: string | null;
}): string {
  // "192.168.1.127 (BM1370)" is more informative than just the IP
  // and a reasonable starting point the operator can edit before
  // confirming. Falls back to bare IP when ASIC is unknown.
  if (c.asic_model) return `${c.ip} (${c.asic_model})`;
  return c.ip;
}

function SoloThresholdField({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-slate-300 mb-1">{label}</span>
      <div className="max-w-[200px]">{children}</div>
      <span className="block text-[11px] text-slate-500 mt-1">{help}</span>
    </label>
  );
}

/**
 * Custom section for payout observation source selection. Replaces the
 * old flat "Bitcoin node (optional)" section with a radio-driven layout
 * that shows only the fields relevant to the selected backend.
 */
function NotificationsSection({
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
      api.notificationsTest({
        bot_token: draft.telegram_bot_token ?? '',
        chat_id: draft.telegram_chat_id ?? '',
        instance_label: draft.telegram_instance_label ?? '',
      }),
  });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>Telegram notifications</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            Push outage alerts (Datum unreachable, hashrate floor breach, wallet
            runway, etc.) to Telegram so the operator finds out within minutes,
            not hours. See the setup walkthrough for the @BotFather + @userinfobot
            steps.
          </Trans>
        </p>
      </header>

      <div className="space-y-4">
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Telegram bot token</Trans>
          </span>
          <input
            type="password"
            value={draft.telegram_bot_token ?? ''}
            onChange={(e) => onChange('telegram_bot_token', e.target.value as never)}
            placeholder="123456789:AA..."
            autoComplete="off"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              Open Telegram and chat with{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400 hover:underline"
              >
                @BotFather
              </a>
              , send /newbot, follow the prompts; @BotFather replies with the token.
              Paste it here.
            </Trans>
          </span>
        </label>

        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Chat ID</Trans>
          </span>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={draft.telegram_chat_id ?? ''}
              onChange={(e) => onChange('telegram_chat_id', e.target.value as never)}
              placeholder="123456789"
              className="flex-1 min-w-[12rem] bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending || !draft.telegram_bot_token || !draft.telegram_chat_id}
              className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
            >
              {test.isPending ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
            </button>
          </div>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              Start a chat with your bot, then send /start. Send any message to{' '}
              <a
                href="https://t.me/userinfobot"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400 hover:underline"
              >
                @userinfobot
              </a>{' '}
              and copy the numeric Id back into this field. Test connection
              validates the values currently in the form, before saving.
            </Trans>
          </span>
          {(test.data || test.isError) && (
            <div className="mt-2 text-xs font-mono break-words">
              {test.data && test.data.ok && (
                <span className="text-emerald-300">
                  <Trans>OK · message delivered</Trans>
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
        </label>

        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Instance label (optional)</Trans>
          </span>
          <input
            type="text"
            value={draft.telegram_instance_label ?? ''}
            onChange={(e) =>
              onChange('telegram_instance_label', e.target.value as never)
            }
            placeholder="prod / dev / umbrel"
            maxLength={32}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              Optional. When set, every Telegram message from this daemon is prefixed with `[label] ` so you can tell which instance fired the alert if you run more than one daemon against the same bot/chat. Leave empty to send messages without a prefix.
            </Trans>
          </span>
        </label>

        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Retry interval</Trans>
          </span>
          <div className="flex items-center gap-2">
            <div className="w-20 flex-none">
              <NumberField
                value={draft.notification_retry_interval_minutes}
                onChange={(n) => onChange('notification_retry_interval_minutes', (n || 30) as never)}
                step="integer"
                locale={locale}
                noGrouping
              />
            </div>
            <span className="text-xs text-slate-500">
              <Trans>minutes</Trans>
            </span>
          </div>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              Cadence between retries when an alert fails to deliver or the bad
              state persists. First attempt fires immediately; up to 4 retries
              follow at this cadence; the 5th carries a final "giving up" message
              and the notifier stays silent until recovery.
            </Trans>
          </span>
        </label>

        <EventClassSubscriptions draft={draft} onChange={onChange} locale={locale} />
      </div>
    </section>
  );
}

/**
 * #106: per-event-class opt-out. One row per known event class,
 * grouped under a small section header for the originating system.
 *
 * Backing storage is a mix of three stores, bridged by per-tile
 * getters/setters:
 * - `notification_disabled_event_classes` (string[], the original
 *   #106 design) holds enable/disable for the seven ERROR detectors.
 * - `wallet_runway_alert_days` (number, #116) where 0 = off and
 *   any positive integer = on with that day-threshold.
 * - `notify_on_pool_block_credit` (boolean, #117) for the
 *   celebratory INFO event.
 *
 * Render: rows are full-width and stacked vertically inside three
 * sections (Datum / Braiins Marketplace / Ocean) so the grouping
 * mirrors which underlying system the alert reports on. The runway
 * row's day-count input is permanently rendered (greyed when the
 * tile is unchecked) so ticking the checkbox doesn't reflow the
 * surrounding rows.
 */
type Tile = {
  id: string;
  label: string;
  help: string;
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  extra?: React.ReactNode;
  /**
   * #138: severity bucket the tile's event_class fires at. Drives
   * the small `IMPORTANT` / `WARNING` / `INFO` pill on the tile so
   * the operator can tell at a glance whether disabling a row
   * silences a page-someone alert vs an informational ping.
   *
   * Source of truth: each detector's `severity:` argument in
   * `packages/daemon/src/services/alert-evaluator.ts`. The
   * mapping is static (assigned at code time, not configurable per-
   * install), so a const lookup is enough - no API call needed.
   */
  severity: AlertSeverity;
};

function EventClassSubscriptions({
  draft,
  onChange,
  locale,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
  locale: string | undefined;
}) {
  const { i18n } = useLingui();
  const disabled = new Set(draft.notification_disabled_event_classes);

  // Per-event Test button: ask the daemon to fire a sample message
  // for this event class through the saved Telegram bot. Tracks
  // pending/result state per-row via the most recently clicked event
  // class so the button can show "sending..." then a brief tick or
  // error inline.
  const [testResult, setTestResult] = useState<
    { event_class: string; ok: boolean; error?: string | null } | null
  >(null);
  const testEvent = useMutation({
    mutationFn: (event_class: string) => api.notificationsTestEvent(event_class),
    onSuccess: (resp, event_class) => {
      setTestResult({ event_class, ok: resp.ok, error: resp.error });
      // Clear the result after a short window so the row settles back
      // to its idle state without the operator having to do anything.
      window.setTimeout(() => setTestResult(null), 4000);
    },
    onError: (err: Error, event_class) => {
      setTestResult({ event_class, ok: false, error: err.message });
      window.setTimeout(() => setTestResult(null), 6000);
    },
  });

  const toggleClass = (id: string, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(id);
    else next.add(id);
    onChange(
      'notification_disabled_event_classes',
      Array.from(next).sort() as never,
    );
  };

  const sendHelp = i18n._(
    'When off, alerts are still recorded on the /alerts page with status "muted" but nothing is sent to Telegram. Recovery messages also stay silent.',
  );

  const muted = draft.notifications_muted;
  const runwayOn = draft.wallet_runway_alert_days > 0;

  // #134 follow-up: inline minute-input shape, mirroring the
  // wallet-runway tile's "below N days" pattern. Used by every
  // timer-driven event so the operator edits the threshold inline
  // on the tile rather than hunting for a separate config variable.
  const minutesInput = <K extends keyof AppConfig>(
    field: K,
    enabled: boolean,
  ): React.ReactNode => (
    <span
      className={
        'flex items-center gap-2 text-sm font-semibold whitespace-nowrap ' +
        (enabled ? 'text-slate-100' : 'text-slate-500')
      }
      onClick={(e) => e.preventDefault()}
    >
      <div className="w-16 flex-none">
        <NumberField
          value={(draft[field] as number) ?? 0}
          onChange={(n) =>
            onChange(field, (n && n > 0 ? Math.round(n) : 1) as never)
          }
          step="integer"
          locale={locale}
          noGrouping
          disabled={!enabled || muted}
        />
      </div>
      <Trans>minutes</Trans>
    </span>
  );

  const datumTiles: Tile[] = [
    {
      id: 'datum_unreachable',
      label: t`Datum stratum unreachable for`,
      help: t`Buyer-side gateway has been unreachable for at least this many minutes.`,
      enabled: !disabled.has('datum_unreachable'),
      setEnabled: (n) => toggleClass('datum_unreachable', n),
      severity: 'IMPORTANT',
      extra: minutesInput(
        'datum_unreachable_alert_after_minutes',
        !disabled.has('datum_unreachable'),
      ),
    },
  ];

  const braiinsTiles: Tile[] = [
    {
      id: 'hashrate_below_floor',
      label: t`Hashrate below floor for`,
      help: t`Delivered hashrate has been under your floor for at least this many minutes.`,
      enabled: !disabled.has('hashrate_below_floor'),
      setEnabled: (n) => toggleClass('hashrate_below_floor', n),
      severity: 'IMPORTANT',
      extra: minutesInput('below_floor_alert_after_minutes', !disabled.has('hashrate_below_floor')),
    },
    {
      id: 'zero_hashrate',
      label: t`Zero hashrate for`,
      help: t`Effectively zero delivery for at least this many minutes.`,
      enabled: !disabled.has('zero_hashrate'),
      setEnabled: (n) => toggleClass('zero_hashrate', n),
      severity: 'IMPORTANT',
      extra: minutesInput('zero_hashrate_loud_alert_after_minutes', !disabled.has('zero_hashrate')),
    },
    {
      id: 'api_unreachable',
      label: t`Braiins API unreachable for`,
      help: t`Marketplace API has been unreachable for at least this many minutes.`,
      enabled: !disabled.has('api_unreachable'),
      setEnabled: (n) => toggleClass('api_unreachable', n),
      severity: 'IMPORTANT',
      extra: minutesInput('api_outage_alert_after_minutes', !disabled.has('api_unreachable')),
    },
    {
      id: 'unknown_bid',
      label: t`Unknown bid detected`,
      help: t`A bid in the account that the autopilot did not create. Already triggers auto-PAUSE.`,
      enabled: !disabled.has('unknown_bid'),
      setEnabled: (n) => toggleClass('unknown_bid', n),
      severity: 'IMPORTANT',
    },
    {
      id: 'sustained_paused',
      label: t`Bid sustained-paused for`,
      help: t`Primary owned bid has been Paused by Braiins for at least this many minutes.`,
      enabled: !disabled.has('sustained_paused'),
      setEnabled: (n) => toggleClass('sustained_paused', n),
      severity: 'IMPORTANT',
      extra: minutesInput(
        'sustained_paused_alert_after_minutes',
        !disabled.has('sustained_paused'),
      ),
    },
    {
      id: 'beta_exit',
      label: t`Beta-exit detected`,
      help: t`Any active owned bid reports fee_rate_pct > 0.`,
      enabled: !disabled.has('beta_exit'),
      setEnabled: (n) => toggleClass('beta_exit', n),
      severity: 'WARNING',
    },
    {
      id: 'braiins_deposit',
      // Single tile gates all three deposit lifecycle events
      // (Detected / Available / Returned). Operator's framing in
      // #130's interview - one toggle for "deposit-related events"
      // rather than three sub-toggles. The per-event-class opt-out
      // can still silence individual events for fine-grained tuning.
      //
      // Severity pill shows INFO because the typical case (Detected
      // / Available) is informational; the rare Returned event
      // upgrades to IMPORTANT, but for the operator-facing toggle
      // INFO is the more honest baseline.
      label: t`Braiins deposit lifecycle`,
      help: t`Off by default. When on, sends an INFO message when Braiins detects a deposit and another when it's cleared compliance and is spendable. Sends an IMPORTANT message if Braiins's compliance returns the deposit (real money on the line).`,
      enabled: draft.notify_on_braiins_deposit,
      setEnabled: (n) => onChange('notify_on_braiins_deposit', n as never),
      severity: 'INFO',
    },
    {
      id: 'wallet_runway',
      // Label reads as a complete phrase together with the inline
      // days-input rendered in `extra` immediately after: "Wallet
      // runway below [N] days". Operator suggestion - a single
      // self-contained sentence beats a separate "fire below" span.
      label: t`Wallet runway below`,
      help: t`Total Braiins balance ÷ trailing-3h burn rate has dropped below the configured threshold. Off by default; tick the box and pick a day count to enable.`,
      enabled: runwayOn,
      severity: 'IMPORTANT',
      // Toggling on resets the threshold to 3 days; toggling off
      // collapses to 0 (the daemon's "alert disabled" sentinel).
      setEnabled: (n) =>
        onChange('wallet_runway_alert_days', (n ? 3 : 0) as never),
      // Always render the day-input so the row's height never
      // changes when the operator toggles the checkbox - the input
      // just becomes editable when the box is ticked, greyed
      // otherwise. Prevents the surrounding rows from reflowing.
      extra: (
        <span
          className={
            'flex items-center gap-2 text-sm font-semibold whitespace-nowrap ' +
            (runwayOn ? 'text-slate-100' : 'text-slate-500')
          }
          // Don't let clicks inside the inline input bubble up to the
          // <label>'s checkbox toggle.
          onClick={(e) => e.preventDefault()}
        >
          {/* Wrap NumberField in a fixed-width, flex-none div so the
              field doesn't stretch under the parent flex layout.
              NumberField's own wrapper carries `flex-1` and the input
              has `w-full`, which together would fill the remaining row
              width regardless of any width passed via className. The
              w-16 wrapper boxes it to ~3 digits + spinner chrome. */}
          <div className="w-16 flex-none">
            <NumberField
              value={draft.wallet_runway_alert_days}
              onChange={(n) =>
                onChange(
                  'wallet_runway_alert_days',
                  // Coerce non-positive entries to a small positive
                  // value so the runway tile stays "on" once the
                  // operator ticked it. 0 disables; the toggle
                  // already drives that.
                  (n && n > 0 ? n : 0.5) as never,
                )
              }
              step="any"
              locale={locale}
              noGrouping
              disabled={!runwayOn || muted}
            />
          </div>
          <Trans>days</Trans>
        </span>
      ),
    },
    {
      // #167: marketplace empty (Braiins has no asks for our target
      // AND delivery is ~0). Off by default; INFO severity. The
      // detection runs whether or not the operator subscribes - the
      // Status-page banner and the chart shading both surface the
      // state independently. This tile only controls the Telegram
      // push.
      id: 'marketplace_empty',
      label: t`Braiins marketplace empty for`,
      help: t`Fires when the Braiins orderbook has no hashrate available for your target AND delivery has fallen to zero, sustained for at least this many minutes. Two-condition gate filters micro-gaps in the orderbook. Recovery paired. Rare - normally only happens during low-supply stretches.`,
      enabled: !disabled.has('marketplace_empty'),
      setEnabled: (n) => toggleClass('marketplace_empty', n),
      severity: 'INFO',
      extra: minutesInput(
        'marketplace_empty_alert_after_minutes',
        !disabled.has('marketplace_empty'),
      ),
    },
  ];

  const oceanTiles: Tile[] = [
    {
      id: 'pool_block_credited',
      label: t`Ocean pool-block credited`,
      help: t`Informational. Off by default. When on, every block Ocean credits to your payout address sends a small INFO message: block height, your share %, your credit, and progress toward the next 1,048,576-sat on-chain payout.`,
      enabled: draft.notify_on_pool_block_credit,
      setEnabled: (n) => onChange('notify_on_pool_block_credit', n as never),
      severity: 'INFO',
    },
    // #226: payout lifecycle - two separate INFO toggles. Most operators
    // will want both on or both off; keeping them split mirrors how the
    // events actually fire (one when Ocean debits unpaid_sat, one when
    // the coinbase confirms on-chain).
    {
      id: 'payout_initiated',
      label: t`Ocean payout initiated`,
      help: t`Informational. Off by default. Fires the moment Ocean debits your unpaid balance - the payout has been committed to the coinbase of the next block Ocean finds, but the transaction hasn't confirmed on-chain yet. Detection: the daemon's per-tick ocean_unpaid_sat drops by more than 30% AND the residual is below the 1,048,576-sat payout threshold (filters out tick noise / Ocean-side accounting bumps).`,
      enabled: draft.notify_on_payout_initiated,
      setEnabled: (n) => onChange('notify_on_payout_initiated', n as never),
      severity: 'INFO',
    },
    {
      id: 'payout_confirmed',
      label: t`Ocean payout confirmed on-chain`,
      help: t`Informational. Off by default. Fires when the on-chain payout scanner observes a coinbase output crediting your payout address - i.e. the transaction Ocean committed has now confirmed. Includes block height, payout amount, and a truncated tx id. Source: reward_events ledger (populated by Electrs or bitcoind scantxoutset, whichever the operator has wired).`,
      enabled: draft.notify_on_payout_confirmed,
      setEnabled: (n) => onChange('notify_on_payout_confirmed', n as never),
      severity: 'INFO',
    },
  ];

  // #149: solo-mining tiles. Only rendered when the master toggle is
  // on (per the operator's "with the toggle off these options should
  // not be visible" rule). The four event classes are individually
  // opt-out via the existing notification_disabled_event_classes
  // plumbing.
  const soloTiles: Tile[] = draft.solo_mining_enabled
    ? [
        {
          id: 'solo_overheating',
          label: t`Solo miner overheating`,
          help: t`Fires when the ASIC temp crosses 75 °C (configurable on Display & Logging → Solo miners) OR the VR temp crosses 100 °C, sustained for ~90 s. Thresholds match AxeOS firmware's own throttle points so the alert lines up with when the miner itself starts taking action. Recovery paired.`,
          enabled: !disabled.has('solo_overheating'),
          setEnabled: (n) => toggleClass('solo_overheating', n),
          severity: 'IMPORTANT',
        },
        {
          id: 'solo_zero_hashrate',
          label: t`Solo miner offline / zero hashrate`,
          help: t`Fires when a device is unreachable OR reports 0 H/s for the configured number of consecutive minutes. Recovery paired.`,
          enabled: !disabled.has('solo_zero_hashrate'),
          setEnabled: (n) => toggleClass('solo_zero_hashrate', n),
          severity: 'IMPORTANT',
        },
        {
          id: 'solo_share_rejection',
          label: t`Solo miner share-rejection high`,
          help: t`Fires when share rejection rate over the rolling window exceeds the configured threshold. Re-armed once per window so a sustained bad period only fires periodically.`,
          enabled: !disabled.has('solo_share_rejection'),
          setEnabled: (n) => toggleClass('solo_share_rejection', n),
          severity: 'IMPORTANT',
        },
        {
          id: 'solo_stratum_drift',
          label: t`Solo miner stratum URL drift`,
          help: t`Fires once whenever a device's stratum URL changes from the previously-observed value. Baselined silently on first poll so adding a device doesn't fire a spurious "drift detected" alert.`,
          enabled: !disabled.has('solo_stratum_drift'),
          setEnabled: (n) => toggleClass('solo_stratum_drift', n),
          severity: 'IMPORTANT',
        },
        {
          id: 'solo_best_difficulty',
          label: t`Solo fleet best difficulty record`,
          help: t`Fires whenever the fleet-wide best share difficulty exceeds the all-time high-water mark. One-shot (no recovery pairing). The message includes the new record, previous best, improvement factor, and the device that found it.`,
          enabled: !disabled.has('solo_best_difficulty'),
          setEnabled: (n) => toggleClass('solo_best_difficulty', n),
          severity: 'INFO',
        },
      ]
    : [];

  // Help text becomes a permanent <p> below each row so the operator
  // can read it without hovering. Tooltips were the previous design;
  // replaced because the rest of the Config page surfaces help below
  // the field, not on hover, and consistency wins. The runway tile's
  // single help line covers both the checkbox AND the days-input
  // (one description per logical control, not per DOM node).
  const renderTile = (tile: Tile) => {
    const pendingTest = testEvent.isPending && testEvent.variables === tile.id;
    const showResult = testResult?.event_class === tile.id;
    return (
      <div
        key={tile.id}
        className={
          'p-2 rounded border transition ' +
          (muted ? 'border-slate-800 opacity-60' : 'border-slate-800')
        }
      >
        {/* Tile redesign for tighter mobile fit. Header row is just
            checkbox + label + severity pill + Test button; the inline
            minute / day input (`tile.extra`) gets its own row below,
            indented under the label. The prior single-row layout had
            the input nested INSIDE the label as a flex sibling, which
            on narrow viewports overlapped with the severity pill
            because both jockeyed for the right edge. Help text stays
            on the last row, full-width under the label indent. */}
        <div className="flex items-start gap-2">
          <label
            className={
              'flex items-start gap-2 flex-1 min-w-0 ' +
              (muted ? 'cursor-default' : 'cursor-pointer')
            }
          >
            <input
              type="checkbox"
              checked={tile.enabled}
              onChange={(e) => tile.setEnabled(e.target.checked)}
              disabled={muted}
              className="accent-amber-400 h-4 w-4 flex-shrink-0 mt-0.5"
            />
            <span className="text-sm text-slate-100 font-semibold leading-tight">
              {tile.label}
            </span>
          </label>
          <SeverityPill severity={tile.severity} />
          <button
            type="button"
            onClick={() => testEvent.mutate(tile.id)}
            disabled={pendingTest || muted}
            className="px-2 py-1 text-xs rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-40 whitespace-nowrap flex-shrink-0"
          >
            {pendingTest ? <Trans>Sending…</Trans> : <Trans>Test</Trans>}
          </button>
        </div>
        {tile.extra && (
          <div className="mt-2 ml-6" onClick={(e) => e.stopPropagation()}>
            {tile.extra}
          </div>
        )}
        <p className="text-xs text-slate-500 mt-1 ml-6">{tile.help}</p>
        {showResult && (
          <p
            className={
              'text-[11px] mt-1 ml-6 ' +
              (testResult?.ok ? 'text-emerald-300' : 'text-red-400')
            }
          >
            {testResult?.ok ? (
              <Trans>sent · check Telegram</Trans>
            ) : (
              testResult?.error ?? <Trans>send failed</Trans>
            )}
          </p>
        )}
      </div>
    );
  };

  const sectionHeader = (label: string) => (
    <div className="text-xs text-slate-400 uppercase tracking-wider font-semibold pt-2 pb-1">
      {label}
    </div>
  );

  return (
    <fieldset className="pt-3 border-t border-slate-800">
      <legend className="block text-sm text-slate-300 mb-2">
        <Trans>What to send to Telegram</Trans>
      </legend>

      {/* Master toggle (positive polarity: checked = send, unchecked
          = silence). The events below are visually nested as
          children: indented + left-border, and greyed out when the
          master is off. Operator preferred this over the previous
          "Mute all Telegram notifications" framing because the
          parent reads as the enabling control rather than a global
          kill-switch you have to mentally invert. */}
      <label className="flex items-start gap-2 p-2 rounded cursor-pointer">
        <input
          type="checkbox"
          checked={!draft.notifications_muted}
          onChange={(e) => onChange('notifications_muted', !e.target.checked as never)}
          className="accent-amber-400 h-4 w-4 mt-0.5"
        />
        <span className="flex-1">
          <span className="text-sm text-slate-100 font-semibold">
            <Trans>Send messages to Telegram</Trans>
          </span>
          <p className="text-xs text-slate-500 mt-0.5">{sendHelp}</p>
        </span>
      </label>

      {/* #131: language picker for the actual Telegram message text.
          Independent from the dashboard's UI locale (which is
          per-browser via localStorage); the daemon needs its own
          notion of the operator's language for messages it pushes
          out without the dashboard being open. */}
      <label className="flex items-start gap-2 p-2 rounded">
        <span className="flex-1 mt-0.5">
          <span className="text-sm text-slate-100 font-semibold">
            <Trans>Language</Trans>
          </span>
          <p className="text-xs text-slate-500 mt-0.5">
            <Trans>
              Language for Telegram message titles + bodies + severity prefix. Independent of
              the dashboard's display language (each browser has its own). Defaults to
              English.
            </Trans>
          </p>
        </span>
        <select
          value={draft.notification_locale ?? 'en'}
          onChange={(e) =>
            onChange(
              'notification_locale',
              e.target.value as 'en' | 'nl' | 'es' as never,
            )
          }
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
        >
          <option value="en">English</option>
          <option value="nl">Nederlands</option>
          <option value="es">Español</option>
        </select>
      </label>

      <div className="ml-6 pl-3 border-l border-slate-800 mt-1">
        <p className="text-xs text-slate-500 mb-1">
          <Trans>
            Tick any event type you want pushed. Untouched types skip the
            daemon entirely - no Telegram, no /alerts row, no retry ladder.
          </Trans>
        </p>

        <div className="flex flex-col gap-1">
          {sectionHeader(t`Datum`)}
          {datumTiles.map(renderTile)}
          {sectionHeader(t`Braiins marketplace`)}
          {braiinsTiles.map(renderTile)}
          {sectionHeader(t`Ocean`)}
          {oceanTiles.map(renderTile)}
          {soloTiles.length > 0 && (
            <>
              {sectionHeader(t`Solo miners (Bitaxe / AxeOS)`)}
              {soloTiles.map(renderTile)}
            </>
          )}
        </div>
      </div>
    </fieldset>
  );
}

/**
 * #138: severity badge rendered on each Notifications-tab tile.
 * Colours match the Telegram-side `formatTelegramBody` prefix
 * conventions (red `[IMPORTANT]`, amber `[WARNING]`, slate
 * `[INFO]`) so the operator's two surfaces - chat and config page
 * - read consistently. Non-interactive; the title attribute
 * carries the bucket name in a hover-tooltip for screen readers
 * and the curious.
 */
function SeverityPill({ severity }: { severity: AlertSeverity }) {
  const cls =
    severity === 'IMPORTANT'
      ? 'bg-red-500/15 text-red-300 border-red-500/40'
      : severity === 'WARNING'
        ? 'bg-amber-400/15 text-amber-300 border-amber-400/40'
        : 'bg-slate-700/40 text-slate-300 border-slate-600';
  const label =
    severity === 'IMPORTANT' ? t`IMPORTANT` : severity === 'WARNING' ? t`WARNING` : t`INFO`;
  return (
    <span
      title={label}
      className={
        'inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border whitespace-nowrap ' +
        cls
      }
    >
      {label}
    </span>
  );
}

/** Small (i) glyph that pairs with a `title=` tooltip on the parent. */
function HelpDot() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-600 text-[9px] text-slate-500 leading-none"
    >
      i
    </span>
  );
}

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
      label: t`Bitcoin Knots RPC`,
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

        {/* #170: historical backfill toggle + manual trigger. Only
            meaningful on electrs (the only path with a cheap full-
            address history call). Hidden on the other two sources. */}
        {source === 'electrs' && (
          <HistoricalPayoutsControls draft={draft} locale={locale} onChange={onChange} />
        )}

        {/* Bitcoin Knots RPC fields - always shown, not gated on the
            balance-check radio. These creds drive THREE features and
            only one of them is on-chain payouts: the BIP 110 yellow-
            cube marker on the Hashrate chart (#94 / #115) and the
            BIP 110 scan card on Status (#95) both call bitcoind even
            when Electrs is the selected payout backend. Hiding the
            fields when payout != bitcoind made the operator think
            BIP 110 was broken because the values that the scanner
            used were the saved (potentially stale) ones, with no UI
            to type fresh
            values into. */}
        <BitcoindRpcFields draft={draft} onChange={onChange} />
      </div>
    </section>
  );
}

/**
 * #170: toggle for the historical-payouts backfill loop + a
 * "Backfill now" button that runs it on demand.
 *
 * The toggle is a normal draft/onChange field. The button hits the
 * `/api/payouts/backfill` endpoint directly via the api client; it
 * does NOT participate in the dirty/auto-save flow because it's an
 * imperative operator action, not a config edit. Reports the
 * inserted-row count so the operator can see "actually, this did
 * something".
 */
function HistoricalPayoutsControls({
  draft,
  locale,
  onChange,
}: {
  draft: AppConfig;
  locale: string | undefined;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const enabled = draft.include_historical_payouts;
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const runBackfill = async () => {
    setPending(true);
    setResult(null);
    try {
      const r = await api.backfillPayouts();
      if (r.ok) {
        setResult({
          ok: true,
          message: t`Scanned ${r.tx_seen} txs (${r.with_matching_outputs} with matching outputs). Inserted ${r.inserted} new payout row(s) in ${Math.round(r.duration_ms / 1000)}s.`,
        });
      } else {
        setResult({
          ok: false,
          message: r.error ?? t`Backfill failed`,
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        message: (err as Error).message,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded p-3 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange('include_historical_payouts', e.target.checked as never)}
            className="mt-1 accent-amber-400"
          />
          <span className="text-sm text-slate-200 inline-flex items-center gap-1.5">
            <Trans>Include historical Ocean payouts in lifetime earnings</Trans>
            <InlineInfoPopover ariaLabel={t`More about historical payouts backfill`}>
              <Trans>
                When on, lifetime earnings count every coinbase tx ever credited to this
                payout address - including payouts you have already swept to another
                wallet. When off, only outputs still sitting at the address are counted
                (the pre-1.7.5 behaviour). Most users want this on; turn it off if you
                rotate to a fresh payout address per accounting period.
              </Trans>
              <span className="block mt-2">
                <Trans>
                  The "Backfill now" button walks the full address history via Electrs
                  and adds any historical Ocean coinbase payouts that aren't already
                  recorded. Safe to run repeatedly.
                </Trans>
              </span>
            </InlineInfoPopover>
          </span>
        </label>
        <button
          type="button"
          onClick={() => void runBackfill()}
          disabled={pending}
          className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
        >
          {pending ? <Trans>Scanning…</Trans> : <Trans>Backfill now</Trans>}
        </button>
      </div>

      {result && (
        <div
          className={
            'text-xs rounded p-2 ' +
            (result.ok
              ? 'bg-emerald-950/30 border border-emerald-800 text-emerald-200'
              : 'bg-rose-950/30 border border-rose-800 text-rose-200')
          }
        >
          {result.message}
        </div>
      )}

      {/* #170 follow-up: manual offset for off-chain / pre-autopilot
          income the on-chain observer can't see. Acts as the starting
          value of the lifetime-earnings line AND folds into the
          Status finance panel's net P&L. */}
      <div className="pt-3 border-t border-slate-800/60">
        <label className="block text-sm text-slate-200 inline-flex items-center gap-1.5">
          <Trans>Pre-installation earnings</Trans>
          <InlineInfoPopover ariaLabel={t`More about the pre-installation earnings offset`}>
            <Trans>
              One-shot offset for earnings the on-chain payout observer can't see -
              Lightning payouts, Ocean payouts that landed and were swept before you
              installed the autopilot, etc. Shifts the lifetime-earnings chart's
              starting value up by this amount and folds into the net P&L. Leave 0 if
              everything is already covered by the on-chain backfill above.
            </Trans>
          </InlineInfoPopover>
        </label>
        <div className="max-w-xs mt-2">
          <NumberField
            value={draft.historical_payouts_offset_sat}
            onChange={(n) =>
              onChange('historical_payouts_offset_sat', Math.max(0, Math.round(n)) as never)
            }
            step="integer"
            locale={locale}
            min={0}
            suffix={<SatSymbol />}
          />
        </div>
      </div>
    </div>
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
          <Trans>e.g. 192.168.1.121 or electrs_electrs_1 on Umbrel</Trans>
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
          <Trans>Bitcoin Knots RPC connection</Trans>
        </h4>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            Used by the on-chain payout balance check (when "Bitcoin Knots RPC" is
            selected as the backend above), AND by the{' '}
            <a
              href="https://bip110.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:underline"
            >
              BIP 110
            </a>{' '}
            yellow-cube marker on the Hashrate chart and the BIP 110 scan card on
            Status - those last two call bitcoind regardless of which payout backend
            is selected. The Test button below validates the values currently in
            the form, before saving.
          </Trans>
        </p>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <label className="block sm:col-span-2">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Bitcoin Knots RPC URL</Trans>
          </span>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={draft.bitcoind_rpc_url ?? ''}
              onChange={(e) => onChange('bitcoind_rpc_url', e.target.value as never)}
              className="flex-1 min-w-[12rem] bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
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
            <Trans>e.g. http://192.168.1.121:8332 - your Bitcoin Knots RPC endpoint.</Trans>
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
      spec.key === 'decisions_eventful_retention_days' ||
      spec.key === 'alerts_retention_days')
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
    // #112: inline Test connection button next to Pool URL and Datum stats API.
    const testKind: 'pool' | 'datum' | null =
      spec.key === 'destination_pool_url' ? 'pool' : spec.key === 'datum_api_url' ? 'datum' : null;
    return (
      <label className="block">
        <span className="block text-sm text-slate-300 mb-1">{spec.label}</span>
        {testKind ? (
          <FieldWithTestButton
            kind={testKind}
            value={v}
            onChange={(s) => onChange(spec.key, s as never)}
            className={
              'w-full bg-slate-800 border rounded px-3 py-1.5 text-sm font-mono ' +
              (showWarning ? 'border-amber-600' : 'border-slate-700')
            }
          />
        ) : (
          <input
            type="text"
            value={v}
            onChange={(e) => onChange(spec.key, e.target.value as never)}
            className={
              'w-full bg-slate-800 border rounded px-3 py-1.5 text-sm font-mono ' +
              (showWarning ? 'border-amber-600' : 'border-slate-700')
            }
          />
        )}
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
        {/* #162: the field name "Datum stats API" + the /umbrel-api
            endpoint path lead a lot of non-Umbrel operators to assume
            this integration doesn't apply to them. Inline warning +
            click-to-open popover with the deeper explanation and a
            deep link to the docs background section. */}
        {spec.key === 'datum_api_url' && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400 mt-1">
            <Trans>⚠ This is not Umbrel-specific.</Trans>
            <InlineInfoPopover ariaLabel={t`More about the /umbrel-api naming`}>
              <Trans>
                Even though the endpoint is named <code className="text-slate-200">/umbrel-api</code>,
                it lives inside Datum Gateway itself - compiled in via{' '}
                <code className="text-slate-200">#ifdef DATUM_API_FOR_UMBREL</code> and works on any
                Datum build with that flag set, regardless of host platform.
              </Trans>{' '}
              <a
                href="https://github.com/rdouma/hashrate-autopilot/blob/main/docs/setup-datum-api.md#background"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-300 hover:text-amber-200 underline"
              >
                <Trans>Learn more →</Trans>
              </a>
            </InlineInfoPopover>
          </span>
        )}
        {/* #165: Pool URL must resolve to the daemon's public IP from
            the public internet. Residential ISPs reassign that IP
            periodically, so a raw-IP entry silently breaks the day the
            ISP rotates. Surface the DDNS implication inline so the
            operator connects it to the Dynamic DNS panel right below. */}
        {spec.key === 'destination_pool_url' && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400 mt-1">
            <Trans>⚠ Dynamic IP? Use a DDNS hostname, not a raw IP.</Trans>
            <InlineInfoPopover ariaLabel={t`More about dynamic IPs and DDNS`}>
              <Trans>
                Residential ISPs reassign your public IP periodically. If you put a raw IP here it
                will work today and silently break the day your ISP rotates it. Use a DDNS hostname
                instead - free options include DuckDNS (no expiration, no monthly re-confirm) and
                No-IP. Configure DDNS in the <strong>Dynamic DNS</strong> panel below; once set up,
                point Pool URL at the hostname (e.g.{' '}
                <code className="text-slate-200">stratum+tcp://yourname.duckdns.org:23334</code>)
                and the daemon keeps the hostname mapped to your current IP automatically. Static IPs
                / VPS / business connections can keep using a raw IP and ignore this note.
              </Trans>
            </InlineInfoPopover>
          </span>
        )}
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
                onClick={() => {
                  onChange(spec.key, p.template as never);
                  if (p.secondary) {
                    onChange(p.secondary.key, p.secondary.template as never);
                  }
                }}
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
    const suffix = useBtc ? `₿/${unit}/day` : <><SatSymbol />/{unit}/day</>;
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

/**
 * #111: Dynamic DNS updater + public-IP diagnostics.
 *
 * Two reasons this card exists, beyond just exposing the config fields:
 *   - "Pool URL hostname resolves to" vs "Daemon's current public IP"
 *     gives the operator instant visual confirmation that DDNS is
 *     pointing at the right place. Mismatch = DDNS drift, the precise
 *     failure mode that motivated this feature.
 *   - The DDNS push status (`good <ip>` / `nochg <ip>` / error) lands
 *     in the same card so the operator sees end-to-end whether the
 *     daemon is actually keeping things in sync.
 *
 * Polls /api/ddns every 30 s. The underlying daemon-side caches are
 * already 5-min granularity; 30 s is just so the dashboard reflects
 * a config edit's effect within a tick.
 */

/**
 * Click-to-open info popover next to a yellow inline warning.
 * Used for both the "not Umbrel-specific" warning under Datum API
 * (#162) and the "dynamic IP needs DDNS" warning under Pool URL
 * (#165). Hover would be too eager for a paragraph-length
 * clarification; only the curious operator who actually wonders
 * clicks through.
 *
 * Dismisses on click outside or Escape. The shared `Tooltip`
 * primitive (`components/Tooltip.tsx`) is hover-only and string-only
 * - not extending it for these sites avoids ripple risk to its other
 * call sites.
 */
function InlineInfoPopover({
  ariaLabel,
  children,
}: {
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={ariaLabel}
        className="text-amber-400 hover:text-amber-300 leading-none focus:outline-none focus:ring-1 focus:ring-amber-500 rounded-full w-4 h-4 inline-flex items-center justify-center text-[12px]"
      >
        ⓘ
      </button>
      {open && (
        <span
          role="dialog"
          className="absolute left-0 top-5 z-50 bg-slate-950 border border-slate-700 rounded-lg shadow-lg p-3 text-xs text-slate-300 leading-relaxed w-80 whitespace-normal"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * #112: input + yellow Test connection button on the same row.
 * Used by Pool URL and Datum stats API to validate UNSAVED form
 * values before saving (same pattern as Telegram / bitcoind / electrs).
 */
function FieldWithTestButton({
  kind,
  value,
  onChange,
  className,
}: {
  kind: 'pool' | 'datum';
  value: string;
  onChange: (next: string) => void;
  className: string;
}) {
  const test = useMutation({
    mutationFn: () => (kind === 'pool' ? api.poolUrlTest(value) : api.datumTest(value)),
  });
  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`flex-1 ${className}`}
        />
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={test.isPending || !value.trim()}
          className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
        >
          {test.isPending ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
        </button>
      </div>
      {(test.data || test.isError) && (
        <div className="mt-2 text-xs font-mono break-words">
          {test.data && test.data.ok && (
            <span className="text-emerald-300">
              {kind === 'pool' ? (
                (() => {
                  const d = test.data as PoolUrlTestResponse;
                  return d.latency_ms !== null && d.latency_ms !== undefined ? (
                    <Trans>OK · connected in {d.latency_ms}ms</Trans>
                  ) : (
                    <Trans>OK</Trans>
                  );
                })()
              ) : (
                (() => {
                  const d = test.data as DatumTestResponse;
                  return (
                    <Trans>
                      OK · {d.connections ?? '-'} connections, {d.hashrate_ph ?? '-'} PH/s
                    </Trans>
                  );
                })()
              )}
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

/**
 * Render a dyndns2 / DuckDNS status code as a human-readable, localized
 * label. The raw codes (`good`, `nochg`, `nohost`, `badauth`, ...)
 * leak through to operators who don't know the protocol; this hides
 * them behind plain English (or NL/ES) phrases. Falls back to the raw
 * code so unrecognised statuses still render something useful.
 */
function localizeDdnsStatus(raw: string): string {
  switch (raw) {
    case 'good':
      return t`updated`;
    case 'nochg':
      return t`no change needed`;
    case 'nohost':
      return t`hostname not found`;
    case 'badauth':
      return t`bad credentials`;
    case 'notfqdn':
      return t`not a fully-qualified hostname`;
    case 'abuse':
      return t`blocked - update abuse detected`;
    case '911':
      return t`provider error - try again later`;
    case 'network_error':
      return t`network error`;
    case 'unsupported_provider':
      return t`unsupported provider`;
    default:
      return raw;
  }
}

/**
 * #112: DDNS Test connection - hits the configured provider's update
 * endpoint with the values currently in the form and surfaces the
 * provider's response (`good <ip>` / `nochg <ip>` / `badauth` / etc).
 * Inlined into the Hostname row (next to the input, same pattern as
 * Bitcoin Knots RPC URL + Test).
 */
/**
 * Hostname (with inline Test connection) + Username + Credential
 * fields, laid out the same way as BitcoindRpcFields:
 *   - Hostname row spans both columns; Test button sits inline-right
 *     of the input. Result message renders below the row.
 *   - Username + Credential side-by-side in a 2-col grid.
 *
 * DuckDNS variant: no Username field, so Credential spans both
 * columns to keep the layout balanced.
 */
function DdnsCredentialFields({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const test = useMutation<DdnsTestResponse, Error, void>({
    mutationFn: () =>
      api.ddnsTest({
        provider: draft.ddns_provider,
        hostname: draft.ddns_hostname,
        username: draft.ddns_username,
        credential: draft.ddns_credential,
        update_url: draft.ddns_update_url,
      }),
  });
  const hasUsernameField =
    draft.ddns_provider === 'noip' || draft.ddns_provider === 'dyndns2';
  const hasUpdateUrlField = draft.ddns_provider === 'dyndns2';
  const ready =
    draft.ddns_provider !== '' &&
    draft.ddns_hostname.trim() !== '' &&
    draft.ddns_credential.trim() !== '' &&
    (!hasUsernameField || draft.ddns_username.trim() !== '') &&
    (!hasUpdateUrlField || draft.ddns_update_url.trim() !== '');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      <label className="block sm:col-span-2">
        <span className="block text-sm text-slate-300 mb-1">
          <Trans>Hostname</Trans>
        </span>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={draft.ddns_hostname}
            onChange={(e) => onChange('ddns_hostname', e.target.value as never)}
            placeholder="myhomerig.duckdns.org"
            autoComplete="off"
            className="flex-1 min-w-[12rem] bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={!ready || test.isPending}
            className="px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50 whitespace-nowrap"
          >
            {test.isPending ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
          </button>
        </div>
        <span className="block text-xs text-slate-500 mt-1">
          <Trans>
            The hostname being maintained. For No-IP DDNS Key groups (the modern auth flow
            that doesn't expose your account password), use the special hostname
            all.ddnskey.com - that updates every hostname assigned to the DDNS Key's
            group in one call. Test connection pushes a real update with the values
            currently in the form (without saving). `nochg` and `good` are both success.
          </Trans>
        </span>
        {test.data && test.data.ok && (
          <div className="mt-2 text-xs text-emerald-300 font-mono">
            <Trans>
              OK · {test.data.status} {test.data.ip ?? ''}
            </Trans>
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
      {hasUsernameField && (
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Username (DDNS Key user)</Trans>
          </span>
          <input
            type="text"
            value={draft.ddns_username}
            onChange={(e) => onChange('ddns_username', e.target.value as never)}
            autoComplete="off"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>Per-hostname DDNS Key user, not your account login.</Trans>
          </span>
        </label>
      )}
      <label className={hasUsernameField ? 'block' : 'block sm:col-span-2'}>
        <span className="block text-sm text-slate-300 mb-1">
          <Trans>Credential (DDNS Key password / token)</Trans>
        </span>
        <input
          type="password"
          value={draft.ddns_credential}
          onChange={(e) => onChange('ddns_credential', e.target.value as never)}
          autoComplete="off"
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
        />
        <span className="block text-xs text-slate-500 mt-1">
          <Trans>
            Stored in the daemon's SQLite config. Use a per-hostname DDNS Key, not your
            main account password.
          </Trans>
        </span>
      </label>
      {hasUpdateUrlField && (
        <label className="block sm:col-span-2">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Update URL</Trans>
          </span>
          <input
            type="text"
            value={draft.ddns_update_url}
            onChange={(e) => onChange('ddns_update_url', e.target.value as never)}
            placeholder="https://api.dynu.com/nic/update"
            autoComplete="off"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono"
          />
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              The provider's dyndns2-compatible update endpoint. Examples: Dynu uses
              https://api.dynu.com/nic/update; FreeDNS / afraid.org uses
              https://freedns.afraid.org/nic/update; many self-hosted DDNS scripts speak
              the same protocol.
            </Trans>
          </span>
        </label>
      )}
    </div>
  );
}

function DdnsSection({
  draft,
  onChange,
}: {
  draft: AppConfig;
  onChange: <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => void;
}) {
  const { i18n } = useLingui();
  void i18n;

  const ddnsQ = useQuery({
    queryKey: ['ddns'],
    queryFn: () => api.ddns(),
    refetchInterval: 30_000,
  });

  const enabled = draft.ddns_provider !== '';
  const r = ddnsQ.data;

  const ipsMatch =
    r &&
    r.daemon_public_ip !== null &&
    r.pool_url_resolves_to !== null &&
    r.daemon_public_ip === r.pool_url_resolves_to;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <header className="mb-3">
        <h3 className="text-sm uppercase tracking-wider text-amber-400">
          <Trans>Dynamic DNS</Trans>
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          <Trans>
            Keep the Pool URL's hostname pointed at this box's current public IP. Replaces the router-firmware-based DDNS client. Supports No-IP (sign up at no-ip.com - create a hostname, then generate a DDNS Key under DDNS Keys / Groups), DuckDNS (sign up at duckdns.org - free, no expiration, no monthly re-confirm), and "Other" for any provider that speaks the dyndns2 protocol (Dynu, FreeDNS / afraid.org, many self-hosted scripts).
          </Trans>
        </p>
      </header>

      {/* Diagnostic rows: what's the public IP, what does the hostname resolve to. */}
      <div className="bg-slate-800/40 border border-slate-800 rounded p-3 mb-4 text-xs space-y-1.5 font-mono">
        <div className="flex flex-wrap gap-x-4">
          <span className="text-slate-400 w-44 shrink-0">
            <Trans>Daemon's public IP:</Trans>
          </span>
          <span className="text-slate-100">
            {r?.daemon_public_ip ?? <span className="text-slate-500">-</span>}
            {r?.daemon_public_ip_checked_at && (
              <span className="text-slate-500 ml-2">
                <Trans>(checked {formatAge(r.daemon_public_ip_checked_at)})</Trans>
              </span>
            )}
            {r?.daemon_public_ip_error && (
              <span className="text-red-400 ml-2">({r.daemon_public_ip_error})</span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4">
          <span className="text-slate-400 w-44 shrink-0">
            <Trans>Pool URL hostname:</Trans>
          </span>
          <span className="text-slate-100">
            {r?.pool_url_hostname ?? <span className="text-slate-500">-</span>}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4">
          <span className="text-slate-400 w-44 shrink-0">
            <Trans>Resolves to:</Trans>
          </span>
          <span className="text-slate-100">
            {r?.pool_url_resolves_to ?? <span className="text-slate-500">-</span>}
            {r?.pool_url_resolve_error && (
              <span className="text-red-400 ml-2">({r.pool_url_resolve_error})</span>
            )}
          </span>
        </div>
        {r && r.daemon_public_ip && r.pool_url_resolves_to && (
          <div className="text-xs pt-1 italic">
            {ipsMatch ? (
              <span className="text-emerald-400">
                <Trans>Match - hostname is pointing at this box.</Trans>
              </span>
            ) : (
              <span className="text-red-400">
                <Trans>
                  Mismatch. If your daemon and Datum Gateway are on the same home network,
                  these should match. Usually this means your DDNS hasn't updated since the
                  ISP changed your public IP - configure DDNS below to fix it.
                </Trans>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Provider config. */}
      <div className="space-y-4">
        <label className="block">
          <span className="block text-sm text-slate-300 mb-1">
            <Trans>Provider</Trans>
          </span>
          <select
            value={draft.ddns_provider}
            onChange={(e) =>
              onChange('ddns_provider', e.target.value as AppConfig['ddns_provider'])
            }
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm"
          >
            <option value="">{t`Disabled`}</option>
            <option value="noip">No-IP (no-ip.com)</option>
            <option value="duckdns">DuckDNS (duckdns.org)</option>
            <option value="dyndns2">{t`Other (generic dyndns2)`}</option>
          </select>
          <span className="block text-xs text-slate-500 mt-1">
            <Trans>
              Leave Disabled if you maintain DDNS elsewhere (router, VPS, static IP). When
              set, the daemon pushes an update every 5 minutes (and at minimum hourly to
              keep free hostnames active).
            </Trans>
          </span>
        </label>

        {enabled && (
          <>
            <DdnsCredentialFields draft={draft} onChange={onChange} />

            {/* Last-push status. */}
            <div className="bg-slate-800/40 border border-slate-800 rounded p-3 text-xs space-y-1 font-mono">
              <div className="flex flex-wrap gap-x-4">
                <span className="text-slate-400 w-44 shrink-0">
                  <Trans>Last push status:</Trans>
                </span>
                <span
                  className={
                    r?.ddns.last_status === 'good' || r?.ddns.last_status === 'nochg'
                      ? 'text-emerald-300'
                      : r?.ddns.last_status
                        ? 'text-red-400'
                        : 'text-slate-500'
                  }
                >
                  {r?.ddns.last_status
                    ? localizeDdnsStatus(r.ddns.last_status)
                    : <Trans>(no push attempted yet)</Trans>}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4">
                <span className="text-slate-400 w-44 shrink-0">
                  <Trans>Last successful push:</Trans>
                </span>
                <span className="text-slate-100">
                  {r?.ddns.last_pushed_ip ?? <span className="text-slate-500">-</span>}
                  {r?.ddns.last_pushed_at != null && (
                    <span className="text-slate-500 ml-2">
                      {/* formatAge expects an absolute ms-epoch
                          timestamp - NOT a duration. Passing
                          (now - last_pushed_at) was the bug that
                          made the display read "20582d ago" - the
                          internal `now - ms` recovered the original
                          timestamp, which formatAge then interpreted
                          as "time since epoch zero" ≈ today. */}
                      {formatAge(r.ddns.last_pushed_at)}
                    </span>
                  )}
                </span>
              </div>
              {/* #250: the real "IP last changed" - distinct from the
                  hourly-heartbeat push above. Only meaningful once a
                  rotation has been recorded. */}
              <div className="flex flex-wrap gap-x-4">
                <span className="text-slate-400 w-44 shrink-0">
                  <Trans>IP last changed:</Trans>
                </span>
                <span className="text-slate-100">
                  {r?.last_ip_change ? (
                    <>
                      {r.last_ip_change.old_ip ? `${r.last_ip_change.old_ip} → ` : ''}
                      {r.last_ip_change.new_ip}
                      <span className="text-slate-500 ml-2">
                        {formatAge(r.last_ip_change.occurred_at)}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-500">
                      <Trans>no change observed yet</Trans>
                    </span>
                  )}
                </span>
              </div>
              {r?.ddns.last_error && (
                <div className="flex flex-wrap gap-x-4">
                  <span className="text-slate-400 w-44 shrink-0">
                    <Trans>Last error:</Trans>
                  </span>
                  <span className="text-red-400 break-words">{r.ddns.last_error}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
