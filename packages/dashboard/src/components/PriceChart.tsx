/**
 * Price chart: our primary bid (amber solid) vs the market-wide hashprice
 * (dashed purple), the cheapest fillable ask (cyan), the effective cap, and
 * - opt-in - the effective paid rate (emerald) reconstructed from per-tick
 * primary_bid_consumed_sat deltas. Under pay-your-bid (#53) the bid IS the
 * price paid, so the effective line should track the bid closely modulo
 * settlement smoothing. Bid events render as markers anchored to the
 * primary-price line. Sized and padded to match `HashrateChart` so the
 * X-axis aligns visually when stacked.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sideTooltipPosition } from '../lib/tooltipPosition';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
  type BidEventKind,
} from '@hashrate-autopilot/shared';

import {
  api,
  type BidEventView,
  type DecisionDetail,
  type DecisionSummary,
  type DepositView,
  type MetricPoint,
  type OurBlockMarker,
  type RewardEventView,
} from '../lib/api';
import {
  countPriorEpochPoolBlocks,
  inferRetargetBlockHeight,
  projectSoloSeries,
} from './HashrateChart';
import { type IpChangeMarkerEvent } from './IpChangeMarkers';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import {
  clientXToTickAt,
  CrosshairReadout,
  nearestTickIndex,
  useCrosshairPointer,
  type CrosshairReadoutRow,
  type SharedCrosshair,
} from '../lib/chartCrosshair';
import { darkenHex, getChartColor, parseOverrides } from '../lib/chartColors';
import { useSeriesVisibility } from '../lib/seriesVisibility';
import { copyToClipboard } from '../lib/clipboard';
import { useDenomination } from '../lib/denomination';
import {
  formatAgeMinutes,
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatTimestampHuman,
  formatTimestampUtc,
} from '../lib/format';
import { useDateTimeLocale, useFormatters, useLocale } from '../lib/locale';
import { SatSymbol } from './SatSymbol';
import {
  PoolBlockTooltip,
  RetargetTooltip,
  type PoolBlockTooltipState,
  type RetargetEvent,
  type RetargetTooltipState,
} from './HashrateChart';

const WIDTH = 880;
const HEIGHT = 200;
// Match HashrateChart's padding exactly so the two charts stack with a
// pixel-perfect X-axis alignment. Y labels are on the left; right
// padding only needs to keep the last X-axis timestamp from clipping.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };

// Tailwind amber-500 - shared with the Hashrate chart's delivered
// (Braiins) line so the two charts speak the same visual language
// for "our bid / what we pay Braiins for".
const COLOR_PRICE = '#f59e0b';
const COLOR_CREATE = '#34d399';
const COLOR_EDIT = '#fbbf24';
const COLOR_EDIT_SPEED = '#60a5fa';
const COLOR_CANCEL = '#f87171';
const COLOR_DEPOSIT = '#c084fc';

interface TooltipState {
  event: BidEventView;
  x: number;
  y: number;
  pinned: boolean;
}

interface RewardTooltipState {
  reward: RewardEventView;
  x: number;
  y: number;
  pinned: boolean;
}

interface DepositTooltipState {
  deposit: DepositView;
  x: number;
  y: number;
  pinned: boolean;
}

interface PricePoint {
  t: number;
  v: number;
}

/**
 * Rolling mean over a `{t,v}[]` series with a wall-clock window in
 * minutes. Window ≤ 1 returns the input unchanged (our "off" sentinel,
 * matching the Hashrate-chart helper). Anchors the smoothed value at
 * each original timestamp so the output index-aligns with the input.
 */
function rollingMeanPoints(
  pts: readonly PricePoint[],
  windowMinutes: number,
): PricePoint[] {
  if (windowMinutes <= 1 || pts.length === 0) return [...pts];
  const windowMs = windowMinutes * 60_000;
  const out: PricePoint[] = new Array(pts.length);
  let start = 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    sum += pts[i]!.v;
    const cutoff = pts[i]!.t - windowMs;
    while (start <= i && pts[start]!.t < cutoff) {
      sum -= pts[start]!.v;
      start += 1;
    }
    const count = i - start + 1;
    out[i] = { t: pts[i]!.t, v: count > 0 ? sum / count : pts[i]!.v };
  }
  return out;
}

const COLOR_HASHPRICE = '#a78bfa'; // violet-400
const COLOR_MAXBID = '#f87171'; // red-400
// fillable_ask = cheapestAskForDepth(orderbook, target_hashrate_ph).
// This is what the controller tracks: bid = fillable + overpay,
// clamped to the cap. Drawing it below the amber bid makes the
// overpay cushion visually explicit - every bid edit is explained
// by a move in this line.
const COLOR_FILLABLE = '#22d3ee'; // cyan-400
// Effective rate - what Braiins actually charged, per-tick from
// primary_bid_consumed_sat deltas. Emerald so it's clearly a
// "realised" number distinct from the bid (amber) and the market
// (orange/violet).
const COLOR_EFFECTIVE = '#34d399';
const COLOR_PAYOUT = '#10b981';

/**
 * #93: which series to draw on the Price chart's right Y-axis.
 * - 'none': hide the right axis entirely.
 * - 'estimated_block_reward': sat - follows the currency toggle.
 * - 'btc_usd_price': USD - always rendered as $ regardless of toggle.
 * - 'ocean_unpaid_sat': sat - follows the currency toggle.
 *
 * `network_difficulty` was previously also offered here but was
 * redundant with the same series on the hashrate chart (operator
 * caught it on review 2026-05-08); difficulty now lives only on the
 * hashrate chart.
 */
export type PriceRightAxis =
  | 'none'
  | 'effective_rate'
  | 'estimated_block_reward'
  | 'btc_usd_price'
  | 'ocean_unpaid_sat'
  | 'paid_total_sat'
  | 'lifetime_earnings_sat'
  // #149: solo-mining total power draw (W) across the fleet.
  | 'solo_power_watts'
  | 'total_balance_sat'
  // #164: per-tick (our_bid - fillable_ask), rolling-mean smoothed.
  // Reflects what the controller targeted - intent before billing.
  | 'avg_overpay_intent'
  // #164: per-tick (effective_rate - fillable_ask). Inherits the
  // null-gap behaviour of effective_rate during zero-delivery
  // windows, so the line breaks rather than reads a misleading
  // continuity through outages.
  | 'avg_overpay_settled';

/** Per-tick aggregated fleet series row from /api/solo-miners/series. */
export interface SoloSeriesRow {
  tick_at: number;
  total_hashrate_ghs: number | null;
  total_power_w: number | null;
  max_temp_c: number | null;
  device_count: number;
  max_best_diff: number | null;
}

// Matches HashrateChart's PADDING_RIGHT_WITH_SHARE_LOG (80) so the
// right-axis tick column lines up vertically across both stacked
// charts. Also widens the gap between tick text and the rotated
// axis label - 60px was tight, especially for "$" + 5-digit values.
const PRICE_RIGHT_AXIS_PADDING = 80;

/**
 * Sat-input compact tick formatter that respects the operator's
 * currency toggle. Used for sat-denominated right-axis series
 * (estimated_block_reward, ocean_unpaid). USD path needs the BTC
 * oracle - falls back to sat when no oracle is configured. BTC path
 * uses adaptive decimals so sub-1 values stay readable.
 */
function formatSatCompact(
  sat: number,
  denomination: ReturnType<typeof useDenomination>,
  locale: string | undefined,
  axisSpan?: number,
): string {
  if (denomination.mode === 'usd' && denomination.btcPrice !== null) {
    const usdSpan = axisSpan !== undefined ? (axisSpan / 100_000_000) * denomination.btcPrice : undefined;
    return `$${formatCompactNumber((sat / 100_000_000) * denomination.btcPrice, locale, usdSpan)}`;
  }
  if (denomination.mode === 'btc') {
    const btc = sat / 100_000_000;
    const abs = Math.abs(btc);
    const btcSpan = axisSpan !== undefined ? axisSpan / 100_000_000 : undefined;
    const decimalsForSpan = (base: number): number => {
      if (btcSpan === undefined || btcSpan <= 0) return base;
      const spanDigits = -Math.floor(Math.log10(btcSpan));
      return Math.max(base, spanDigits + 1);
    };
    const fmt = (decimals: number): string =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      }).format(btc);
    if (abs >= 1) return fmt(decimalsForSpan(2));
    if (abs >= 0.1) return fmt(decimalsForSpan(4));
    if (abs >= 0.001) return fmt(decimalsForSpan(6));
    if (abs === 0) return '0';
    return btc.toExponential(2);
  }
  return formatCompactNumber(sat, locale, axisSpan);
}

export const PriceChart = memo(function PriceChart({
  points,
  events = [],
  showEventKinds,
  maxOverpayVsHashpriceSatPerPhDay = null,
  overpaySatPerPhDay = null,
  priceSmoothingMinutes = 1,
  historicalPayoutsOffsetSat = 0,
  rightAxisSeries = 'none',
  rewardEvents = [],
  deposits = [],
  ourBlocks = [],
  ipChangeEvents = [],
  blockExplorerTemplate,
  txExplorerTemplate,
  shareLogPct = null,
  markersHiddenKind = null,
  markersHiddenCount = 0,
  soloSeries = [],
  bidPauseIntervals = [],
  idleModeIntervals = [],
  viewportHandlers,
  wheelRef,
  isDragging = false,
  isFocused = false,
  viewportSince,
  viewportUntil,
  chartColorOverrides,
  crosshair,
  focusEventId = null,
  onFocusEventRendered,
}: {
  points: readonly MetricPoint[];
  events?: readonly BidEventView[];
  /**
   * Which event kinds to render as markers on this chart at the
   * current range. Empty array = no markers (1m/1y/all). At 1w the
   * caller passes the "rare" kinds only (CREATE_BID, EDIT_SPEED,
   * CANCEL_BID) because EDIT_PRICE fires too often to be useful at
   * that zoom (#75). The legend is filtered to match.
   */
  showEventKinds: readonly BidEventKind[];
  /**
   * Current config's dynamic-cap allowance. When set, the cap line is
   * computed per-tick as `min(max_bid, hashprice + this)` rather than
   * the flat `max_bid` - matches what decide() actually uses each
   * tick. Null → fall back to max_bid. Applied as a constant across
   * the history (we don't store historical config per tick), so past
   * effective caps are approximate if the operator changed this
   * value.
   */
  maxOverpayVsHashpriceSatPerPhDay?: number | null;
  /**
   * Current config's overpay above fillable (sat/PH/day). Used in the
   * pinned event tooltip so the operator can read `fillable` and
   * `overpay` as first-class rows. Applied as a constant across
   * history - past tooltips are approximate if the value was tuned.
   */
  overpaySatPerPhDay?: number | null;
  /**
   * Rolling-mean window (minutes) applied to `our bid` and `effective`
   * only. 1 = raw (no smoothing). Mirrors the smoothing knobs the
   * Hashrate chart already has for the Braiins and Datum series
   * (issue #42). The noisy-per-tick `effective` line in particular
   * benefits - `amount_consumed_sat` updates asynchronously from
   * `avg_speed_ph` at Braiins, so a tick-resolution rate can wiggle
   * around the real trend by ±a few percent.
   */
  priceSmoothingMinutes?: number;
  /**
   * #170 follow-up: operator-entered offset (sat) for pre-installation
   * / off-chain earnings that the on-chain payout-observer can't see.
   * Added to every non-null point on the `paid_total_sat` and
   * `lifetime_earnings_sat` right-axis series so the lifetime line
   * starts at this value instead of zero - matches the Status finance
   * panel's net P&L, which folds the same offset into `net_sat`.
   * Default 0 (no offset).
   */
  historicalPayoutsOffsetSat?: number;
  /**
   * #93: secondary Y-axis series. 'none' hides the right axis.
   * `'effective_rate'` plots the window-aggregated effective rate
   * (Δconsumed ÷ delivered×Δt) on the right axis with its own scale,
   * so the line's per-tick volatility no longer drags the left-axis
   * range - that was the rationale for the legacy `show_effective_rate_on_price_chart`
   * checkbox. The toggle migrated to this dropdown 2026-05-05.
   */
  rightAxisSeries?: PriceRightAxis;
  /**
   * On-chain payouts that have credited the configured payout
   * address. Renders as small filled-circle dots on the right-axis
   * line when `rightAxisSeries` is `paid_total_sat` or
   * `lifetime_earnings_sat`. Click pins a tooltip with block height,
   * payout date, sat amount, and an explorer link.
   */
  rewardEvents?: readonly RewardEventView[];
  /**
   * Credited Braiins deposits. Renders as purple fuel icons at the
   * top of the chart with dashed vertical lines (#211).
   */
  deposits?: readonly DepositView[];
  /**
   * Recent Ocean pool blocks (TIDES-credited). Renders as small
   * filled-circle dots on the right-axis line when `rightAxisSeries`
   * is `ocean_unpaid_sat` or `lifetime_earnings_sat`. Reuses the
   * pool-block tooltip from HashrateChart so the operator sees the
   * same reward / our-share / BIP-110 context regardless of which
   * chart they hovered.
   */
  ourBlocks?: readonly OurBlockMarker[];
  /** #250: public-IP change events, drawn as router-icon markers. */
  ipChangeEvents?: ReadonlyArray<IpChangeMarkerEvent>;
  /** Block-explorer URL template for pool-block markers (`{hash}` / `{height}` placeholders). */
  blockExplorerTemplate?: string;
  /** Transaction-explorer URL template for reward-event markers (`{txid}` / `{hash}` placeholders). */
  txExplorerTemplate?: string;
  /** Live share_log %, used by the pool-block tooltip when there's no per-block historical capture. */
  shareLogPct?: number | null;
  /**
   * #123: when the dashboard's count-based marker filter has dropped
   * markers from the visible list, this carries the kind of drop
   * (`'edit_price'` = EDIT_PRICE-only suppression, the chart still
   * shows CREATE / EDIT_SPEED / CANCEL; `'all'` = even after hiding
   * EDIT_PRICE the count was over the cap, so everything's hidden).
   * Null = no count-based filter triggered.
   */
  markersHiddenKind?: null | 'edit_price' | 'pool_block' | 'reward_event' | 'all';
  /** #123: how many markers were dropped (for the inline hint text). */
  markersHiddenCount?: number;
  /** #149: per-tick aggregated solo-mining fleet series; used when rightAxisSeries == 'solo_power_watts'. */
  soloSeries?: ReadonlyArray<SoloSeriesRow>;
  /**
   * #287 follow-up: Braiins-side bid-pause spans (BID_PAUSED →
   * BID_RESUMED pairs, computed by the caller from the bid-event
   * stream). Rendered as hatched background bands tinted with the
   * `events.bid_paused` color slot. Open-ended intervals use
   * ±Infinity and get clamped to the data range here.
   */
  bidPauseIntervals?: ReadonlyArray<{ x0: number; x1: number }>;
  /**
   * #287 follow-up v3: run-mode idle spans (DRY_RUN / PAUSED),
   * computed by the caller from per-tick run_mode with edges snapped
   * to MODE_CHANGE event timestamps where available - so the band
   * edges line up with the power markers instead of tick boundaries.
   */
  idleModeIntervals?: ReadonlyArray<{ x0: number; x1: number; mode: 'DRY_RUN' | 'PAUSED' }>;
  viewportHandlers?: {
    onPointerDown: React.PointerEventHandler<SVGSVGElement>;
    onPointerMove: React.PointerEventHandler<SVGSVGElement>;
    onPointerUp: React.PointerEventHandler<SVGSVGElement>;
    onDoubleClick: () => void;
  };
  wheelRef?: (node: SVGSVGElement | null) => void;
  isDragging?: boolean;
  isFocused?: boolean;
  viewportSince?: number;
  viewportUntil?: number;
  /** #238: per-series chart color overrides as a JSON string from
   *  `config.chart_color_overrides`. */
  chartColorOverrides?: string;
  /** #257: shared crosshair state (synced with HashrateChart). When
   *  undefined the crosshair is disabled entirely. */
  crosshair?: SharedCrosshair;
  /** #285 follow-up: bid_events.id from the URL `focus_event` handoff.
   *  The matching marker renders a pulsing amber sonar beacon on top
   *  of its glyph so the operator can spot which event they jumped
   *  to. The beacon is purely visual; clicking it still routes
   *  through the normal onMarkerClick path. Status clears this back
   *  to null a few seconds after onFocusEventRendered fires. */
  focusEventId?: number | null;
  /** #288: fired (possibly more than once) when the focused event's
   *  marker is actually present in the rendered set. Status starts
   *  the beacon's clear countdown on the first call, so slow metrics/
   *  events queries no longer eat the visible pulse window. */
  onFocusEventRendered?: (id: number) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  // #238: resolve per-series colors from the operator's config.
  // Shadows the module-scope `COLOR_*` defaults so the rest of the
  // component body keeps using the same names without changes.
  const _colorOverrides = useMemo(
    () => parseOverrides(chartColorOverrides),
    [chartColorOverrides],
  );
  /* eslint-disable @typescript-eslint/no-shadow */
  const COLOR_PRICE = getChartColor('price.our_bid', _colorOverrides);
  const COLOR_FILLABLE = getChartColor('price.fillable', _colorOverrides);
  const COLOR_HASHPRICE = getChartColor('price.hashprice', _colorOverrides);
  const COLOR_MAXBID = getChartColor('price.max_bid', _colorOverrides);
  const COLOR_DEPOSIT = getChartColor('price.marker_deposit', _colorOverrides);
  const COLOR_PAYOUT_GEM = getChartColor('price.marker_payout_gem', _colorOverrides);
  const COLOR_OUR_BLOCK = getChartColor('hashrate.pool_block_ours', _colorOverrides);
  const COLOR_POOL_BLOCK = getChartColor('hashrate.pool_block_others', _colorOverrides);
  const COLOR_BIP110 = getChartColor('hashrate.pool_block_bip110', _colorOverrides);
  const COLOR_RETARGET = getChartColor('hashrate.marker_retarget', _colorOverrides);
  const COLOR_CREATE = getChartColor('events.create', _colorOverrides);
  const COLOR_EDIT = getChartColor('events.edit_price', _colorOverrides);
  const COLOR_EDIT_SPEED = getChartColor('events.edit_speed', _colorOverrides);
  const COLOR_CANCEL = getChartColor('events.cancel', _colorOverrides);
  // #287 follow-up: mode-change + pause/resume marker colours, also
  // tinting the idle-state background bands.
  const COLOR_MODE_CHANGE = getChartColor('events.mode_change', _colorOverrides);
  const COLOR_BID_PAUSED = getChartColor('events.bid_paused', _colorOverrides);
  const COLOR_BID_RESUMED = getChartColor('events.bid_resumed', _colorOverrides);
  const COLOR_RIGHT_AXIS = getChartColor('price.right_axis', _colorOverrides);
  /* eslint-enable @typescript-eslint/no-shadow */
  // #280: clickable-legend series visibility, persisted per device
  // under this chart's own key. `hidden` feeds the Y-axis autoscale
  // inside chartData and the per-series render gates below.
  const { hidden, isHidden, toggle } = useSeriesVisibility('priceHiddenSeries');
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // Per-marker tooltip state for the new on-line dots: pool-block
  // markers reuse the rich HashrateChart tooltip; reward-event
  // markers use a smaller bespoke tooltip with payout date + amount
  // + explorer link.
  const [poolBlockTip, setPoolBlockTip] = useState<PoolBlockTooltipState | null>(null);
  const [rewardTip, setRewardTip] = useState<RewardTooltipState | null>(null);
  const [depositTip, setDepositTip] = useState<DepositTooltipState | null>(null);
  const [retargetTip, setRetargetTip] = useState<RetargetTooltipState | null>(null);
  const [unpaidDropTip, setUnpaidDropTip] = useState<{
    tick_at: number; prev: number; cur: number;
    x: number; y: number; pinned: boolean;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const chartHeight = expanded ? HEIGHT * 2 : HEIGHT;
  const { intlLocale } = useLocale();
  const dateTimeLocale = useDateTimeLocale();
  const denomination = useDenomination();

  const chartData = useMemo(() => {
    const pricePoints: PricePoint[] = points
      .filter((p) => Number.isFinite(p.our_primary_price_sat_per_ph_day))
      .map((p) => ({ t: p.tick_at, v: p.our_primary_price_sat_per_ph_day as number }));

    const hashpricePoints: PricePoint[] = points
      .filter((p) => Number.isFinite(p.hashprice_sat_per_ph_day))
      .map((p) => ({ t: p.tick_at, v: p.hashprice_sat_per_ph_day as number }));

    const fillablePoints: PricePoint[] = points
      .filter((p) => Number.isFinite(p.fillable_ask_sat_per_ph_day))
      .map((p) => ({ t: p.tick_at, v: p.fillable_ask_sat_per_ph_day as number }));

    // Effective rate - what Braiins actually charged per PH per day -
    // computed as a WINDOW-AGGREGATED ratio of total consumed vs total
    // PH-days delivered over the last N minutes, anchored at each tick:
    //
    //   rate[i] = Σ Δconsumed_j / Σ (delivered_ph_j × Δt_j / 86_400_000)
    //
    // (Second term = PH-days. sat ÷ PH-days = sat/PH/day.)
    //
    // Why aggregate the numerator and denominator separately rather
    // than averaging per-tick rates: Braiins' `amount_consumed_sat`
    // updates asynchronously from our tick loop. Some ticks report
    // Δconsumed = 0 (Braiins hasn't settled the window yet); the next
    // tick absorbs the catch-up and reports a big delta. Per-tick
    // rates swing between "0" and "multiples of the real rate". Naive
    // rolling-mean of ratios amplifies that swing because the zeros
    // drag the mean down and the spikes, even after outlier rejection,
    // leave a sparse jagged survivor set. Summing-then-dividing is the
    // correct time-weighted average and naturally absorbs the update
    // lag (#49 follow-up).
    //
    // Window = max(3, priceSmoothingMinutes) - 1-minute resolution is
    // smaller than Braiins' own settlement cadence, so a minimum of 3
    // minutes keeps the line legible even with smoothing "off".
    //
    // Per-interval validity filters: skip when either consumed endpoint
    // is null (pre-migration or no primary bid), counter reset
    // (Δ < 0), tick gap > MAX_EFFECTIVE_DT_MS (daemon restart or
    // legitimate bucket boundary on long ranges), near-zero delivery.
    // Final outlier rejection: if aggregated rate exceeds 1.5× bid at
    // the anchor tick, drop - the bid is a hard upper bound by
    // definition, anything above is a computation artifact.
    //
    // Long-range scaling (#81): on 1w / 1m / 1y / all the API
    // pre-aggregates ticks into 30-min / 1-h / 1-day buckets via
    // CHART_RANGE_SPECS. The aggregated rows preserve
    // primary_bid_consumed_sat as MAX over the bucket, so per-bucket
    // deltas are still meaningful - but the previous fixed
    // 5-minute MAX_EFFECTIVE_DT_MS rejected every pair on long ranges
    // and the line vanished. Scale all the per-tick-rate cadence
    // gates to the median dt of the points stream so bucketed data
    // flows through naturally.
    const medianDtMs = (() => {
      if (points.length < 2) return 60_000;
      const dts: number[] = [];
      for (let k = 1; k < points.length; k += 1) {
        dts.push(points[k]!.tick_at - points[k - 1]!.tick_at);
      }
      dts.sort((a, b) => a - b);
      return dts[Math.floor(dts.length / 2)] ?? 60_000;
    })();
    const MAX_EFFECTIVE_DT_MS = Math.max(5 * 60_000, 3 * medianDtMs);
    const OUTLIER_MULTIPLE = 1.5;
    const effectiveWindowMs = Math.max(
      Math.max(3, priceSmoothingMinutes) * 60_000,
      2 * medianDtMs,
    );
    // Minimum wall-clock span the aggregation must cover before we
    // emit a point. Without this, the first 1-2 ticks after a
    // migration backfill or daemon restart produce legitimate-but-
    // wildly-off rates: Braiins' amount_consumed_sat counter only
    // updates every ~minute on its side, so the first delta we see
    // in a fresh observation window spans more *actual* matching
    // activity than its wall-clock interval suggests - inflating
    // the computed rate transiently. Requiring ≥ half the window
    // means the series doesn't draw until the aggregation has
    // enough history to be meaningful (~1.5 min for "off", 5 min
    // for a 10-min smoothing setting). On bucketed long ranges one
    // bucket already covers minutes-to-days, so the floor is the
    // bucket itself rather than 90s.
    const MIN_SPAN_MS = Math.max(
      Math.min(90_000, medianDtMs),
      Math.floor(effectiveWindowMs / 2),
    );
    const effectivePoints: PricePoint[] = [];
    // Braiins' primary_bid_consumed_sat counter settles in lumps - for
    // minutes at a time the counter stays flat while delivered_ph
    // keeps reporting a lagged nonzero value. Averaging those "stale
    // settlement" pairs into the rate pulls it toward zero, producing
    // visually dramatic dips that imply we got hashrate almost for
    // free - wrong and misleading. Two guards:
    //   1. Skip zero-delta pairs entirely (neither numerator nor
    //      denominator advance). They carry no information - the
    //      counter hasn't reported yet.
    //   2. Require at least MIN_NONZERO_PAIRS real settlements inside
    //      the window before trusting the average. Settlement lulls
    //      become gaps in the line (truthful) rather than dips toward
    //      zero (misleading). On bucketed long ranges one pair already
    //      represents many real settlements (a 1-h bucket aggregates
    //      ~60 individual settlements; a 1-d bucket many more), so
    //      drop the floor to 1 once medianDtMs is large.
    const MIN_NONZERO_PAIRS = medianDtMs > 5 * 60_000 ? 1 : 3;
    // #164 follow-up: settled-overpay accumulators, parallel to the
    // effective-rate accumulators but using the same delta-weighted
    // form the stats card uses. The chart's `rate = deltaSum/phDaySum`
    // is BIASED LOW during periods where delivered_ph is still on its
    // 5-min lag (Braiins reports an elevated delivered_ph for minutes
    // after delivery actually drops), because phDaySum overestimates
    // work done. The card's delta-weighted form
    // `SUM(delta) / SUM(delta/bid)` is bid-normalised and doesn't
    // touch delivered_ph, so it stays consistent. Same form per-tick
    // here: settled_overpay = SUM(delta × (bid - fillable) / bid)
    //                       / SUM(delta / bid)
    // The two accumulators below build numerator and denominator;
    // they share the same per-pair filters as the effective-rate
    // accumulation above.
    const settledPoints: PricePoint[] = [];
    for (let i = 1; i < points.length; i += 1) {
      let deltaSum = 0;
      let phDaySum = 0;
      let nonZeroPairs = 0;
      let earliestCoveredT: number | null = null;
      let settledNumSum = 0;
      let settledDenSum = 0;
      let settledPairs = 0;
      for (let j = i; j >= 1; j -= 1) {
        const anchorT = points[i]!.tick_at;
        const curT = points[j]!.tick_at;
        if (anchorT - curT > effectiveWindowMs) break;
        const cur = points[j]!;
        const prev = points[j - 1]!;
        const c0 = prev.primary_bid_consumed_sat;
        const c1 = cur.primary_bid_consumed_sat;
        if (c0 == null || c1 == null) break;
        // Both endpoints must be > 0. A mid-sequence zero is a
        // transient "no primary bid" snapshot (a blink during a
        // CREATE/EDIT where Braiins reports amount_sat=0). LAG across
        // a zero-dip turns the full counter on the recovery side into
        // a bogus delta worth hundreds of thousands of sat, which
        // then dominates any window it lands in.
        if (c0 <= 0 || c1 <= 0) continue;
        const delta = c1 - c0;
        if (!Number.isFinite(delta) || delta < 0) break;
        const dt = curT - prev.tick_at;
        if (dt <= 0 || dt > MAX_EFFECTIVE_DT_MS) break;
        if (!Number.isFinite(cur.delivered_ph) || cur.delivered_ph < 0.05) continue;
        if (delta === 0) continue;
        // Lag filter: if the observed delta is much smaller than what
        // `our_bid × delivered_ph × dt` predicts, it's a Braiins outage
        // tick where the counter has nearly stopped while delivered_ph
        // still carries its lagged rolling value. Folding those pairs
        // into the rate drags it implausibly low. Under pay-your-bid
        // (#53) a healthy pair settles at ~100% of expected; the 30%
        // floor catches outage pairs (typically <10% of expected)
        // while leaving normal settlement variance untouched. Possible
        // re-tune once we have more data on day-to-day settlement
        // jitter.
        const bid = cur.our_primary_price_sat_per_ph_day;
        if (bid !== null && Number.isFinite(bid) && bid > 0) {
          const expected = (bid * cur.delivered_ph * dt) / 86_400_000;
          if (expected > 0 && delta / expected < 0.3) continue;
        }
        deltaSum += delta;
        phDaySum += (cur.delivered_ph * dt) / 86_400_000;
        earliestCoveredT = prev.tick_at;
        nonZeroPairs += 1;
        // Settled-overpay accumulators (#164): only count pairs where
        // both bid and fillable are present and bid > 0.
        const fillable = cur.fillable_ask_sat_per_ph_day;
        if (
          bid !== null && Number.isFinite(bid) && bid > 0 &&
          fillable !== null && Number.isFinite(fillable)
        ) {
          settledNumSum += (delta * (bid - fillable)) / bid;
          settledDenSum += delta / bid;
          settledPairs += 1;
        }
      }
      if (earliestCoveredT === null || phDaySum <= 0) continue;
      if (nonZeroPairs < MIN_NONZERO_PAIRS) continue;
      const span = points[i]!.tick_at - earliestCoveredT;
      if (span < MIN_SPAN_MS) continue;
      const rate = deltaSum / phDaySum;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      // Hard ceiling: under pay-your-bid the bid IS the per-EH-day
      // price, so the realised effective rate cannot legitimately
      // exceed our bid. Clamp rather than filter so the series stays
      // continuous; anything still above that after the zero-dip
      // filter is a residual numerical artifact.
      const bid = points[i]!.our_primary_price_sat_per_ph_day;
      const clamped =
        bid !== null && Number.isFinite(bid) && rate > bid ? bid : rate;
      if (
        bid !== null &&
        Number.isFinite(bid) &&
        rate > bid * OUTLIER_MULTIPLE
      ) {
        continue;
      }
      effectivePoints.push({ t: points[i]!.tick_at, v: clamped });
      // Emit settled-overpay at the same anchor tick when the
      // accumulators have enough valid pairs and a non-zero
      // denominator. Same MIN_NONZERO_PAIRS + MIN_SPAN_MS gates the
      // rate uses, except evaluated against the settled-pair counter.
      if (
        settledPairs >= MIN_NONZERO_PAIRS &&
        settledDenSum > 0 &&
        span >= MIN_SPAN_MS
      ) {
        const settled = settledNumSum / settledDenSum;
        if (Number.isFinite(settled)) {
          settledPoints.push({ t: points[i]!.tick_at, v: settled });
        }
      }
    }

    // The line the operator actually cares about: the effective cap
    // that decide() uses each tick, which is the tighter of the fixed
    // max_bid and the dynamic hashprice+max_overpay. When the dynamic
    // cap isn't configured, this collapses to max_bid and the line
    // looks exactly like the previous "max bid" line.
    const capPoints: PricePoint[] = points
      .filter((p) => {
        if (!Number.isFinite(p.max_bid_sat_per_ph_day)) return false;
        if (maxOverpayVsHashpriceSatPerPhDay !== null && !Number.isFinite(p.hashprice_sat_per_ph_day)) return false;
        return true;
      })
      .map((p) => {
        const fixed = p.max_bid_sat_per_ph_day as number;
        const hashprice = Number.isFinite(p.hashprice_sat_per_ph_day)
          ? (p.hashprice_sat_per_ph_day as number)
          : null;
        const dynamic =
          maxOverpayVsHashpriceSatPerPhDay !== null && hashprice !== null
            ? hashprice + maxOverpayVsHashpriceSatPerPhDay
            : null;
        const v = dynamic !== null ? Math.min(fixed, dynamic) : fixed;
        return { t: p.tick_at, v };
      });

    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    const dataMinX = xs[0]!;
    const dataMaxX = xs[xs.length - 1]!;
    const minX = viewportSince ?? dataMinX;
    const maxX = viewportUntil ?? dataMaxX;

    // #275 follow-up: Y-axis auto-range samples ONLY the visible
    // window. The fetched data extends one window-width past each
    // viewport edge (prefetch buffer for smooth panning), and sampling
    // that buffer let an off-screen price spike stretch the visible
    // Y-axis with nothing on the chart explaining it - the same
    // hidden-buffer surprise as the stat tiles in #275. The line
    // paths still cover the full buffer (clipped at the plot edge)
    // so panning stays seamless; only the scale is viewport-true.
    const inView = (t: number): boolean => t >= minX && t <= maxX;
    const eventPrices = events
      .filter((e) => inView(e.occurred_at))
      .flatMap((e) => [e.old_price_sat_per_ph_day, e.new_price_sat_per_ph_day])
      .filter((p): p is number => p !== null && Number.isFinite(p));
    // Deliberately exclude capPoints from Y-axis auto-scaling. The cap
    // is usually far above the live data and letting it set the range
    // squashes the interesting lines (bid, fillable, hashprice) into
    // a thin strip at the bottom. If the cap happens to fall inside
    // the auto-ranged window it's drawn; otherwise it sits above the
    // viewport and the excluded-zone shading clips to the top edge -
    // which is exactly the intended "the ceiling is up there somewhere"
    // affordance without hijacking the chart.
    // Include effectivePoints in Y-axis scaling. With window-aggregated
    // rates (not per-tick ratios) the values are well-bounded - the
    // 1.5×-bid last-chance outlier filter prevents any spike from
    // pulling the scale, and legitimate effective values routinely
    // sit below the bid/fillable band (the whole point of charting
    // this line is to see that gap). Earlier we excluded effective
    // to protect against per-tick rate spikes; that threat is gone
    // now that aggregation is numerator-and-denominator-summed.
    // Effective values are included in Y-scale sampling ONLY when the
    // operator has opted-in to seeing the line. Otherwise they're
    // excluded - the whole point of the toggle is that the flatter
    // bid/fillable/hashprice detail is crushed when the volatile
    // effective line drags the Y-axis range down.
    // #280: the Y-axis autoscales to only the *visible* line series, so
    // hiding e.g. hashprice lets the bid/fillable band fill the chart.
    // A series toggled off in the legend is dropped from the sample.
    let priceSample = [
      ...(hidden.has('bid') ? [] : pricePoints.filter((p) => inView(p.t)).map((p) => p.v)),
      ...(hidden.has('hashprice') ? [] : hashpricePoints.filter((p) => inView(p.t)).map((p) => p.v)),
      ...(hidden.has('fillable') ? [] : fillablePoints.filter((p) => inView(p.t)).map((p) => p.v)),
      ...(hidden.has('bid') ? [] : eventPrices),
    ];
    if (priceSample.length === 0) {
      // Degenerate viewport with no points in view (panned past the
      // data, or mid-fetch), or every series hidden. Fall back to the
      // full fetched sample of the still-visible series so the axis
      // holds a sane scale instead of snapping to 0..1.
      priceSample = [
        ...(hidden.has('bid') ? [] : pricePoints.map((p) => p.v)),
        ...(hidden.has('hashprice') ? [] : hashpricePoints.map((p) => p.v)),
        ...(hidden.has('fillable') ? [] : fillablePoints.map((p) => p.v)),
      ];
    }
    const hasPrice = priceSample.length > 0;
    let priceMinRaw = hasPrice ? Infinity : 0;
    let priceMaxRaw = hasPrice ? -Infinity : 1;
    if (hasPrice) { for (const v of priceSample) { if (v < priceMinRaw) priceMinRaw = v; if (v > priceMaxRaw) priceMaxRaw = v; } }
    const priceSpan = Math.max(1, priceMaxRaw - priceMinRaw);

    const yTicks = niceYTicks(
      Math.max(0, priceMinRaw - priceSpan * 0.05),
      priceMaxRaw + priceSpan * 0.05,
      5,
    );
    const priceMin = yTicks[0] ?? 0;
    const priceMax = yTicks[yTicks.length - 1] ?? 1;

    // Per-tick effective rate values (sat/PH/day), aligned with the
    // points array - sparse list lifted into a map keyed on tick_at
    // for O(1) lookup. Used by the effective_rate right-axis case.
    const effectiveByTick = new Map<number, number>(
      effectivePoints.map((p) => [p.t, p.v]),
    );

    // #164: per-tick (our_bid - fillable_ask) for the intent right-axis
    // line. Rolling-mean smoothed using `braiins_price_smoothing_minutes`
    // - same setting that smooths `our bid` and `fillable_ask` lines
    // themselves, so the three series share a cadence. Filter: both
    // values must be finite numbers on the tick.
    const intentPoints: PricePoint[] = points
      .filter((p) =>
        Number.isFinite(p.our_primary_price_sat_per_ph_day) &&
        Number.isFinite(p.fillable_ask_sat_per_ph_day),
      )
      .map((p) => ({
        t: p.tick_at,
        v: (p.our_primary_price_sat_per_ph_day as number) -
          (p.fillable_ask_sat_per_ph_day as number),
      }));
    const smoothedIntentPoints = rollingMeanPoints(intentPoints, priceSmoothingMinutes);
    const intentByTick = new Map<number, number>(
      smoothedIntentPoints.map((p) => [p.t, p.v]),
    );

    // settledPoints is built in the loop above using the card's
    // delta-weighted SUM(delta × (bid - fillable) / bid) / SUM(delta / bid)
    // form (#164 follow-up). That's a sliding-window aggregation
    // already, so additional rolling-mean smoothing here would just
    // smear the signal without improving fidelity.
    const settledByTick = new Map<number, number>(
      settledPoints.map((p) => [p.t, p.v]),
    );

    // #93: right-axis spec, derived from rightAxisSeries. Each branch
    // pulls per-point values off MetricPoint and returns a tick
    // formatter + axis label. 'none' bypasses the right axis
    // entirely. The padded right-edge widens when an axis is shown
    // so labels have breathing room.
    const rightAxis: {
      values: (number | null)[];
      stroke: string;
      axisLabel: string;
      formatTick: (v: number, axisSpan?: number) => string;
    } | null = (() => {
      switch (rightAxisSeries) {
        case 'none':
          return null;
        case 'effective_rate':
          return {
            values: points.map((p) => effectiveByTick.get(p.tick_at) ?? null),
            // #149: right-axis colour convention - operator wants
            // every right-axis series rendered in a consistent purple
            // since only one ever shows at a time. Was green (#34d399).
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: 'effective (sat/PH/day)',
            formatTick: (v) =>
              new Intl.NumberFormat(intlLocale, {
                maximumFractionDigits: 0,
              }).format(v),
          };
        case 'estimated_block_reward':
          return {
            values: points.map((p) => p.estimated_block_reward_sat),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: `block reward (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v, span) => formatSatCompact(v, denomination, intlLocale, span),
          };
        case 'btc_usd_price':
          return {
            values: points.map((p) => p.btc_usd_price),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: 'BTC/USD ($)',
            // The $ prefix + thousand-sep dot makes "$80.500" 7
            // chars, which overruns the right-axis padding. Keep
            // the k suffix for USD prefix specifically - "$80,5k"
            // is 6 chars and fits cleanly.
            formatTick: (v) => {
              const abs = Math.abs(v);
              const fmt = (x: number, d: number): string =>
                new Intl.NumberFormat(intlLocale, {
                  minimumFractionDigits: d,
                  maximumFractionDigits: d,
                }).format(x);
              if (abs >= 1e6) return `$${fmt(v / 1e6, 1)}M`;
              if (abs >= 1000) return `$${fmt(v / 1000, 1)}k`;
              return `$${fmt(v, 0)}`;
            },
          };
        case 'ocean_unpaid_sat':
          return {
            values: points.map((p) => p.ocean_unpaid_sat),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: `unpaid (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v, span) => formatSatCompact(v, denomination, intlLocale, span),
          };
        case 'paid_total_sat':
          return {
            values: points.map((p) =>
              p.paid_total_sat === null
                ? null
                : p.paid_total_sat + historicalPayoutsOffsetSat,
            ),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: `paid total (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v, span) => formatSatCompact(v, denomination, intlLocale, span),
          };
        case 'total_balance_sat':
          return {
            values: points.map((p) => p.total_balance_sat),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: `Braiins balance (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v, span) => formatSatCompact(v, denomination, intlLocale, span),
          };
        case 'solo_power_watts': {
          // Nearest-neighbor join with 15s tolerance - see HashrateChart's
          // projectSoloSeries comment for the rationale. tick_metrics
          // and solo_miner_samples are written at slightly-different
          // moments during the same controller tick.
          const xs = points.map((p) => p.tick_at);
          return {
            values: projectSoloSeries(xs, soloSeries, (r) => r.total_power_w),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: 'Bitaxe power (W)',
            // Watts displayed without the `k` shortening - home Bitaxe
            // fleets are typically 15-100W where kW scale would round
            // to zero.
            formatTick: (v) =>
              `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(v)} W`,
          };
        }
        case 'lifetime_earnings_sat':
          return {
            values: points.map((p) =>
              p.paid_total_sat === null && p.ocean_unpaid_sat === null
                ? null
                : (p.paid_total_sat ?? 0) +
                  (p.ocean_unpaid_sat ?? 0) +
                  historicalPayoutsOffsetSat,
            ),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: `lifetime (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v, span) => formatSatCompact(v, denomination, intlLocale, span),
          };
        case 'avg_overpay_intent':
          return {
            values: points.map((p) => intentByTick.get(p.tick_at) ?? null),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: 'avg overpay intent (sat/PH/day)',
            formatTick: (v) =>
              new Intl.NumberFormat(intlLocale, {
                maximumFractionDigits: 0,
              }).format(v),
          };
        case 'avg_overpay_settled':
          return {
            values: points.map((p) => settledByTick.get(p.tick_at) ?? null),
            stroke: COLOR_RIGHT_AXIS,
            axisLabel: 'avg overpay settled (sat/PH/day)',
            formatTick: (v) =>
              new Intl.NumberFormat(intlLocale, {
                maximumFractionDigits: 0,
              }).format(v),
          };
      }
    })();
    const hasRightAxis =
      rightAxis !== null && rightAxis.values.some((v) => v !== null);
    const padRight = hasRightAxis
      ? PRICE_RIGHT_AXIS_PADDING
      : PADDING.right;

    let rightYTicks: number[] = [];
    let rightYMin = 0;
    let rightYMax = 1;
    if (hasRightAxis && rightAxis) {
      let rmin = Infinity;
      let rmax = -Infinity;
      for (let i = 0; i < rightAxis.values.length; i += 1) {
        const raw = rightAxis.values[i];
        if (raw === null || raw === undefined || !Number.isFinite(raw)) continue;
        const t = points[i]!.tick_at;
        if (t < minX || t > maxX) continue;
        if (raw < rmin) rmin = raw;
        if (raw > rmax) rmax = raw;
      }
      const rawSpan = rmax - rmin;
      // #164: the avg-overpay series can go negative (effective_rate
      // below fillable when the counter is undersettled in the window,
      // or genuinely paying below fillable during fast-moving markets).
      // Other right-axis series (earnings, hashrates, watts) are
      // non-negative by construction and benefit from a y-axis that
      // anchors at 0 for visual stability. Pick the floor per-series.
      const allowNegativeAxis =
        rightAxisSeries === 'avg_overpay_intent' ||
        rightAxisSeries === 'avg_overpay_settled';
      const anchorAtZero =
        rightAxisSeries === 'solo_power_watts' ||
        rightAxisSeries === 'total_balance_sat';
      let yFloor: number;
      let yCeiling: number;
      if (anchorAtZero) {
        yFloor = 0;
        yCeiling = rmax > 0 ? rmax * 1.1 : 1;
      } else if (rawSpan === 0) {
        if (rmax === 0 && !allowNegativeAxis) {
          yFloor = 0;
          yCeiling = 1;
        } else {
          const pad = Math.max(Math.abs(rmax) * 0.1, 1);
          yFloor = allowNegativeAxis ? rmax - pad : Math.max(0, rmax - pad);
          yCeiling = rmax + pad;
        }
      } else {
        yFloor = allowNegativeAxis
          ? rmin - rawSpan * 0.1
          : Math.max(0, rmin - rawSpan * 0.1);
        yCeiling = rmax + rawSpan * 0.1;
      }
      rightYTicks = niceYTicks(yFloor, yCeiling, 5);
      rightYMin = rightYTicks[0] ?? 0;
      rightYMax = rightYTicks[rightYTicks.length - 1] ?? 1;
      // #236 follow-up: when every tick renders identically, re-pad
      // with a value-relative minimum (5%) and anchor the actual
      // value at the top so the operator sees a real scale below
      // it (sister fix in HashrateChart for the same condition).
      if (rightAxis) {
        const span = rightYMax - rightYMin;
        const labels = new Set(rightYTicks.map((v) => rightAxis.formatTick(v, span)));
        if (labels.size === 1 && rightYTicks.length > 1) {
          const center = (rmin + rmax) / 2;
          const pad = Math.max(Math.abs(center) * 0.05, 1);
          const newFloor = allowNegativeAxis ? center - pad : Math.max(0, center - pad);
          const newCeiling = center;
          const niceTicks = niceYTicks(newFloor, newCeiling, 4);
          const tooClose = pad * 0.2;
          const filteredNice = niceTicks.filter((tk) => Math.abs(tk - center) > tooClose);
          rightYTicks = [...filteredNice, center];
          rightYMin = rightYTicks[0] ?? newFloor;
          rightYMax = center;
        }
      }
    }
    const rightYScale = (v: number): number => {
      const usable = chartHeight - PADDING.top - PADDING.bottom;
      const span = rightYMax - rightYMin;
      if (span <= 0) return chartHeight - PADDING.bottom;
      return chartHeight - PADDING.bottom - ((v - rightYMin) / span) * usable;
    };

    const xScale = (x: number): number => {
      const usable = WIDTH - PADDING.left - padRight;
      if (maxX === minX) return PADDING.left + usable / 2;
      return PADDING.left + ((x - minX) / (maxX - minX)) * usable;
    };
    const yScale = (v: number): number => {
      const usable = chartHeight - PADDING.top - PADDING.bottom;
      if (priceMax === priceMin) return chartHeight - PADDING.bottom - usable / 2;
      return chartHeight - PADDING.bottom - ((v - priceMin) / (priceMax - priceMin)) * usable;
    };

    // Right-axis line path. Same null-gap logic as the left-axis
    // series - null values become segment breaks.
    const rightAxisPath = ((): string => {
      if (!hasRightAxis || !rightAxis) return '';
      const segments: string[] = [];
      let current = '';
      for (let i = 0; i < points.length; i += 1) {
        const v = rightAxis.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          if (current) {
            segments.push(current);
            current = '';
          }
          continue;
        }
        const x = xScale(points[i]!.tick_at).toFixed(1);
        const y = rightYScale(v).toFixed(1);
        current += `${current ? 'L' : 'M'}${x},${y} `;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    })();

    // Null-gap path builder. Iterates the full `points` series and
    // emits a separate SVG subpath when the wall-clock distance
    // between two adjacent *valid* samples exceeds MAX_BRIDGE_MS -
    // so a real market outage (fillable IS NULL, hashprice IS NULL
    // for many minutes) renders as a visible break (#44), while a
    // one-tick restart blip or a transient /spot/bid hiccup just
    // bridges the valid samples on either side instead of painting
    // a visible gap for a 60-second noise event (#47).
    //
    // Adaptive bridge: scale to data spacing. Raw 60s ticks → 5-min
    // bridge (5× tick). 30-min buckets at 1w → 90-min bridge (3×
    // bucket). 1-hour buckets at 1m → 3-hour bridge. This keeps a
    // single missing bucket from breaking the line at long ranges
    // (#76) while still surfacing real multi-bucket outages. Median
    // gap is robust to a single anomalous gap dragging the threshold.
    const gaps: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const dt = points[i]!.tick_at - points[i - 1]!.tick_at;
      if (dt > 0) gaps.push(dt);
    }
    let medianGap = 60_000;
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      medianGap = gaps[Math.floor(gaps.length / 2)] ?? 60_000;
    }
    const MAX_BRIDGE_MS = Math.max(5 * 60 * 1000, 3 * medianGap);
    const pathWithNullGaps = (
      getValue: (p: MetricPoint) => number | null | undefined,
    ): string => {
      const segments: string[] = [];
      let current = '';
      let lastValidT: number | null = null;
      for (const p of points) {
        const v = getValue(p);
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const x = xScale(p.tick_at).toFixed(1);
        const y = yScale(v).toFixed(1);
        if (
          current &&
          lastValidT !== null &&
          p.tick_at - lastValidT > MAX_BRIDGE_MS
        ) {
          segments.push(current);
          current = `M${x},${y} `;
        } else {
          current += `${current ? 'L' : 'M'}${x},${y} `;
        }
        lastValidT = p.tick_at;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    };

    // Smoothed "our bid" series via rolling-mean. Fillable / hashprice /
    // max_bid are market-wide and stay raw. effectivePoints is already
    // window-aggregated above - no post-hoc smoothing needed.
    const smoothedPricePoints = rollingMeanPoints(pricePoints, priceSmoothingMinutes);
    const smoothedPriceByTick = new Map<number, number>(
      smoothedPricePoints.map((p) => [p.t, p.v]),
    );

    const pricePath = pathWithNullGaps(
      (p) => smoothedPriceByTick.get(p.tick_at) ?? null,
    );
    const hashpricePath = pathWithNullGaps((p) => p.hashprice_sat_per_ph_day);
    const fillablePath = pathWithNullGaps((p) => p.fillable_ask_sat_per_ph_day);

    // Area-fill variant of the null-gap path. Each non-null run becomes
    // its own closed polygon down to the baseline - `M x0,y0 L…L xN,yN
    // L xN,base L x0,base Z`. A single bulk closure at the end of the
    // stroke path only closes the last subpath; the interior subpaths
    // would close back to their own starting M, painting diagonal
    // wedges across the gap (bug #46, regression from #44). Short-gap
    // bridging mirrors the stroke helper (#47).
    const baselineY = chartHeight - PADDING.bottom;
    const areaPathWithNullGaps = (
      getValue: (p: MetricPoint) => number | null | undefined,
    ): string => {
      const polys: string[] = [];
      let current = '';
      let segStartX: number | null = null;
      let segLastX: number | null = null;
      let lastValidT: number | null = null;
      const closeSegment = () => {
        if (current && segStartX !== null && segLastX !== null) {
          polys.push(
            `${current} L${segLastX.toFixed(1)},${baselineY.toFixed(1)} ` +
              `L${segStartX.toFixed(1)},${baselineY.toFixed(1)} Z`,
          );
        }
        current = '';
        segStartX = null;
        segLastX = null;
      };
      for (const p of points) {
        const v = getValue(p);
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const xNum = xScale(p.tick_at);
        const x = xNum.toFixed(1);
        const y = yScale(v).toFixed(1);
        if (
          current &&
          lastValidT !== null &&
          p.tick_at - lastValidT > MAX_BRIDGE_MS
        ) {
          closeSegment();
        }
        if (!current) {
          current = `M${x},${y}`;
          segStartX = xNum;
        } else {
          current += ` L${x},${y}`;
        }
        segLastX = xNum;
        lastValidT = p.tick_at;
      }
      closeSegment();
      return polys.join(' ');
    };

    const priceAreaPath = areaPathWithNullGaps(
      (p) => smoothedPriceByTick.get(p.tick_at) ?? null,
    );

    // Effective-rate path - pre-computed as its own {t,v} series, not
    // per-MetricPoint, so we can't reuse pathWithNullGaps. Inline a
    // similar wall-clock-gated subpath builder: break across gaps >
    // MAX_BRIDGE_MS for symmetry with the other lines.
    const effectivePathBuilder = (pts: readonly PricePoint[]): string => {
      const segments: string[] = [];
      let current = '';
      let lastT: number | null = null;
      for (const p of pts) {
        const x = xScale(p.t).toFixed(1);
        const y = yScale(p.v).toFixed(1);
        if (current && lastT !== null && p.t - lastT > MAX_BRIDGE_MS) {
          segments.push(current);
          current = `M${x},${y} `;
        } else {
          current += `${current ? 'L' : 'M'}${x},${y} `;
        }
        lastT = p.t;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    };
    const effectivePath = effectivePathBuilder(effectivePoints);

    // Cap is config-derived - `max_bid_sat_per_ph_day` is always
    // present when the daemon is running. The only way it goes
    // "missing" is when the dynamic branch kicks in and hashprice
    // happens to be null for that tick; in that case the fallback
    // is the fixed cap, so cap has a value regardless. Still use
    // the null-gap builder for uniformity - pre-migration rows
    // (max_bid column null) will now break cleanly instead of
    // drawing a long bridge from the first post-migration sample.
    const capByTick = new Map<number, number>(
      capPoints.map((p) => [p.t, p.v]),
    );
    const capPath = pathWithNullGaps((p) => capByTick.get(p.tick_at) ?? null);

    // Polygon tracing the "excluded" region above the cap - the chart
    // top edge along the top, then the cap curve in reverse along the
    // bottom. Filled with a red-to-transparent linear gradient so the
    // operator sees at a glance that anything above the line is off-
    // limits. Only rendered when we actually have cap points; empty
    // when the column was backfilled as null for pre-migration ticks.
    //
    // Closes to y=0 (top of the SVG viewport), not PADDING.top: cap
    // is excluded from Y-axis scaling on purpose (line 433-440), so
    // when cap > priceMax the cap line renders ABOVE PADDING.top in
    // SVG-y space. Closing to PADDING.top in that case puts the
    // polygon's "top" edge BELOW the cap and inverts the fill -
    // gradient ends up below the line instead of above. y=0 is
    // always above any cap-line y, so the polygon always encloses
    // the correct side regardless of where the cap falls.
    const capExclusionPolygon =
      capPoints.length > 0
        ? (() => {
            const top = 0;
            const leftEdgeX = xScale(capPoints[0]!.t).toFixed(1);
            const rightEdgeX = xScale(capPoints[capPoints.length - 1]!.t).toFixed(1);
            const capTrace = capPoints
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
              .join(' ');
            // Start at the first cap point (already M), go up to the
            // viewport top, across to the right edge, and close back down
            // to the last cap point - that seals the polygon above
            // the cap curve.
            const close = ` L${rightEdgeX},${top} L${leftEdgeX},${top} Z`;
            return capTrace + close;
          })()
        : null;

    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    // #287 follow-up: mode-change and pause/resume markers bypass the
    // per-range kind fading ("always visible like pool blocks") - the
    // fading exists to tame EDIT_PRICE noise, and these three are
    // rare, high-signal events that often explain a gap you only
    // notice when zoomed out.
    const allowedKinds = new Set([
      ...showEventKinds,
      'MODE_CHANGE',
      'BID_PAUSED',
      'BID_RESUMED',
    ]);
    // #288: the focused event (History → chart jump) bypasses kind
    // filtering entirely - the whole point of the jump is to see that
    // one marker, so it must render even when its kind is faded at
    // the current range (EDIT_PRICE at 1w+, EDIT_SPEED at 1m+).
    const visibleEvents = events.filter(
      (e) =>
        (allowedKinds.has(e.kind) || e.id === focusEventId) &&
        e.occurred_at >= dataMinX &&
        e.occurred_at <= dataMaxX,
    );

    // #167/#173: contiguous spans where fillable_ask is null. Split into
    // "marketplace empty" (reachable but no supply) vs "Braiins API
    // unreachable". Pre-migration rows (braiins_reachable === null) keep
    // the legacy gray "marketplace empty" treatment.
    const marketplaceEmptyIntervals: Array<{ x0: number; x1: number }> = [];
    const braiinsUnreachableIntervals: Array<{ x0: number; x1: number }> = [];
    {
      let emptyStart: number | null = null;
      let unreachStart: number | null = null;
      for (const p of points) {
        const isUnreachable = p.fillable_ask_sat_per_ph_day === null && p.braiins_reachable === 0;
        const isEmpty = p.fillable_ask_sat_per_ph_day === null && !isUnreachable;
        if (isUnreachable) {
          if (emptyStart !== null) { marketplaceEmptyIntervals.push({ x0: emptyStart, x1: p.tick_at }); emptyStart = null; }
          if (unreachStart === null) unreachStart = p.tick_at;
        } else if (isEmpty) {
          if (unreachStart !== null) { braiinsUnreachableIntervals.push({ x0: unreachStart, x1: p.tick_at }); unreachStart = null; }
          if (emptyStart === null) emptyStart = p.tick_at;
        } else {
          if (emptyStart !== null) { marketplaceEmptyIntervals.push({ x0: emptyStart, x1: p.tick_at }); emptyStart = null; }
          if (unreachStart !== null) { braiinsUnreachableIntervals.push({ x0: unreachStart, x1: p.tick_at }); unreachStart = null; }
        }
      }
      const lastT = points[points.length - 1]?.tick_at;
      if (emptyStart !== null) marketplaceEmptyIntervals.push({ x0: emptyStart, x1: lastT ?? emptyStart });
      if (unreachStart !== null) braiinsUnreachableIntervals.push({ x0: unreachStart, x1: lastT ?? unreachStart });
    }

    const daemonOfflineIntervals: Array<{ x0: number; x1: number }> = [];
    if (points.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < points.length; i++) gaps.push(points[i]!.tick_at - points[i - 1]!.tick_at);
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const threshold = median * 3;
      for (let i = 1; i < points.length; i++) {
        if (points[i]!.tick_at - points[i - 1]!.tick_at > threshold) {
          daemonOfflineIntervals.push({ x0: points[i - 1]!.tick_at, x1: points[i]!.tick_at });
        }
      }
    }

    // xs / smoothedPriceByTick / capByTick exposed for the #257
    // crosshair readout - the bid row mirrors the smoothed line the
    // chart draws, the cap row mirrors the per-tick effective cap.
    return { pricePoints, xs, smoothedPriceByTick, capByTick, minX, maxX, dataMinX, dataMaxX, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, priceAreaPath, hashpricePath, fillablePath, fillableHasData: fillablePoints.length > 0, effectivePath, effectiveHasData: effectivePoints.length > 0, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents, rightAxis, hasRightAxis, rightAxisPath, rightYTicks, rightYScale, padRight, marketplaceEmptyIntervals, braiinsUnreachableIntervals, daemonOfflineIntervals };
  }, [points, events, showEventKinds, focusEventId, priceSmoothingMinutes, historicalPayoutsOffsetSat, maxOverpayVsHashpriceSatPerPhDay, chartHeight, rightAxisSeries, soloSeries, denomination, intlLocale, viewportSince, viewportUntil, hidden]);

  const eventPriceAt = useCallback((e: BidEventView): number | null => {
    const pricePoints = chartData?.pricePoints ?? [];
    if (e.new_price_sat_per_ph_day !== null) return e.new_price_sat_per_ph_day;
    if (e.old_price_sat_per_ph_day !== null) return e.old_price_sat_per_ph_day;
    if (pricePoints.length === 0) return null;
    let before: PricePoint | null = null;
    let after: PricePoint | null = null;
    for (const p of pricePoints) {
      if (p.t <= e.occurred_at) before = p;
      if (p.t >= e.occurred_at && after === null) after = p;
    }
    if (before && after && before.t !== after.t) {
      const ratio = (e.occurred_at - before.t) / (after.t - before.t);
      return before.v + (after.v - before.v) * ratio;
    }
    return before?.v ?? after?.v ?? null;
  }, [chartData?.pricePoints]);

  // Tooltip lives in a portal-style fixed-position node so it's free of
  // the chart container's overflow/clip and can flip near the viewport
  // edges. Coords stored are viewport-absolute (e.clientX/Y).
  //
  // Hover opens a transient tooltip; clicking a marker pins it - pinned
  // tooltips stay until the × is clicked, another marker is clicked, or
  // the user clicks outside. Pinned also exposes a "copy JSON" button.
  const onMarkerEnter = useCallback((event: BidEventView) => (e: React.MouseEvent) => {
    setTooltip((prev) => {
      if (prev?.pinned) return prev;
      return { event, x: e.clientX, y: e.clientY, pinned: false };
    });
  }, []);
  const onMarkerLeave = useCallback(() => {
    setTooltip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onMarkerClick = useCallback((event: BidEventView) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setTooltip({ event, x: e.clientX, y: e.clientY, pinned: true });
  }, []);
  const closeTooltip = useCallback(() => setTooltip(null), []);

  // Pool-block dots (right-axis = ocean_unpaid_sat or lifetime_earnings_sat).
  const onPoolBlockEnter = useCallback(
    (block: OurBlockMarker) => (e: React.MouseEvent) => {
      setPoolBlockTip((prev) => {
        if (prev?.pinned) return prev;
        return { block, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onPoolBlockLeave = useCallback(() => {
    setPoolBlockTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onPoolBlockClick = useCallback(
    (block: OurBlockMarker) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setPoolBlockTip({ block, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closePoolBlockTip = useCallback(() => setPoolBlockTip(null), []);

  const onRetargetEnter = useCallback(
    (event: RetargetEvent) => (e: React.MouseEvent) => {
      setRetargetTip((prev) => {
        if (prev?.pinned) return prev;
        return { event, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onRetargetLeave = useCallback(() => {
    setRetargetTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onRetargetClick = useCallback(
    (event: RetargetEvent) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setRetargetTip({ event, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeRetargetTip = useCallback(() => setRetargetTip(null), []);

  useEffect(() => {
    if (!retargetTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('price-chart-pinned-retarget-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setRetargetTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [retargetTip?.pinned]);

  // Reward-event dots (right-axis = paid_total_sat or lifetime_earnings_sat).
  const onRewardEnter = useCallback(
    (reward: RewardEventView) => (e: React.MouseEvent) => {
      setRewardTip((prev) => {
        if (prev?.pinned) return prev;
        return { reward, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onRewardLeave = useCallback(() => {
    setRewardTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onRewardClick = useCallback(
    (reward: RewardEventView) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setRewardTip({ reward, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeRewardTip = useCallback(() => setRewardTip(null), []);

  const onDepositEnter = useCallback(
    (deposit: DepositView) => (e: React.MouseEvent) => {
      setDepositTip((prev) => {
        if (prev?.pinned) return prev;
        return { deposit, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onDepositLeave = useCallback(() => {
    setDepositTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onDepositClick = useCallback(
    (deposit: DepositView) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setDepositTip({ deposit, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeDepositTip = useCallback(() => setDepositTip(null), []);

  const onUnpaidDropEnter = useCallback(
    (d: { tick_at: number; prev: number; cur: number }) => (e: React.MouseEvent) => {
      setUnpaidDropTip((prev) => {
        if (prev?.pinned) return prev;
        return { ...d, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onUnpaidDropLeave = useCallback(() => {
    setUnpaidDropTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onUnpaidDropClick = useCallback(
    (d: { tick_at: number; prev: number; cur: number }) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setUnpaidDropTip({ ...d, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeUnpaidDropTip = useCallback(() => setUnpaidDropTip(null), []);

  // Outside-click closes the pinned pool-block / reward tooltips.
  // Mirrors the pattern used for the bid-event tooltip below.
  useEffect(() => {
    if (!poolBlockTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('price-chart-pinned-pool-block-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setPoolBlockTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [poolBlockTip?.pinned]);

  useEffect(() => {
    if (!rewardTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('price-chart-pinned-reward-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setRewardTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [rewardTip?.pinned]);

  useEffect(() => {
    if (!depositTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('price-chart-pinned-deposit-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setDepositTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [depositTip?.pinned]);

  useEffect(() => {
    if (!unpaidDropTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('price-chart-pinned-unpaid-drop-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setUnpaidDropTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [unpaidDropTip?.pinned]);

  useEffect(() => {
    if (!tooltip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (target && document.getElementById('price-chart-pinned-tooltip')?.contains(target)) {
        return;
      }
      setTooltip(null);
    };
    // Defer so the click that opened the pin doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onDocClick);
    };
  }, [tooltip?.pinned]);

  // Which extra marker series to render based on right-axis choice.
  const showRewardMarkers =
    rightAxisSeries === 'paid_total_sat' ||
    rightAxisSeries === 'lifetime_earnings_sat' ||
    rightAxisSeries === 'ocean_unpaid_sat';
  const showPoolBlockMarkers =
    rightAxisSeries === 'ocean_unpaid_sat' ||
    rightAxisSeries === 'lifetime_earnings_sat';

  // Pre-computed (x, y) positions for marker dots, memoised so a
  // parent re-render that doesn't change `points` / `rewardEvents` /
  // `ourBlocks` / scales doesn't re-walk the points array per
  // marker. The naive lookup was O(M*N) - one forward scan of the
  // points per marker; this is O(N + M) using a shared cursor walk.
  //
  // These useMemos MUST sit above the `if (!chartData)` early
  // return below: React requires hook-call order to be stable
  // across renders, and on first paint chartData can be null.
  // Each callback handles the null case internally.
  const visibleRewardMarkers = useMemo(() => {
    const empty: Array<{ reward: RewardEventView; cx: number; cy: number }> = [];
    if (!chartData || !showRewardMarkers || !chartData.rightAxis) return empty;
    const { dataMinX, dataMaxX, xScale, rightYScale, rightAxis } = chartData;
    let lastNonNull: number | null = null;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const v = rightAxis.values[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        lastNonNull = v;
        break;
      }
    }
    const out: Array<{ reward: RewardEventView; cx: number; cy: number }> = [];
    let cursor = 0;
    for (const r of rewardEvents) {
      if (r.reorged) continue;
      if (r.detected_at < dataMinX || r.detected_at > dataMaxX) continue;
      while (cursor < points.length && points[cursor]!.tick_at < r.detected_at) {
        cursor += 1;
      }
      let v: number | null = null;
      if (cursor < points.length) {
        const c = rightAxis.values[cursor];
        if (typeof c === 'number' && Number.isFinite(c)) v = c;
      } else {
        v = lastNonNull;
      }
      if (v === null) continue;
      out.push({ reward: r, cx: xScale(r.detected_at), cy: rightYScale(v) });
    }
    return out;
  }, [chartData, showRewardMarkers, rewardEvents, points]);

  const visiblePoolBlockMarkers = useMemo(() => {
    const empty: Array<{ block: OurBlockMarker; cx: number; cy: number; blockCx: number }> = [];
    if (!chartData || !showPoolBlockMarkers || !chartData.rightAxis) return empty;
    const { dataMinX, dataMaxX, xScale, rightYScale, rightAxis } = chartData;
    let lastNonNull: number | null = null;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const v = rightAxis.values[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        lastNonNull = v;
        break;
      }
    }
    // Intermediate per-block projection - same fields as the
    // returned shape plus the steppedIdx used to detect collisions
    // in the stagger pass below.
    const projected: Array<{
      block: OurBlockMarker;
      cx: number;
      cy: number;
      blockCx: number;
      steppedIdx: number;
    }> = [];
    // ourBlocks comes from /api/ocean newest-first, so sort ASC so the
    // two-pointer cursor walk lines up with `points` (also ASC).
    const sortedBlocks = [...ourBlocks].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    // #163: Ocean's unpaid-sat column refreshes on its own ~5 min cadence,
    // not on the on-chain block timestamp. The tick at-or-after the block
    // still carries the pre-block value, so anchoring the marker there
    // sits it on the pre-step segment of the visible step line. Scan
    // forward for the first tick where the right-axis value actually
    // moves off the pre-event baseline (bounded to 15 ticks ≈ 15 min)
    // and place the marker at that post-step value. Same structural fix
    // as #161 in HashrateChart's pool-luck step markers.
    //
    // #221: blocks must each match a *distinct* step when distinct
    // steps exist. The original code restarted its baseline read from
    // `cursor - 1` for every block, so two blocks 4 min apart whose
    // credits surfaced as two separate Ocean refreshes (970k → 1.00M
    // then 1.00M → 1.04M) would both project to the first step at
    // 1.00M because block 2's baseline was still being read from the
    // pre-block tick (still 970k at that moment) and the scan stopped
    // at the first non-baseline value. The fix: track a `scanFromIdx`
    // that advances past the previous block's claimed step, so block 2
    // scans from inside the 1.00M plateau and finds 1.04M as its step.
    // When Ocean genuinely batched both credits into a single observed
    // step (block 2's forward scan finds no further step), block 2
    // inherits block 1's anchor and the stagger pass below visually
    // separates the two dots.
    const MAX_LAG_TICKS = 15;
    // #282: a block may only inherit a *previous* block's unpaid step
    // (the Ocean-batched-credit case) when the two are within this
    // window. Ocean's unpaid column refreshes on a ~5-min cadence, so
    // genuinely-batched blocks land within a refresh or two; 30 min is
    // a generous bound that still rejects the hours-apart false match.
    const BATCH_PROXIMITY_MS = 30 * 60 * 1000;
    let cursor = 0;
    let scanFromIdx = 0;
    let lastClaimedSteppedIdx = -1;
    let lastClaimedValue: number | null = null;
    for (const b of sortedBlocks) {
      if (b.timestamp_ms < dataMinX || b.timestamp_ms > dataMaxX) continue;
      while (cursor < points.length && points[cursor]!.tick_at < b.timestamp_ms) {
        cursor += 1;
      }
      // Scan must not revisit a step already claimed by an earlier
      // block - hence the max(cursor, scanFromIdx).
      const scanFrom = Math.max(cursor, scanFromIdx);
      let v: number | null = null;
      let steppedIdx = -1;
      if (scanFrom < points.length) {
        // Baseline = value at the tick just before scanFrom. For block
        // 1 this is the pre-block tick. For block N+1 this is the
        // post-step value of block N's claimed step (because scanFrom
        // was advanced to lastClaimedSteppedIdx + 1).
        const baseline = scanFrom > 0 ? rightAxis.values[scanFrom - 1] : null;
        const baselineIsNum =
          typeof baseline === 'number' && Number.isFinite(baseline);
        const scanEnd = Math.min(points.length, scanFrom + MAX_LAG_TICKS);
        let stepped: number | null = null;
        if (baselineIsNum) {
          for (let i = scanFrom; i < scanEnd; i += 1) {
            const c = rightAxis.values[i];
            if (typeof c !== 'number' || !Number.isFinite(c)) continue;
            if (c !== baseline) {
              stepped = c;
              steppedIdx = i;
              break;
            }
          }
        }
        if (stepped !== null) {
          v = stepped;
          scanFromIdx = steppedIdx + 1;
          lastClaimedSteppedIdx = steppedIdx;
          lastClaimedValue = stepped;
        } else if (
          lastClaimedSteppedIdx >= 0 &&
          lastClaimedValue !== null &&
          // #282: only inherit the previous block's step when this
          // block is genuinely *near* it in time - the batched-credit
          // case is two blocks minutes apart that Ocean combined into
          // one unpaid refresh. Time-based (not tick-count) so the
          // bound holds at any bucket size. Without it, a block whose
          // own step isn't found within the scan window (e.g. one in
          // the prefetch buffer hours past the viewport, where the
          // unpaid series is flat or null) would inherit a step hours
          // away and paint a phantom second dot staggered next to an
          // unrelated block. Empirical: block 952867 (13:19) attaching
          // to 952842 (08:29) gave two dots for one visible block; the
          // phantom vanished on zoom-in as 952867 left the data
          // extent (#282).
          b.timestamp_ms - points[lastClaimedSteppedIdx]!.tick_at <= BATCH_PROXIMITY_MS
        ) {
          // No further step found - Ocean batched this block's credit
          // into the previous step. Share the previous anchor; stagger
          // pass below pulls the dots apart visually.
          steppedIdx = lastClaimedSteppedIdx;
          v = lastClaimedValue;
        } else {
          const c = rightAxis.values[cursor];
          if (typeof c === 'number' && Number.isFinite(c)) v = c;
        }
      } else {
        v = lastNonNull;
      }
      if (v === null) continue;
      const dotX = steppedIdx >= 0 ? points[steppedIdx]!.tick_at : b.timestamp_ms;
      projected.push({
        block: b,
        cx: xScale(dotX),
        cy: rightYScale(v),
        blockCx: xScale(b.timestamp_ms),
        steppedIdx,
      });
    }
    // #221: shared-step stagger. After the scan-advancing pass above,
    // distinct-step cases naturally produce distinct (cx, cy) per
    // block - no stagger needed. The only remaining collision is the
    // genuine batched case where block N+1 inherited block N's anchor.
    // Group by steppedIdx; for groups of 2+, shift second-and-later
    // entries +STAGGER_PX right per rank along the post-step segment.
    // Each block keeps its own blockCx connector back to its own
    // timestamp.
    const STAGGER_PX = 8;
    const stepCounts = new Map<number, number>();
    const out: typeof empty = [];
    for (const p of projected) {
      if (p.steppedIdx < 0) {
        out.push({ block: p.block, cx: p.cx, cy: p.cy, blockCx: p.blockCx });
        continue;
      }
      const rank = stepCounts.get(p.steppedIdx) ?? 0;
      stepCounts.set(p.steppedIdx, rank + 1);
      out.push({
        block: p.block,
        cx: p.cx + rank * STAGGER_PX,
        cy: p.cy,
        blockCx: p.blockCx,
      });
    }
    return out;
  }, [chartData, showPoolBlockMarkers, ourBlocks, points]);

  const unpaidDropMarkers = useMemo(() => {
    const empty: Array<{ cx: number; cy: number; tick_at: number; prev: number; cur: number }> = [];
    if (!chartData?.rightAxis) return empty;
    if (rightAxisSeries !== 'ocean_unpaid_sat' && rightAxisSeries !== 'lifetime_earnings_sat') return empty;
    const { dataMinX, dataMaxX, xScale, rightYScale, rightAxis } = chartData;
    const vals = rightAxis.values;
    const out: typeof empty = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = vals[i - 1];
      const cur = vals[i];
      if (typeof prev !== 'number' || !Number.isFinite(prev)) continue;
      if (typeof cur !== 'number' || !Number.isFinite(cur)) continue;
      if (prev <= 0) continue;
      const drop = prev - cur;
      if (drop > 0 && drop / prev > 0.3) {
        const t = points[i]!.tick_at;
        if (t >= dataMinX && t <= dataMaxX) {
          out.push({ cx: xScale(t), cy: rightYScale(cur), tick_at: t, prev, cur });
        }
      }
    }
    return out;
  }, [chartData, rightAxisSeries, points]);

  const difficultyRetargets = useMemo<RetargetEvent[]>(() => {
    const n = points.length;
    if (n === 0) return [];
    const nextNonNull: Array<number | null> = new Array(n);
    let trailing: number | null = null;
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = points[i]!.network_difficulty;
      if (typeof d === 'number' && Number.isFinite(d)) trailing = d;
      nextNonNull[i] = trailing;
    }
    const out: RetargetEvent[] = [];
    let prev: number | null = null;
    for (let i = 0; i < n; i += 1) {
      const d = points[i]!.network_difficulty;
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      if (prev !== null && Math.abs(d - prev) / prev > 0.005) {
        const next = i + 1 < n ? nextNonNull[i + 1] ?? null : null;
        if (next === null || Math.abs(next - d) / d <= 0.005) {
          // #229: same enrichment as HashrateChart's mirror builder
          // so the tooltip's block_height / pool_blocks_prior_epoch
          // fields read correctly regardless of which chart the
          // operator hovers on.
          const retargetTickAt = points[i]!.tick_at;
          const blockHeight = inferRetargetBlockHeight(retargetTickAt, ourBlocks);
          const poolBlocksPriorEpoch = blockHeight !== null
            ? countPriorEpochPoolBlocks(blockHeight, ourBlocks)
            : null;
          out.push({
            tick_at: retargetTickAt,
            difficulty: d,
            previous: prev,
            block_height: blockHeight,
            pool_blocks_prior_epoch: poolBlocksPriorEpoch,
          });
        }
      }
      prev = d;
    }
    return out;
  }, [points, ourBlocks]);

  // #257: crosshair wiring - mirror of the HashrateChart block. The
  // svg ref is shared with the wheel-zoom ref callback; pointer
  // handlers compose viewport pan/zoom with crosshair hover /
  // click-to-pin / touch long-press scrub.
  const svgElRef = useRef<SVGSVGElement | null>(null);
  const svgRefCb = useCallback((node: SVGSVGElement | null) => {
    svgElRef.current = node;
    wheelRef?.(node);
  }, [wheelRef]);

  const clientToTick = useCallback((svg: SVGSVGElement, clientX: number): number | null => {
    if (!chartData) return null;
    return clientXToTickAt(svg, clientX, {
      width: WIDTH,
      padLeft: PADDING.left,
      padRight: chartData.padRight,
      minX: chartData.minX,
      maxX: chartData.maxX,
      xs: chartData.xs,
    });
  }, [chartData]);

  const crosshairHandlers = useCrosshairPointer({
    chartId: 'price',
    crosshair,
    viewportHandlers,
    clientToTick,
    isFocused,
  });

  // Marker line position + readout rows at the snapped tick. Bid uses
  // the smoothed series the chart draws; fillable / hashprice come
  // straight off the tick; cap is the per-tick effective cap; the
  // right-axis series formats through its own axis formatter.
  const crosshairView = useMemo(() => {
    const cs = crosshair?.state;
    if (!cs || !chartData || isDragging) return null;
    if (cs.tickAt < chartData.minX || cs.tickAt > chartData.maxX) return null;
    const i = nearestTickIndex(chartData.xs, cs.tickAt);
    if (i < 0) return null;
    const { xScale, yScale, rightYScale, rightYTicks, smoothedPriceByTick, capByTick, hasRightAxis, rightAxis } = chartData;
    const p = points[i]!;
    const rows: CrosshairReadoutRow[] = [];
    const dots: Array<{ cy: number; color: string }> = [];
    const fmtRate = (v: number) => denomination.formatSatPerPhDay(v, intlLocale);
    const bid = smoothedPriceByTick.get(p.tick_at) ?? null;
    if (bid !== null) {
      rows.push({ color: COLOR_PRICE, label: t`our bid`, value: fmtRate(bid) });
      dots.push({ cy: yScale(bid), color: COLOR_PRICE });
    }
    const fillable = p.fillable_ask_sat_per_ph_day;
    if (fillable !== null && Number.isFinite(fillable)) {
      rows.push({ color: COLOR_FILLABLE, label: t`fillable`, value: fmtRate(fillable) });
      dots.push({ cy: yScale(fillable), color: COLOR_FILLABLE });
    }
    const hashprice = p.hashprice_sat_per_ph_day;
    if (hashprice !== null && Number.isFinite(hashprice)) {
      rows.push({ color: COLOR_HASHPRICE, label: t`hashprice`, value: fmtRate(hashprice), dashed: true });
      dots.push({ cy: yScale(hashprice), color: COLOR_HASHPRICE });
    }
    const cap = capByTick.get(p.tick_at) ?? null;
    if (cap !== null) {
      // No dot: the cap usually sits far above the auto-ranged
      // viewport, so a dot would render off-plot most of the time.
      rows.push({ color: COLOR_MAXBID, label: t`max bid`, value: fmtRate(cap) });
    }
    if (hasRightAxis && rightAxis) {
      const v = rightAxis.values[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        const span = (rightYTicks[rightYTicks.length - 1] ?? 1) - (rightYTicks[0] ?? 0);
        rows.push({ color: rightAxis.stroke, label: rightAxis.axisLabel, value: rightAxis.formatTick(v, span) });
        dots.push({ cy: rightYScale(v), color: rightAxis.stroke });
      }
    }
    const x = xScale(cs.tickAt);
    return { state: cs, x, lineXFrac: x / WIDTH, rows, dots };
  }, [crosshair?.state, chartData, isDragging, points, denomination, intlLocale, _colorOverrides]);

  // #288: tell Status the focused marker is actually in the rendered
  // set so the beacon's clear countdown starts at render time, not
  // click time - on a cold navigation from /history the events query
  // can land well after the jump, and a click-anchored timer ate the
  // visible pulse window.
  useEffect(() => {
    if (focusEventId === null || !onFocusEventRendered || !chartData) return;
    if (chartData.visibleEvents.some((e) => e.id === focusEventId)) {
      onFocusEventRendered(focusEventId);
    }
  }, [focusEventId, onFocusEventRendered, chartData]);

  if (!chartData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs uppercase tracking-wider text-slate-100"><Trans>Price</Trans></h3>
        <div className="mt-4 text-sm text-slate-500">
          <Trans>Not enough data in this range yet.</Trans>
        </div>
      </div>
    );
  }

  const { pricePoints, minX, maxX, dataMinX, dataMaxX, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, priceAreaPath, hashpricePath, fillablePath, fillableHasData, effectivePath, effectiveHasData, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents, rightAxis, hasRightAxis, rightAxisPath, rightYTicks, rightYScale, padRight, marketplaceEmptyIntervals, braiinsUnreachableIntervals, daemonOfflineIntervals } = chartData;

  // Format Y-axis tick values via the denomination context so the
  // numbers track the currency + hashrate-unit toggle. The full
  // formatter returns "{value} {unit}"; strip the unit (it's drawn
  // once on the rotated axis label) so each tick is just the number.
  // Compact axis-tick formatter that handles all 9 currency-x-unit
  // combinations (3 currencies x 3 hashrate units). Input is the
  // canonical sat/PH/day. Output is the on-axis-ready short form -
  // unit suffix is shown once on the rotated axis label, not on
  // each tick.
  //
  // - sat: scaled by hashrate-unit factor, then formatCompactNumber
  //   gives k/M/B suffixes when needed (48,400,000 -> "48,4M";
  //   48,400 -> "48,4k"; 48 -> "48,0").
  // - BTC: scaled, divided by 100M, then adaptive decimals so
  //   typical EH magnitudes (0.484 BTC/EH/day) read with 4 sig
  //   figs and PH magnitudes (0.000484) get the precision they need.
  // - USD: scaled, converted via btcPrice, formatCompactNumber for
  //   $-prefixed compact output.
  const priceFmt = (v: number): string => {
    const unit = denomination.hashrateUnit;
    const rateMultiplier =
      unit === 'TH' ? 0.001 : unit === 'EH' ? 1000 : 1;
    const scaled = v * rateMultiplier;
    if (denomination.mode === 'usd' && denomination.btcPrice !== null) {
      const usd = (scaled / 100_000_000) * denomination.btcPrice;
      return `$${formatCompactNumber(usd, intlLocale)}`;
    }
    if (denomination.mode === 'btc') {
      const btc = scaled / 100_000_000;
      const abs = Math.abs(btc);
      // Adaptive decimals - keep tick labels narrow without losing
      // legibility. Drop trailing zeros so "0,4840" reads as "0,484".
      const fmt = (decimals: number): string =>
        new Intl.NumberFormat(intlLocale, {
          minimumFractionDigits: 0,
          maximumFractionDigits: decimals,
        }).format(btc);
      if (abs >= 1) return fmt(2);
      if (abs >= 0.1) return fmt(3);
      if (abs >= 0.001) return fmt(5);
      if (abs === 0) return '0';
      // Sub-millisat: scientific so the chart stays narrow.
      return btc.toExponential(2);
    }
    return formatCompactNumber(scaled, intlLocale);
  };

  return (
    <div ref={containerRef} className="bg-slate-900 border rounded-lg p-4 relative border-slate-800" data-chart-crosshair>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-xs uppercase tracking-wider text-slate-100"><Trans>Price</Trans></h3>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200 border border-slate-700 rounded px-1.5 py-0.5"
            title={expanded ? t`Collapse to default height` : t`Expand to double height`}
          >
            {expanded ? t`collapse` : t`expand`}
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {/* #280: every series chip toggles its own visibility. The
              "effective" chip and the right-axis chip both control the
              right-axis line, so both map to the same 'rightAxis' key. */}
          <Legend color={COLOR_PRICE} label={t`our bid`} hidden={isHidden('bid')} onToggle={() => toggle('bid')} />
          {fillableHasData && <Legend color={COLOR_FILLABLE} label={t`fillable`} hidden={isHidden('fillable')} onToggle={() => toggle('fillable')} />}
          {rightAxisSeries === 'effective_rate' && effectiveHasData && (
            <Legend color={COLOR_EFFECTIVE} label={t`effective`} hidden={isHidden('rightAxis')} onToggle={() => toggle('rightAxis')} />
          )}
          <Legend color={COLOR_HASHPRICE} label={t`hashprice`} dashed hidden={isHidden('hashprice')} onToggle={() => toggle('hashprice')} />
          <Legend color={COLOR_MAXBID} label={t`max bid`} hidden={isHidden('maxBid')} onToggle={() => toggle('maxBid')} />
          {hasRightAxis && rightAxis && (
            <Legend color={rightAxis.stroke} label={rightAxis.axisLabel} hidden={isHidden('rightAxis')} onToggle={() => toggle('rightAxis')} />
          )}
          {rewardEvents.some(
              (r) =>
                !r.reorged &&
                r.detected_at >= chartData.minX &&
                r.detected_at <= chartData.maxX,
            ) && <Legend color={COLOR_PAYOUT} label={t`on-chain payout`} dashed hidden={isHidden('payout')} onToggle={() => toggle('payout')} />}
          {/* #287 follow-up: the three always-visible kinds join the
              legend only when at least one such marker is actually in
              view - they're rare, so the legend stays uncluttered in
              the common case. */}
          {(() => {
            const present = new Set(visibleEvents.map((ev) => ev.kind));
            const extraKinds = (['MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED'] as const).filter(
              (k) => present.has(k),
            );
            const legendKinds = [...showEventKinds, ...extraKinds];
            // Pass the override-resolved colors so a recolored marker
            // matches its legend chip (the legend previously used the
            // hardcoded defaults).
            const legendColors = {
              CREATE_BID: COLOR_CREATE,
              EDIT_PRICE: COLOR_EDIT,
              EDIT_SPEED: COLOR_EDIT_SPEED,
              CANCEL_BID: COLOR_CANCEL,
              MODE_CHANGE: COLOR_MODE_CHANGE,
              BID_PAUSED: COLOR_BID_PAUSED,
              BID_RESUMED: COLOR_BID_RESUMED,
            } as const;
            return legendKinds.length > 0 ? <EventLegend kinds={legendKinds} colors={legendColors} /> : null;
          })()}
          {markersHiddenKind != null && markersHiddenCount > 0 && (
            <span
              className="text-[10px] text-slate-500 italic"
              title={t`Markers were hidden because the combined count (bid events + pool blocks + reward events) exceeded the configured chart-marker cap. Adjust the cap on Config → Display & Logging.`}
            >
              <Trans>{markersHiddenCount} {markersHiddenKind === 'edit_price' ? 'edit-price' : markersHiddenKind === 'pool_block' ? 'pool-block' : markersHiddenKind === 'reward_event' ? 'reward-event' : ''} markers hidden (cap)</Trans>
            </span>
          )}
        </div>
      </div>
      <svg
        ref={svgRefCb}
        viewBox={`0 0 ${WIDTH} ${chartHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
        style={{
          cursor: isDragging ? 'grabbing' : viewportHandlers ? 'grab' : undefined,
          touchAction: 'none',
          outline: isFocused ? '2px solid rgba(56, 189, 248, 0.3)' : 'none',
          outlineOffset: '2px',
          borderRadius: '8px',
        }}
        {...crosshairHandlers}
      >
        <defs>
          <clipPath id="px-data-clip">
            <rect x={PADDING.left} y={0} width={WIDTH - PADDING.left - padRight} height={chartHeight} />
          </clipPath>
        </defs>
        {yTicks.map((v, i) => (
          <g key={`y-${i}`}>
            <line
              x1={PADDING.left}
              x2={WIDTH - padRight}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="#1e293b"
              strokeWidth="1"
            />
            <text
              x={PADDING.left - 6}
              y={yScale(v) + 4}
              textAnchor="end"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {priceFmt(v)}
            </text>
          </g>
        ))}

        {/* #93: right-axis ticks + label + line. Mirrors the
            HashrateChart's right-axis pattern. Rendered before the
            data series so the data overlays the gridline rules. */}
        {hasRightAxis && rightAxis &&
          rightYTicks.map((v, i) => (
            <g key={`y-right-${i}`}>
              <text
                x={WIDTH - padRight + 6}
                y={rightYScale(v) + 4}
                textAnchor="start"
                fontSize="10"
                fill={rightAxis.stroke}
                fontFamily="monospace"
              >
                {rightAxis.formatTick(v, (rightYTicks[rightYTicks.length - 1] ?? 1) - (rightYTicks[0] ?? 0))}
              </text>
            </g>
          ))}

        <g clipPath="url(#px-data-clip)">
        {/* Fillable ask - the tracking anchor for the controller.
            bid = fillable + overpay (clamped to cap). Rendered below
            the amber bid line so the vertical gap between them is the
            overpay cushion at a glance; any edit the controller
            makes is explained by this line moving. */}
        {fillablePath && !isHidden('fillable') && (
          <path
            d={fillablePath}
            stroke={COLOR_FILLABLE}
            strokeWidth="1.2"
            fill="none"
            opacity="0.75"
          />
        )}

        {/* Hashprice break-even line - now a time series, not a static
            horizontal line. Moves with difficulty adjustments + block
            reward fluctuations. Below = profitable, above = unprofitable. */}
        {hashpricePath && !isHidden('hashprice') && (
          // Hashprice is a high-variance per-tick signal, so a sparse
          // long-dash pattern reads as jagged. Use tightly-spaced round
          // dots (0.1 dash + round linecap renders the cap itself as a
          // dot of stroke-width diameter; gap kept small so neighbouring
          // dots stay close enough to follow the curve).
          <path
            d={hashpricePath}
            stroke={COLOR_HASHPRICE}
            strokeWidth="1.6"
            strokeDasharray="0.1 3"
            strokeLinecap="round"
            fill="none"
            opacity="0.75"
          />
        )}
        {/* Effective cap - the tighter of fixed max_bid and the
            dynamic hashprice+max_overpay cap. Anything above this
            line is the "off-limits" region, shaded with a red
            gradient that fades down to transparent at the cap curve
            so the operator reads it as "walled off" without obscuring
            detail near the cap. */}
        {/* #167: marketplace-empty bands. Diagonal-hatch pattern
            (separate <defs> id from HashrateChart so the two SVGs
            don't collide on the page). The gap in `our bid` markers
            during these periods now reads visibly as "marketplace had
            nothing to sell" rather than blending into chart
            background. */}
        {marketplaceEmptyIntervals.length > 0 && (
          <defs>
            <pattern
              id="mktEmptyHatchPx"
              patternUnits="userSpaceOnUse"
              width="8"
              height="8"
              patternTransform="rotate(45)"
            >
              <rect width="8" height="8" fill="#475569" fillOpacity="0.12" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#94a3b8" strokeWidth="1.5" strokeOpacity="0.35" />
            </pattern>
          </defs>
        )}
        {marketplaceEmptyIntervals.map((iv, i) => {
          const x0 = xScale(Math.max(dataMinX, iv.x0));
          const x1 = xScale(Math.min(dataMaxX, iv.x1));
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
          return (
            <rect
              key={`mkt-empty-${i}`}
              x={x0}
              y={PADDING.top}
              width={x1 - x0}
              height={chartHeight - PADDING.top - PADDING.bottom}
              fill="url(#mktEmptyHatchPx)"
            >
              <title>
                {`Marketplace empty (${formatDuration(iv.x1 - iv.x0)})`}
              </title>
            </rect>
          );
        })}
        {braiinsUnreachableIntervals.length > 0 && (
          <defs>
            <pattern
              id="braiinsUnreachHatchPx"
              patternUnits="userSpaceOnUse"
              width="8"
              height="8"
              patternTransform="rotate(45)"
            >
              <rect width="8" height="8" fill="#7f1d1d" fillOpacity="0.15" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#ef4444" strokeWidth="1.5" strokeOpacity="0.4" />
            </pattern>
          </defs>
        )}
        {braiinsUnreachableIntervals.map((iv, i) => {
          const x0 = xScale(Math.max(dataMinX, iv.x0));
          const x1 = xScale(Math.min(dataMaxX, iv.x1));
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
          return (
            <rect
              key={`braiins-unreach-${i}`}
              x={x0}
              y={PADDING.top}
              width={x1 - x0}
              height={chartHeight - PADDING.top - PADDING.bottom}
              fill="url(#braiinsUnreachHatchPx)"
            >
              <title>
                {`Braiins API unreachable (${formatDuration(iv.x1 - iv.x0)})`}
              </title>
            </rect>
          );
        })}
        {daemonOfflineIntervals.length > 0 && (
          <defs>
            <pattern
              id="offlineHatchPx"
              patternUnits="userSpaceOnUse"
              width="10"
              height="10"
              patternTransform="rotate(45)"
            >
              <rect width="10" height="10" fill="#1e293b" fillOpacity="0.35" />
              <line x1="0" y1="0" x2="0" y2="10" stroke="#64748b" strokeWidth="1.5" strokeOpacity="0.4" />
            </pattern>
          </defs>
        )}
        {daemonOfflineIntervals.map((iv, i) => {
          const x0 = xScale(Math.max(dataMinX, iv.x0));
          const x1 = xScale(Math.min(dataMaxX, iv.x1));
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
          return (
            <rect
              key={`offline-${i}`}
              x={x0}
              y={PADDING.top}
              width={x1 - x0}
              height={chartHeight - PADDING.top - PADDING.bottom}
              fill="url(#offlineHatchPx)"
            >
              <title>
                {`Daemon offline (${formatDuration(iv.x1 - iv.x0)})`}
              </title>
            </rect>
          );
        })}
        {/* #287 follow-up: idle-state bands. Run-mode bands (DRY_RUN /
            PAUSED) tint with the mode-change marker color; Braiins
            bid-pause bands tint with the bid-paused marker color. */}
        {idleModeIntervals.length > 0 && (
          <defs>
            <pattern
              id="idleModeHatchPx"
              patternUnits="userSpaceOnUse"
              width="10"
              height="10"
              patternTransform="rotate(45)"
            >
              {/* Dark base + saturated lines, matching the unreachable
                  band's visual language - the slot color itself at low
                  opacity reads as a milky veil on the dark chart. */}
              <rect width="10" height="10" fill={darkenHex(COLOR_MODE_CHANGE, 0.45)} fillOpacity="0.2" />
              <line x1="0" y1="0" x2="0" y2="10" stroke={COLOR_MODE_CHANGE} strokeWidth="1.5" strokeOpacity="0.45" />
            </pattern>
          </defs>
        )}
        {idleModeIntervals.map((iv, i) => {
          const x0 = xScale(Math.max(dataMinX, iv.x0));
          const x1 = xScale(Math.min(dataMaxX, iv.x1));
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
          return (
            <rect
              key={`idle-mode-${i}`}
              x={x0}
              y={PADDING.top}
              width={x1 - x0}
              height={chartHeight - PADDING.top - PADDING.bottom}
              fill="url(#idleModeHatchPx)"
            >
              <title>
                {`Autopilot in ${iv.mode} (${formatDuration(iv.x1 - iv.x0)})`}
              </title>
            </rect>
          );
        })}
        {bidPauseIntervals.length > 0 && (
          <defs>
            <pattern
              id="bidPauseHatchPx"
              patternUnits="userSpaceOnUse"
              width="10"
              height="10"
              patternTransform="rotate(-45)"
            >
              <rect width="10" height="10" fill={darkenHex(COLOR_BID_PAUSED, 0.45)} fillOpacity="0.2" />
              <line x1="0" y1="0" x2="0" y2="10" stroke={COLOR_BID_PAUSED} strokeWidth="1.5" strokeOpacity="0.45" />
            </pattern>
          </defs>
        )}
        {bidPauseIntervals.map((iv, i) => {
          const x0 = xScale(Math.max(dataMinX, iv.x0));
          const x1 = xScale(Math.min(dataMaxX, iv.x1));
          if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
          const clampedSpan = Math.min(dataMaxX, iv.x1) - Math.max(dataMinX, iv.x0);
          return (
            <rect
              key={`bid-pause-${i}`}
              x={x0}
              y={PADDING.top}
              width={x1 - x0}
              height={chartHeight - PADDING.top - PADDING.bottom}
              fill="url(#bidPauseHatchPx)"
            >
              <title>
                {`Bid paused by Braiins (${formatDuration(clampedSpan)})`}
              </title>
            </rect>
          );
        })}
        {capExclusionPolygon && !isHidden('maxBid') && (
          <>
            <defs>
              <linearGradient id="capExclusion" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_MAXBID} stopOpacity="0.28" />
                <stop offset="100%" stopColor={COLOR_MAXBID} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={capExclusionPolygon} fill="url(#capExclusion)" stroke="none" pointerEvents="none" />
          </>
        )}
        {capPath && !isHidden('maxBid') && (
          <path
            d={capPath}
            stroke={COLOR_MAXBID}
            strokeWidth="1.4"
            fill="none"
            opacity="0.85"
          />
        )}
        {priceAreaPath && !isHidden('bid') && (
          /* Soft gradient fill below the price line - mirrors the
             delivered-hashrate fill on the chart above. Each null-gap
             sub-run is its own closed polygon down to the baseline
             (#46 - the earlier single-closure variant painted diagonal
             wedges across gaps after #44 split the line into subpaths). */
          <path d={priceAreaPath} fill="url(#priceFill)" opacity="0.5" pointerEvents="none" />
        )}
        {pricePath && !isHidden('bid') && (
          <path d={pricePath} stroke={COLOR_PRICE} strokeWidth="1.8" fill="none" opacity="0.95" />
        )}
        {/* Effective rate is now plotted via the right-axis machinery
            (rightAxisPath) when the operator picks 'effective_rate'
            from the right-axis dropdown - it gets its own scale so
            the volatile line no longer drags the left-axis range. The
            old left-axis emerald overlay is gone. */}

        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_PRICE} stopOpacity="0.4" />
            <stop offset="100%" stopColor={COLOR_PRICE} stopOpacity="0" />
          </linearGradient>
        </defs>

        {visibleEvents.map((e) => {
          const cx = xScale(e.occurred_at);
          const priceAtEvent = eventPriceAt(e);
          const cy = priceAtEvent !== null ? yScale(priceAtEvent) : PADDING.top - 2;
          const common = {
            onMouseEnter: onMarkerEnter(e),
            onMouseLeave: onMarkerLeave,
            onClick: onMarkerClick(e),
            style: { cursor: 'pointer' },
          };
          // #265 v3: build 608's top-edge glyphs were 8×8 SVG units
          // and positioned at y = PADDING.top - 1, while the pool-block
          // cubes next to them are 14×14 at y = PADDING.top - 11.
          // Result: the bid-event glyphs looked ~75% smaller than the
          // cubes AND sat ~3 px lower, breaking the "scan along the
          // top of the chart" pattern they were supposed to slot into.
          // Re-rendered as inline SVG with viewBox="0 0 24 24", same
          // 14×14 footprint and same y position as the cubes, using
          // Lucide-style paths (plus / x / diamond) for visual parity.
          const GLYPH_W = 14;
          const GLYPH_X = cx - GLYPH_W / 2;
          const GLYPH_Y = PADDING.top - 11;            // matches pool-block cube
          const GLYPH_BOTTOM = GLYPH_Y + GLYPH_W;       // y at which the glyph box ends
          const lineTopY = GLYPH_BOTTOM + 1;
          const bubbleR = 3.5;
          const lineBottomY = cy - bubbleR;
          const hitTopY = GLYPH_Y - 1;
          const hitH = Math.max(GLYPH_W + 2, cy - hitTopY + bubbleR + 2);
          // #287 follow-up: mode-change and pause/resume markers have
          // no price anchor (no bid price on the row), so they render
          // like pool blocks: top-edge glyph + full-height dashed
          // guide line down to the plot baseline. One shared power
          // icon for every mode change regardless of direction
          // (operator: "let's not overdo it"); the tooltip's reason
          // line carries the transition / Braiins pause reason.
          if (e.kind === 'MODE_CHANGE' || e.kind === 'BID_PAUSED' || e.kind === 'BID_RESUMED') {
            const stroke =
              e.kind === 'MODE_CHANGE'
                ? COLOR_MODE_CHANGE
                : e.kind === 'BID_PAUSED'
                  ? COLOR_BID_PAUSED
                  : COLOR_BID_RESUMED;
            const baselineY = chartHeight - PADDING.bottom;
            return (
              <g key={e.id} {...common}>
                <svg
                  x={GLYPH_X} y={GLYPH_Y}
                  width={GLYPH_W} height={GLYPH_W} viewBox="0 0 24 24"
                  fill="none" stroke={stroke} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  {e.kind === 'MODE_CHANGE' ? (
                    <>
                      {/* Lucide `power`. */}
                      <path d="M12 2v10" />
                      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
                    </>
                  ) : e.kind === 'BID_PAUSED' ? (
                    <>
                      {/* Lucide `circle-pause`. */}
                      <circle cx="12" cy="12" r="10" />
                      <line x1="10" x2="10" y1="15" y2="9" />
                      <line x1="14" x2="14" y1="15" y2="9" />
                    </>
                  ) : (
                    <>
                      {/* Lucide `circle-play`. */}
                      <circle cx="12" cy="12" r="10" />
                      <polygon points="10 8 16 12 10 16 10 8" />
                    </>
                  )}
                </svg>
                <line
                  x1={cx} x2={cx} y1={lineTopY} y2={baselineY}
                  stroke={stroke} strokeWidth="1"
                  strokeDasharray="2 4" opacity="0.55" pointerEvents="none"
                />
                <rect x={cx - 8} y={hitTopY} width="16" height={GLYPH_W + 4} fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'CREATE_BID') {
            return (
              <g key={e.id} {...common}>
                {/* Lucide `circle-plus`. */}
                <svg
                  x={GLYPH_X} y={GLYPH_Y}
                  width={GLYPH_W} height={GLYPH_W} viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_CREATE} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 12h8" />
                  <path d="M12 8v8" />
                </svg>
                {lineBottomY > lineTopY + 1 && (
                  <line
                    x1={cx} x2={cx} y1={lineTopY} y2={lineBottomY}
                    stroke={COLOR_CREATE} strokeWidth="1.3"
                    strokeDasharray="3 3" opacity="0.7" pointerEvents="none"
                  />
                )}
                <circle cx={cx} cy={cy} r={bubbleR} fill={COLOR_CREATE} stroke="#0f172a" strokeWidth="1" />
                <rect x={cx - 8} y={hitTopY} width="16" height={hitH} fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'EDIT_PRICE') {
            return (
              <g key={e.id} {...common}>
                <circle cx={cx} cy={cy} r="4.5" fill={COLOR_EDIT} stroke="#0f172a" strokeWidth="1.5" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'EDIT_SPEED') {
            return (
              <g key={e.id} {...common}>
                {/* Lucide `gauge`. */}
                <svg
                  x={GLYPH_X} y={GLYPH_Y}
                  width={GLYPH_W} height={GLYPH_W} viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_EDIT_SPEED} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="m12 14 4-4" />
                  <path d="M3.34 19a10 10 0 1 1 17.32 0" />
                </svg>
                {lineBottomY > lineTopY + 1 && (
                  <line
                    x1={cx} x2={cx} y1={lineTopY} y2={lineBottomY}
                    stroke={COLOR_EDIT_SPEED} strokeWidth="1.3"
                    strokeDasharray="3 3" opacity="0.7" pointerEvents="none"
                  />
                )}
                <circle cx={cx} cy={cy} r={bubbleR} fill={COLOR_EDIT_SPEED} stroke="#0f172a" strokeWidth="1" />
                <rect x={cx - 8} y={hitTopY} width="16" height={hitH} fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'CANCEL_BID') {
            return (
              <g key={e.id} {...common}>
                {/* Lucide `ban`. */}
                <svg
                  x={GLYPH_X} y={GLYPH_Y}
                  width={GLYPH_W} height={GLYPH_W} viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_CANCEL} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m4.9 4.9 14.2 14.2" />
                </svg>
                {lineBottomY > lineTopY + 1 && (
                  <line
                    x1={cx} x2={cx} y1={lineTopY} y2={lineBottomY}
                    stroke={COLOR_CANCEL} strokeWidth="1.3"
                    strokeDasharray="3 3" opacity="0.7" pointerEvents="none"
                  />
                )}
                <circle cx={cx} cy={cy} r={bubbleR} fill={COLOR_CANCEL} stroke="#0f172a" strokeWidth="1" />
                <rect x={cx - 8} y={hitTopY} width="16" height={hitH} fill="transparent" />
              </g>
            );
          }
          return null;
        })}
        {/* #285/#288: sonar beacon for the marker the operator jumped
            to from /history. Three staggered expanding amber rings
            (negative animation delays so the beacon is mid-ping the
            instant it mounts) plus a breathing inner glow, anchored
            on the marker's bubble/glyph. Pure visual cue; no pointer
            events so the underlying marker's hit-rect still receives
            the click. Status clears focusEventId a few seconds after
            the marker actually renders (onFocusEventRendered). */}
        {focusEventId !== null && (() => {
          const focus = visibleEvents.find((e) => e.id === focusEventId);
          if (!focus) return null;
          const cx = xScale(focus.occurred_at);
          const priceAtEvent = eventPriceAt(focus);
          // Mode-change / pause / resume markers have no price-line
          // bubble - they render as top-edge glyphs - so the ring
          // anchors on the glyph (its center sits at PADDING.top - 4)
          // instead of the price line.
          const isTopMarker =
            focus.kind === 'MODE_CHANGE' || focus.kind === 'BID_PAUSED' || focus.kind === 'BID_RESUMED';
          const cy = isTopMarker
            ? PADDING.top - 4
            : priceAtEvent !== null ? yScale(priceAtEvent) : PADDING.top - 2;
          return (
            <g pointerEvents="none">
              {/* #288 follow-up: the sonar rings animate `transform:
                  scale()`, NOT the SVG `r` attribute. Animating SVG
                  geometry attributes (r/cx/cy) via CSS @keyframes only
                  works in Chrome/Blink - Firefox and Safari/WebKit
                  ignore it, leaving the circles at their default r=0
                  (invisible). So every ring carries a static `r` and we
                  scale it instead, which is animatable in all engines.
                  `transform-box: fill-box` + `transform-origin: center`
                  makes the scale pivot on each circle's own centre so
                  the rings stay anchored on the marker; the base r is
                  small (5) and scales up ~6.8x to reach the old ~34px
                  outer radius. `vector-effect: non-scaling-stroke`
                  keeps the ring outline crisp as it expands. */}
              <style>{`
                @keyframes priceChartFocusPing {
                  0%   { transform: scale(1);   opacity: 0.95; }
                  100% { transform: scale(6.8); opacity: 0;    }
                }
                @keyframes priceChartFocusGlow {
                  0%, 100% { transform: scale(0.875); opacity: 0.85; }
                  50%      { transform: scale(1.125); opacity: 1;    }
                }
                .price-chart-focus-ping {
                  animation: priceChartFocusPing 2.4s ease-out infinite;
                  transform-box: fill-box;
                  transform-origin: center;
                  vector-effect: non-scaling-stroke;
                  fill: none;
                  stroke: #fbbf24;
                  stroke-width: 2;
                }
                .price-chart-focus-glow {
                  animation: priceChartFocusGlow 1.2s ease-in-out infinite;
                  transform-box: fill-box;
                  transform-origin: center;
                  vector-effect: non-scaling-stroke;
                  fill: none;
                  stroke: #fde68a;
                  stroke-width: 1.5;
                }
              `}</style>
              <circle cx={cx} cy={cy} r={5} className="price-chart-focus-ping" />
              <circle cx={cx} cy={cy} r={5} className="price-chart-focus-ping" style={{ animationDelay: '-0.8s' }} />
              <circle cx={cx} cy={cy} r={5} className="price-chart-focus-ping" style={{ animationDelay: '-1.6s' }} />
              <circle cx={cx} cy={cy} r={8} className="price-chart-focus-glow" />
            </g>
          );
        })()}
        </g>

        {/* #262: bottom x-axis line stops at the data-area edge
            (WIDTH - padRight) instead of the SVG-padding edge
            (WIDTH - PADDING.right). Without this, when a right axis
            is rendered the line extends past the data area and into
            the right-axis labels. The HashrateChart already does it
            this way; the PriceChart had drifted. */}
        <line
          x1={PADDING.left}
          x2={WIDTH - padRight}
          y1={chartHeight - PADDING.bottom}
          y2={chartHeight - PADDING.bottom}
          stroke="#334155"
          strokeWidth="1"
        />

        {xTicks.map((t) => {
          const x = xScale(t);
          return (
            <g key={`x-${t}`}>
              <line
                x1={x}
                x2={x}
                y1={chartHeight - PADDING.bottom}
                y2={chartHeight - PADDING.bottom + 3}
                stroke="#475569"
                strokeWidth="1"
              />
              <text
                x={x}
                y={chartHeight - 8}
                textAnchor="middle"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {formatTimeTick(t, xTickInterval, dateTimeLocale)}
              </text>
            </g>
          );
        })}

        {hasPrice && (
          <text
            x={14}
            y={PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2}
            textAnchor="middle"
            fontSize="10"
            fill="#64748b"
            fontFamily="monospace"
            transform={`rotate(-90 14 ${PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2})`}
          >
            {denomination.rateSuffix}
          </text>
        )}

        <g clipPath="url(#px-data-clip)">
        {hasRightAxis && rightAxis && !isHidden('rightAxis') && (
          <path
            d={rightAxisPath}
            stroke={rightAxis.stroke}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Reward-event dots on the right-axis line. Operator click
            opens a pinned tooltip with payout date, sat amount, and
            block-explorer link. Only rendered when the right-axis
            series actually plots paid earnings. #280: hidden via the
            "on-chain payout" legend toggle. */}
        {!isHidden('payout') && visibleRewardMarkers.map(({ reward, cx, cy }) => (
          <g
            key={`reward-${reward.id}`}
            onMouseEnter={onRewardEnter(reward)}
            onMouseLeave={onRewardLeave}
            onClick={onRewardClick(reward)}
            style={{ cursor: 'pointer' }}
          >
            <circle
              cx={cx}
              cy={cy}
              r="4.5"
              fill={COLOR_PAYOUT_GEM}
              stroke="#0f172a"
              strokeWidth="1.5"
            />
            <rect x={cx - 9} y={cy - 9} width="18" height="18" fill="transparent" />
          </g>
        ))}

        {unpaidDropMarkers.map((d) => (
          <g
            key={`unpaid-drop-${d.tick_at}`}
            onMouseEnter={onUnpaidDropEnter(d)}
            onMouseLeave={onUnpaidDropLeave}
            onClick={onUnpaidDropClick(d)}
            style={{ cursor: 'pointer' }}
          >
            <circle
              cx={d.cx}
              cy={d.cy}
              r="4.5"
              fill={COLOR_DEPOSIT}
              stroke="#0f172a"
              strokeWidth="1.5"
            />
            <rect x={d.cx - 9} y={d.cy - 9} width="18" height="18" fill="transparent" />
          </g>
        ))}

        {/* Pool-block dots on the right-axis line. Click opens the
            same rich tooltip the Hashrate chart uses (reward, our
            share, BIP-110 signal, explorer link). */}
        {visiblePoolBlockMarkers.map(({ block: b, cx, cy, blockCx }) => {
          const fill = b.found_by_us ? COLOR_OUR_BLOCK : COLOR_POOL_BLOCK;
          return (
            <g
              key={`pool-block-${b.block_hash || b.height}`}
              onMouseEnter={onPoolBlockEnter(b)}
              onMouseLeave={onPoolBlockLeave}
              onClick={onPoolBlockClick(b)}
              style={{ cursor: 'pointer' }}
            >
              {Math.abs(cx - blockCx) > 2 && (
                <line
                  x1={blockCx}
                  y1={cy}
                  x2={cx}
                  y2={cy}
                  stroke={fill}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.5"
                  pointerEvents="none"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r="4.5"
                fill={fill}
                stroke="#0f172a"
                strokeWidth="1.5"
              />
              <rect x={cx - 9} y={cy - 9} width="18" height="18" fill="transparent" />
            </g>
          );
        })}

        {ourBlocks
          .filter((b) => b.timestamp_ms >= dataMinX && b.timestamp_ms <= dataMaxX)
          .map((b) => {
            const x = xScale(b.timestamp_ms);
            const isOurs = b.found_by_us;
            const isBip110 = !isOurs && b.signals_bip110 === true;
            const color = isOurs ? COLOR_OUR_BLOCK : isBip110 ? COLOR_BIP110 : COLOR_POOL_BLOCK;
            return (
              <g
                key={`block-icon-${b.block_hash || b.height}`}
                onMouseEnter={onPoolBlockEnter(b)}
                onMouseLeave={onPoolBlockLeave}
                onClick={onPoolBlockClick(b)}
                style={{ cursor: 'pointer' }}
              >
                <line
                  x1={x} x2={x}
                  y1={PADDING.top + 8} y2={chartHeight - PADDING.bottom}
                  stroke={color}
                  strokeWidth={isOurs ? '1.8' : '1'}
                  strokeDasharray={isOurs ? '4 2' : '2 3'}
                  opacity={isOurs ? '0.95' : '0.55'}
                  pointerEvents="none"
                />
                <rect x={x - 8} y={PADDING.top - 12} width={16} height={16} fill="transparent" />
                {isOurs ? (
                  <g
                    transform={`translate(${x - 5}, ${PADDING.top - 9})`}
                    fill={color} fillOpacity="0.45"
                    stroke={color} strokeWidth="1.1" strokeLinejoin="round"
                  >
                    <path d="M0 8 L1.5 3 L4 5.5 L5 1 L6 5.5 L8.5 3 L10 8 Z" />
                    <line x1="0" y1="9.5" x2="10" y2="9.5" stroke={color} strokeWidth="1.4" />
                  </g>
                ) : (
                  <svg
                    x={x - 7} y={PADDING.top - 11}
                    width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke={color} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    opacity="0.85"
                  >
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" fill={color} fillOpacity="0.25" />
                    <path d="m3.3 7 8.7 5 8.7-5" />
                    <path d="M12 22V12" />
                  </svg>
                )}
              </g>
            );
          })}

        {rewardEvents
          .filter((r) => !r.reorged && r.detected_at >= dataMinX && r.detected_at <= dataMaxX)
          .map((r) => {
            const x = xScale(r.detected_at);
            return (
              <g
                key={`payout-icon-${r.id}`}
                onMouseEnter={onRewardEnter(r)}
                onMouseLeave={onRewardLeave}
                onClick={onRewardClick(r)}
                style={{ cursor: 'pointer' }}
              >
                <line
                  x1={x} x2={x}
                  y1={PADDING.top + 8} y2={chartHeight - PADDING.bottom}
                  stroke={COLOR_PAYOUT_GEM}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.55"
                  pointerEvents="none"
                />
                <rect x={x - 9} y={PADDING.top - 13} width={18} height={18} fill="transparent" />
                <svg
                  x={x - 7} y={PADDING.top - 11}
                  width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_PAYOUT_GEM} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  opacity="0.85"
                >
                  <path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z" fill={COLOR_PAYOUT_GEM} fillOpacity="0.25" />
                  <path d="M2 9h20" />
                  <path d="M10.5 3 8 9l4 13 4-13-2.5-6" />
                </svg>
              </g>
            );
          })}

        {(() => {
          const visible = deposits.filter((d) => {
            const t = d.tx_timestamp_ms ?? d.credited_at_ms ?? d.first_seen_at_ms;
            return t >= dataMinX && t <= dataMaxX;
          });

          const balanceStepUps: { depositTxId: string; stepX: number; stepY: number }[] = [];
          if (rightAxisSeries === 'total_balance_sat' && rightAxis && rightYScale) {
            for (let i = 1; i < points.length; i++) {
              const prev = rightAxis.values[i - 1] ?? null;
              const cur = rightAxis.values[i] ?? null;
              if (prev === null || cur === null || cur <= prev) continue;
              const delta = cur - prev;
              if (delta < 10_000) continue;
              const pt = points[i];
              if (!pt) continue;
              const stepTime = pt.tick_at;
              let bestDeposit: (typeof visible)[number] | null = null;
              let bestDist = Infinity;
              for (const d of visible) {
                const dt = d.tx_timestamp_ms ?? d.credited_at_ms ?? d.first_seen_at_ms;
                if (dt > stepTime) continue;
                const dist = stepTime - dt;
                if (dist < bestDist) { bestDist = dist; bestDeposit = d; }
              }
              if (bestDeposit && bestDist < 24 * 60 * 60 * 1000) {
                balanceStepUps.push({
                  depositTxId: bestDeposit.tx_id,
                  stepX: xScale(stepTime),
                  stepY: rightYScale(cur),
                });
              }
            }
          }
          const stepUpByTxId = new Map(balanceStepUps.map((s) => [s.depositTxId, s]));

          return visible.map((d) => {
            const x = xScale(d.tx_timestamp_ms ?? d.credited_at_ms ?? d.first_seen_at_ms);
            const stepUp = stepUpByTxId.get(d.tx_id);
            return (
              <g
                key={`deposit-icon-${d.tx_id}`}
                onMouseEnter={onDepositEnter(d)}
                onMouseLeave={onDepositLeave}
                onClick={onDepositClick(d)}
                style={{ cursor: 'pointer' }}
              >
                <line
                  x1={x} x2={x}
                  y1={PADDING.top + 8} y2={chartHeight - PADDING.bottom}
                  stroke={COLOR_DEPOSIT}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.55"
                  pointerEvents="none"
                />
                {stepUp && (
                  <>
                    <line
                      x1={x} x2={stepUp.stepX}
                      y1={stepUp.stepY} y2={stepUp.stepY}
                      stroke="transparent"
                      strokeWidth="10"
                    />
                    <line
                      x1={x} x2={stepUp.stepX}
                      y1={stepUp.stepY} y2={stepUp.stepY}
                      stroke={COLOR_DEPOSIT}
                      strokeWidth="1"
                      strokeDasharray="4 3"
                      opacity="0.5"
                      pointerEvents="none"
                    />
                    <circle
                      cx={stepUp.stepX} cy={stepUp.stepY}
                      r={5}
                      fill={COLOR_DEPOSIT} fillOpacity={0.8}
                      stroke="none"
                    />
                  </>
                )}
                <rect x={x - 9} y={PADDING.top - 13} width={18} height={18} fill="transparent" />
                <svg
                  x={x - 7} y={PADDING.top - 11}
                  width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_DEPOSIT} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  opacity="0.85"
                >
                  <path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5" />
                  <path d="M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16" />
                  <path d="M2 21h13" />
                  <path d="M3 9h11" />
                </svg>
              </g>
            );
          });
        })()}

        {difficultyRetargets
          .filter((r) => r.tick_at >= dataMinX && r.tick_at <= dataMaxX)
          .map((r) => {
            const x = xScale(r.tick_at);
            return (
              <g
                key={`retarget-icon-${r.tick_at}`}
                onMouseEnter={onRetargetEnter(r)}
                onMouseLeave={onRetargetLeave}
                onClick={onRetargetClick(r)}
                style={{ cursor: 'pointer' }}
              >
                <line
                  x1={x} x2={x}
                  y1={PADDING.top + 8} y2={chartHeight - PADDING.bottom}
                  stroke={COLOR_RETARGET} strokeWidth="1" strokeDasharray="2 3" opacity="0.4"
                  pointerEvents="none"
                />
                <rect x={x - 9} y={PADDING.top - 13} width={18} height={18} fill="transparent" />
                <svg
                  x={x - 7} y={PADDING.top - 11}
                  width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke={COLOR_RETARGET} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  opacity="0.85"
                >
                  <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999" />
                  <path d="M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024" />
                  <path d="M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069" />
                  <path d="M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z" />
                </svg>
              </g>
            );
          })}

        {/* #250: public-IP change markers live on the hashrate chart
            only - they correlate with delivered-vs-received hashrate
            (Datum/Braiins re-establishing connections after a router
            IP rotation), not with the price-axis content. */}

        {/* #257: crosshair marker line + per-series dots. Pinned
            renders solid; transient hover renders dashed. */}
        {crosshairView && (
          <g pointerEvents="none">
            <line
              x1={crosshairView.x}
              x2={crosshairView.x}
              y1={PADDING.top}
              y2={chartHeight - PADDING.bottom}
              stroke="#94a3b8"
              strokeWidth="1"
              strokeDasharray={crosshairView.state.pinned ? undefined : '3 3'}
              opacity={crosshairView.state.pinned ? 0.9 : 0.6}
            />
            {crosshairView.dots.map((d, di) => (
              <circle
                key={`xh-dot-${di}`}
                cx={crosshairView.x}
                cy={d.cy}
                r="3"
                fill={d.color}
                stroke="#0f172a"
                strokeWidth="1"
              />
            ))}
          </g>
        )}
        </g>

        {hasRightAxis && rightAxis && (
          <text
            x={WIDTH - 14}
            y={PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2}
            textAnchor="middle"
            fontSize="10"
            fill={rightAxis.stroke}
            fontFamily="monospace"
            transform={`rotate(90 ${WIDTH - 14} ${PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2})`}
          >
            {rightAxis.axisLabel}
          </text>
        )}
      </svg>

      {/* #257: per-chart value readout for the crosshair. Suppressed
          while a marker hover-tooltip is open - markers win on direct
          hover (pinned marker tooltips coexist fine). */}
      {crosshairView && !(
        (tooltip !== null && !tooltip.pinned) ||
        (poolBlockTip !== null && !poolBlockTip.pinned) ||
        (rewardTip !== null && !rewardTip.pinned) ||
        (depositTip !== null && !depositTip.pinned) ||
        (retargetTip !== null && !retargetTip.pinned) ||
        (unpaidDropTip !== null && !unpaidDropTip.pinned)
      ) && (
        <CrosshairReadout
          chartId="price"
          state={crosshairView.state}
          svgEl={svgElRef.current}
          lineXFrac={crosshairView.lineXFrac}
          rows={crosshairView.rows}
          onClose={() => crosshair?.clear()}
        />
      )}

      {poolBlockTip && (
        <PoolBlockTooltip
          tip={poolBlockTip}
          explorerTemplate={blockExplorerTemplate ?? ''}
          locale={intlLocale}
          shareLogPct={shareLogPct}
          onClose={closePoolBlockTip}
          pinnedDomId="price-chart-pinned-pool-block-tooltip"
        />
      )}
      {retargetTip && (
        <RetargetTooltip
          tip={retargetTip}
          locale={intlLocale}
          dateTimeLocale={dateTimeLocale}
          onClose={closeRetargetTip}
        />
      )}
      {rewardTip && (
        <RewardEventTooltip
          tip={rewardTip}
          explorerTemplate={txExplorerTemplate ?? ''}
          locale={intlLocale}
          dateTimeLocale={dateTimeLocale}
          denomination={denomination}
          onClose={closeRewardTip}
        />
      )}
      {depositTip && (
        <DepositTooltip
          tip={depositTip}
          explorerTemplate={txExplorerTemplate ?? ''}
          locale={intlLocale}
          denomination={denomination}
          onClose={closeDepositTip}
        />
      )}
      {unpaidDropTip && (
        <UnpaidDropTooltip
          tip={unpaidDropTip}
          locale={intlLocale}
          denomination={denomination}
          onClose={closeUnpaidDropTip}
        />
      )}

      {tooltip && (
        <EventTooltip
          tip={tooltip}
          onClose={closeTooltip}
          points={points}
          maxOverpayVsHashpriceSatPerPhDay={maxOverpayVsHashpriceSatPerPhDay}
          overpaySatPerPhDay={overpaySatPerPhDay}
        />
      )}
    </div>
  );
});

// Walk a plain-data object and, for any numeric field whose name ends
// in `_at`, inject a sibling `<field>_hr` with a locale-aware human
// string including the timezone. Non-destructive - returns a new
// object. Used to enrich the copy-JSON payload so raw unix-ms fields
// are readable without mental math.
function withHumanTimestamps<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => withHumanTimestamps(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = withHumanTimestamps(v);
    if (/_at$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 1_000_000_000_000) {
      out[`${k}_hr`] = formatTimestampHuman(v);
    }
  }
  return out as T;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Rendered when an operator hovers/clicks one of the on-chain
 * payout dots on the right-axis paid-earnings line. Smaller than
 * the pool-block tooltip - just the block height, payout date,
 * sat amount, and a deep-link to the block explorer.
 */
function RewardEventTooltip({
  tip,
  explorerTemplate,
  locale,
  dateTimeLocale,
  denomination,
  onClose,
}: {
  tip: RewardTooltipState;
  explorerTemplate: string;
  locale: string | undefined;
  dateTimeLocale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  void dateTimeLocale;
  const fmt = useFormatters();
  const { reward, pinned } = tip;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // #266 follow-up: side-positioned so the tooltip doesn't
    // reach into the neighbouring (hashrate) chart above.
    const { left, top } = sideTooltipPosition(tip.x, tip.y, rect);
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, reward.id]);

  const url = explorerTemplate
    ? applyExplorerTemplate(explorerTemplate, {
        txid: reward.txid,
        height: reward.block_height,
      })
    : '';
  const btc = reward.value_sat / 1e8;
  const valueText =
    denomination.mode === 'usd' && denomination.btcPrice !== null
      ? `$${new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(btc * denomination.btcPrice)}`
      : denomination.mode === 'btc'
        ? `₿ ${new Intl.NumberFormat(locale, {
            minimumFractionDigits: 8,
            maximumFractionDigits: 8,
          }).format(btc)}`
        : `${new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          }).format(reward.value_sat)} sat`;

  return (
    <div
      ref={ref}
      id={pinned ? 'price-chart-pinned-reward-tooltip' : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-emerald-400">
          <Trans>ON-CHAIN PAYOUT</Trans> · #{reward.block_height.toLocaleString(locale)}
        </span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-300 mt-1">
        {fmt.timestamp(reward.detected_at)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(reward.detected_at)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(reward.detected_at)}</div>

      <div className="mt-2 flex justify-between gap-3 text-slate-300">
        <span className="text-slate-500"><Trans>amount</Trans></span>
        <span className="font-mono tabular-nums">{valueText}</span>
      </div>

      {url && (
        <div className="mt-3 pt-2 border-t border-slate-800">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:text-sky-300 underline text-[11px]"
          >
            <Trans>open in block explorer →</Trans>
          </a>
        </div>
      )}
    </div>
  );
}

function DepositTooltip({
  tip,
  explorerTemplate,
  locale,
  denomination,
  onClose,
}: {
  tip: DepositTooltipState;
  explorerTemplate: string;
  locale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const { deposit, pinned } = tip;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { left, top } = sideTooltipPosition(tip.x, tip.y, rect);
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, deposit.tx_id]);

  const url = explorerTemplate
    ? applyExplorerTemplate(explorerTemplate, { txid: deposit.tx_id })
    : '';
  const btc = deposit.amount_sat / 1e8;
  const valueText =
    denomination.mode === 'usd' && denomination.btcPrice !== null
      ? `$${new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(btc * denomination.btcPrice)}`
      : denomination.mode === 'btc'
        ? `₿ ${new Intl.NumberFormat(locale, {
            minimumFractionDigits: 8,
            maximumFractionDigits: 8,
          }).format(btc)}`
        : `${new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          }).format(deposit.amount_sat)} sat`;

  const txShort = deposit.tx_id.length > 16
    ? `${deposit.tx_id.slice(0, 8)}...${deposit.tx_id.slice(-8)}`
    : deposit.tx_id;

  return (
    <div
      ref={ref}
      id={pinned ? 'price-chart-pinned-deposit-tooltip' : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-purple-400">
          <Trans>DEPOSIT</Trans>
        </span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-300 mt-1">
        {fmt.timestamp(deposit.tx_timestamp_ms ?? deposit.credited_at_ms ?? deposit.first_seen_at_ms)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(deposit.tx_timestamp_ms ?? deposit.credited_at_ms ?? deposit.first_seen_at_ms)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(deposit.tx_timestamp_ms ?? deposit.credited_at_ms ?? deposit.first_seen_at_ms)}</div>
      {deposit.credited_at_ms && deposit.tx_timestamp_ms && deposit.credited_at_ms !== deposit.tx_timestamp_ms && (
        <div className="text-slate-600 text-[10px]">
          <Trans>credited on Braiins</Trans>: {formatTimestampUtc(deposit.credited_at_ms)}
        </div>
      )}
      {deposit.credited_at_ms && deposit.tx_timestamp_ms && deposit.credited_at_ms !== deposit.tx_timestamp_ms && (
        <div className="text-slate-600 text-[10px] mt-0.5 max-w-[220px] whitespace-normal leading-tight">
          <Trans>Marker at tx time. Balance updates after Braiins confirms the deposit.</Trans>
        </div>
      )}

      <div className="mt-2 flex justify-between gap-3 text-slate-300">
        <span className="text-slate-500"><Trans>amount</Trans></span>
        <span className="font-mono tabular-nums">{valueText}</span>
      </div>

      <div className="mt-1 flex justify-between gap-3 text-slate-300">
        <span className="text-slate-500"><Trans>tx</Trans></span>
        <span className="font-mono tabular-nums text-slate-400">{txShort}</span>
      </div>

      {deposit.address && (
        <div className="mt-1 flex justify-between gap-3 text-slate-300">
          <span className="text-slate-500"><Trans>address</Trans></span>
          <span className="font-mono tabular-nums text-slate-400">{deposit.address.slice(0, 12)}...</span>
        </div>
      )}

      {url && (
        <div className="mt-3 pt-2 border-t border-slate-800">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:text-sky-300 underline text-[11px]"
          >
            <Trans>open in block explorer →</Trans>
          </a>
        </div>
      )}
    </div>
  );
}

function EventTooltip({
  tip,
  onClose,
  points = [],
  maxOverpayVsHashpriceSatPerPhDay = null,
  overpaySatPerPhDay = null,
}: {
  tip: TooltipState;
  onClose: () => void;
  points?: readonly MetricPoint[];
  maxOverpayVsHashpriceSatPerPhDay?: number | null;
  overpaySatPerPhDay?: number | null;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Find the tick_metrics row for the event's timestamp so the
  // tooltip can surface fillable / hashprice / max_bid at that
  // moment in sat/PH/day - the numbers the operator needs to
  // sanity-check "did the escalation make sense" without digging
  // into the JSON payload.
  const marketAtEvent = useMemo(() => {
    if (!tip.pinned) return null;
    const target = tip.event.occurred_at;
    let best: MetricPoint | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.tick_at - target);
      // Within ±2 min of the event is close enough - tick_metrics
      // is stored per tick (60s cadence), so the nearest row is
      // always the right one.
      if (diff > 2 * 60_000) continue;
      if (diff < bestDiff) {
        best = p;
        bestDiff = diff;
      }
    }
    return best;
  }, [tip.pinned, tip.event.occurred_at, points]);

  // #120: prefer the snapshot stored on the event row over the live
  // config when computing historical numbers. Live config is only the
  // fallback for legacy rows (snapshot column is null on rows
  // pre-dating migration 0077). Without this, an operator who edited
  // overpay or max_overpay_vs_hashprice between event-time and
  // hover-time saw the *current* values displayed alongside the
  // historical fillable / hashprice from `tick_metrics`, internally
  // contradicting the marker's own reconstruction text ("fillable X +
  // overpay Y").
  const overpayAtEvent =
    tip.event.overpay_sat_per_ph_day ?? overpaySatPerPhDay;
  const maxOverpayAtEvent =
    tip.event.max_overpay_vs_hashprice_sat_per_ph_day ?? maxOverpayVsHashpriceSatPerPhDay;

  const effectiveCapAtEvent = useMemo(() => {
    if (!marketAtEvent || marketAtEvent.max_bid_sat_per_ph_day === null) return null;
    const fixed = marketAtEvent.max_bid_sat_per_ph_day;
    const hashprice = marketAtEvent.hashprice_sat_per_ph_day;
    const dyn =
      maxOverpayAtEvent !== null && hashprice !== null
        ? hashprice + maxOverpayAtEvent
        : null;
    return dyn !== null ? Math.min(fixed, dyn) : fixed;
  }, [marketAtEvent, maxOverpayAtEvent]);

  // Prefetch recent decisions + the specific matched detail so the copy
  // payload reflects the rich context the operator saw in the old
  // Decisions tab. Only runs once pinned - hover-only tooltips don't
  // need the extra round-trips.
  const decisionsList = useQuery({
    queryKey: ['decisions-for-chart'],
    queryFn: () => api.decisions(500),
    enabled: tip.pinned,
    staleTime: 60_000,
  });

  const matchedDecisionId = useMemo<number | null>(() => {
    if (!tip.pinned || !decisionsList.data) return null;
    // Autopilot bid events are emitted from the same tick that produced
    // the decision record, so `tick_at` should be the closest <= event
    // timestamp. Cap the match window so operator bumps don't silently
    // latch onto an unrelated earlier tick.
    const target = tip.event.occurred_at;
    const WINDOW_MS = 5 * 60 * 1000;
    let best: DecisionSummary | null = null;
    let bestDiff = Infinity;
    for (const d of decisionsList.data) {
      const diff = target - d.tick_at;
      if (diff < -30_000 || diff > WINDOW_MS) continue;
      if (Math.abs(diff) < bestDiff) {
        best = d;
        bestDiff = Math.abs(diff);
      }
    }
    return best?.id ?? null;
  }, [tip.pinned, tip.event.occurred_at, decisionsList.data]);

  const decisionDetailQuery = useQuery({
    queryKey: ['decision-detail', matchedDecisionId],
    queryFn: () => api.decision(matchedDecisionId!),
    enabled: matchedDecisionId !== null,
    staleTime: 5 * 60_000,
  });
  // Initial render at the cursor's natural offset (right + below).
  // useLayoutEffect then measures and flips horizontally / vertically
  // if the tooltip would clip the viewport. Hidden until ready so the
  // user never sees the wrong-position frame.
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // #266 follow-up: side-positioned so the bid-event tooltip
    // doesn't reach into the hashrate chart above.
    const { left, top } = sideTooltipPosition(tip.x, tip.y, rect);
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, tip.event.id]);

  const e = tip.event;
  const sourceLabel = e.source === 'OPERATOR' ? t`manual` : t`automatic`;
  const kindLabel =
    e.kind === 'CREATE_BID'
      ? t`CREATE`
      : e.kind === 'EDIT_PRICE'
        ? t`EDIT PRICE`
        : e.kind === 'EDIT_SPEED'
          ? t`EDIT SPEED`
          : e.kind === 'MODE_CHANGE'
            ? t`MODE CHANGE`
            : e.kind === 'BID_PAUSED'
              ? t`BID PAUSED`
              : e.kind === 'BID_RESUMED'
                ? t`BID RESUMED`
                : t`CANCEL`;
  const headerColor =
    e.kind === 'CREATE_BID'
      ? 'text-emerald-300'
      : e.kind === 'EDIT_PRICE'
        ? 'text-amber-300'
        : e.kind === 'EDIT_SPEED'
          ? 'text-sky-300'
          : e.kind === 'MODE_CHANGE'
            ? 'text-violet-300'
            : e.kind === 'BID_PAUSED'
              ? 'text-amber-300'
              : e.kind === 'BID_RESUMED'
                ? 'text-emerald-300'
                : 'text-red-300';

  const copyJson = async () => {
    const detail: DecisionDetail | null = decisionDetailQuery.data ?? null;
    const payload = {
      event: withHumanTimestamps(e),
      market_at_event: marketAtEvent
        ? {
            tick_at: marketAtEvent.tick_at,
            fillable_ask_sat_per_ph_day: marketAtEvent.fillable_ask_sat_per_ph_day,
            hashprice_sat_per_ph_day: marketAtEvent.hashprice_sat_per_ph_day,
            max_bid_sat_per_ph_day: marketAtEvent.max_bid_sat_per_ph_day,
            effective_cap_sat_per_ph_day: effectiveCapAtEvent,
            // #120: snapshot, not live config.
            overpay_sat_per_ph_day: overpayAtEvent,
            max_overpay_vs_hashprice_sat_per_ph_day: maxOverpayAtEvent,
            our_primary_price_sat_per_ph_day: marketAtEvent.our_primary_price_sat_per_ph_day,
          }
        : null,
      // Decision is null for operator-initiated events (bumps) that
      // weren't produced by an autopilot tick, or when the match
      // window missed.
      decision: detail ? withHumanTimestamps(detail) : null,
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await copyToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* copy fell back to execCommand and still failed; no-op */
    }
  };

  const detailLoading =
    tip.pinned && matchedDecisionId !== null && decisionDetailQuery.isLoading;

  return (
    <div
      ref={ref}
      id={tip.pinned ? 'price-chart-pinned-tooltip' : undefined}
      // `fixed` so positioning is purely viewport-relative - no chart
      // container clip / scroll math. `whitespace-nowrap` on the body
      // means data lines (price/delta/budget/id) never wrap; the reason
      // line opts back into wrapping below.
      //
      // When pinned the tooltip is interactive (close/copy buttons), so
      // pointer-events are enabled only then. Hover tooltips stay
      // pointer-events-none to avoid blocking the marker underneath.
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${tip.pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`font-semibold uppercase tracking-wider ${headerColor}`}>
          {kindLabel} · {sourceLabel}
        </span>
        {tip.pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-300 mt-1">
        {fmt.timestamp(e.occurred_at)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(e.occurred_at)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(e.occurred_at)}</div>

      {e.kind === 'CREATE_BID' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row label={t`price`} value={`${formatNumber(Math.round(e.new_price_sat_per_ph_day ?? 0))} sat/PH/day`} />
          <Row label={t`speed`} value={`${e.speed_limit_ph ?? '-'} PH/s`} />
          <Row label={t`budget`} value={`${formatNumber(e.amount_sat ?? 0)} sat`} />
        </div>
      )}

      {e.kind === 'EDIT_PRICE' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row
            label={t`price`}
            value={`${formatNumber(Math.round(e.old_price_sat_per_ph_day ?? 0))} → ${formatNumber(Math.round(e.new_price_sat_per_ph_day ?? 0))} sat/PH/day`}
          />
          {e.old_price_sat_per_ph_day !== null && e.new_price_sat_per_ph_day !== null && (
            <Row
              label={t`delta`}
              value={`${e.new_price_sat_per_ph_day >= e.old_price_sat_per_ph_day ? '+' : ''}${formatNumber(
                Math.round(e.new_price_sat_per_ph_day - e.old_price_sat_per_ph_day),
              )} sat/PH/day`}
            />
          )}
        </div>
      )}

      {e.kind === 'EDIT_SPEED' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row label={t`new speed`} value={`${e.speed_limit_ph ?? '-'} PH/s`} />
        </div>
      )}

      {tip.pinned && marketAtEvent && (
        <div className="mt-2 pt-2 border-t border-slate-800 space-y-0.5 text-slate-300">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
            <Trans>market at this tick</Trans>
          </div>
          {marketAtEvent.fillable_ask_sat_per_ph_day !== null && (
            <Row
              label={t`fillable`}
              value={`${formatNumber(Math.round(marketAtEvent.fillable_ask_sat_per_ph_day))} sat/PH/day`}
            />
          )}
          {overpayAtEvent !== null && (
            <Row
              label={t`overpay`}
              value={`${formatNumber(Math.round(overpayAtEvent))} sat/PH/day`}
            />
          )}
          {marketAtEvent.hashprice_sat_per_ph_day !== null ? (
            <Row
              label={t`hashprice`}
              value={`${formatNumber(Math.round(marketAtEvent.hashprice_sat_per_ph_day))} sat/PH/day`}
            />
          ) : (
            <Row label={t`hashprice`} value={t`- (not recorded this tick)`} />
          )}
          {maxOverpayAtEvent !== null && (
            <Row
              label={t`max overpay vs hashprice`}
              value={`${formatNumber(Math.round(maxOverpayAtEvent))} sat/PH/day`}
            />
          )}
          {maxOverpayAtEvent !== null &&
            marketAtEvent.hashprice_sat_per_ph_day !== null && (
              <Row
                label={t`hashprice + max overpay`}
                value={`${formatNumber(
                  Math.round(
                    marketAtEvent.hashprice_sat_per_ph_day + maxOverpayAtEvent,
                  ),
                )} sat/PH/day`}
              />
            )}
          {marketAtEvent.max_bid_sat_per_ph_day !== null && (
            <Row
              label={t`max bid`}
              value={`${formatNumber(Math.round(marketAtEvent.max_bid_sat_per_ph_day))} sat/PH/day`}
            />
          )}
          {effectiveCapAtEvent !== null && (
            <Row
              label={t`effective cap`}
              value={`${formatNumber(Math.round(effectiveCapAtEvent))} sat/PH/day`}
            />
          )}
          {/* #224 (#222): deadband at the tick. Shown as a percentage
              with the equivalent sat/PH/day floor inline so the
              operator can sanity-check "did this edit clear the
              threshold?" without doing the math in their head.
              Custom JSX (not Row) because the unit suffix mixes a
              percent and a sat-unit; Row's splitUnit regex assumes a
              single trailing unit. Both numeric values rendered in
              normal weight; the `%`, `≈`, and `≡/PH/day` parts pick
              up the muted-unit styling that the SatUnit helper gives
              every other row above. Pre-migration rows render as 20%
              (the backfilled value). */}
          {marketAtEvent.bid_edit_deadband_pct !== null && overpayAtEvent !== null && (
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">
                <Trans>deadband</Trans>
              </span>
              <span className="font-mono tabular-nums">
                {formatNumber(marketAtEvent.bid_edit_deadband_pct)}
                <span className="text-slate-500 text-[11px] ml-1">% ≈</span>{' '}
                {formatNumber(
                  Math.round(
                    (overpayAtEvent * marketAtEvent.bid_edit_deadband_pct) / 100,
                  ),
                )}
                <span className="text-slate-500 text-[11px] ml-1">
                  <SatSymbol className="opacity-70" />
                  {t`/PH/day`}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {e.braiins_order_id && (
        <div className="mt-2 text-[10px] font-mono text-slate-500">
          <Trans>id {e.braiins_order_id}</Trans>
        </div>
      )}
      {e.reason && (
        // Reason is the only freeform string; allow it to wrap so a
        // long sentence doesn't blow the tooltip off-screen, but cap
        // the width so it stays readable.
        <div className="mt-2 text-[11px] text-slate-400 italic whitespace-normal max-w-[20rem]">
          {e.reason}
        </div>
      )}
      {tip.pinned && (
        <div className="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between gap-3">
          {/* #285: jump from chart marker into the History page row.
              Pairs with the drawer's "View on chart" link for
              bidirectional context without embedding a chart on
              /history. */}
          <button
            type="button"
            onClick={() => navigate(`/history?focus_event=${e.id}`)}
            className="text-[10px] text-amber-300 hover:underline"
            title={t`Open the History row for this event`}
          >
            <Trans>Show in history</Trans>{' →'}
          </button>
          <button
            type="button"
            onClick={copyJson}
            aria-label={copied ? t`copied JSON` : t`copy JSON`}
            title={copied ? t`copied JSON` : t`copy JSON`}
            className={`px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 inline-flex items-center gap-1.5 text-[11px] ${copied ? 'text-emerald-300' : 'text-slate-200'}`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span>JSON</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const split = splitUnit(value);
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono tabular-nums">
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1">
              <SatUnit unit={split.unit} />
            </span>
          </>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

/**
 * Mirror of Status.tsx's helpers - split "46,940 sat/PH/day" into
 * `{ num, unit }` so the tooltip's Row can mute the unit and swap
 * "sat" for the ≡ glyph, matching the aesthetic used across the
 * rest of the dashboard. Duplicated here because PriceChart.tsx
 * doesn't import from pages/.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  const m = v.match(/^(.+?)\s+(sat\/PH\/day|PH\/s|PH·h|sat)(\s*(?:\(.*\))?)$/);
  if (m?.[1] && m[2]) return { num: m[1], unit: m[2] + (m[3] ?? '') };
  const usdPhDay = v.match(/^(.+?)(\/PH\/day)$/);
  if (usdPhDay?.[1] && usdPhDay[2]) return { num: usdPhDay[1], unit: usdPhDay[2] };
  return null;
}

function SatUnit({ unit }: { unit: string }) {
  // Localize the `/PH/day` slug before rendering. Mirror of Status.tsx
  // SatUnit so chart tooltips translate in NL/ES alongside the rest.
  const phDayLabel = t`/PH/day`;
  const localized = unit.replace('/PH/day', phDayLabel);
  if (localized.startsWith('sat')) {
    return (
      <>
        <SatSymbol className="opacity-70" />
        {localized.slice(3)}
      </>
    );
  }
  return <>{localized}</>;
}

function Legend({
  color,
  label,
  dashed,
  onToggle,
  hidden,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  /** #280: when provided, the chip toggles the series' visibility. */
  onToggle?: () => void;
  hidden?: boolean;
}) {
  // `dashed` is a misnomer kept for stable callsites; it now renders
  // tightly-spaced round dots to match the hashprice line style on
  // the chart (#hashprice-dots-2026-05-12).
  const swatch = (
    <svg width="14" height="6">
      <line
        x1="0"
        y1="3"
        x2="14"
        y2="3"
        stroke={hidden ? '#475569' : color}
        strokeWidth="2"
        strokeDasharray={dashed ? '0.1 3' : undefined}
        strokeLinecap={dashed ? 'round' : undefined}
      />
    </svg>
  );
  if (!onToggle) {
    return (
      <span className="flex items-center gap-1 text-slate-400 whitespace-nowrap">
        {swatch}
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hidden ? t`Click to show` : t`Click to hide`}
      aria-pressed={!hidden}
      className={`flex items-center gap-1 whitespace-nowrap cursor-pointer hover:text-slate-200 transition-colors ${
        hidden ? 'text-slate-600 line-through' : 'text-slate-400'
      }`}
    >
      {swatch}
      {label}
    </button>
  );
}

function EventLegend({ kinds, colors }: { kinds: readonly BidEventKind[]; colors: Record<BidEventKind, string> }) {
  const has = (k: BidEventKind) => kinds.includes(k);
  // #265 v4: legend icons mirror the chart-top glyphs so the
  // operator's mental "+ create" / "gauge edit speed" / "ban cancel"
  // lookup carries over. Same Lucide paths as the in-chart markers,
  // downscaled to 12x12 viewBox-coords-per-12px so the strokes
  // stay legible inline.
  const iconProps = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <span className="flex items-center gap-2 text-slate-400 pl-2 border-l border-slate-700 flex-wrap">
      {has('CREATE_BID') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.CREATE_BID}>
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12h8" />
            <path d="M12 8v8" />
          </svg>
          <Trans>create</Trans>
        </span>
      )}
      {has('EDIT_PRICE') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="3.5" fill={colors.EDIT_PRICE} />
          </svg>
          <Trans>edit price</Trans>
        </span>
      )}
      {has('EDIT_SPEED') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.EDIT_SPEED}>
            <path d="m12 14 4-4" />
            <path d="M3.34 19a10 10 0 1 1 17.32 0" />
          </svg>
          <Trans>edit speed</Trans>
        </span>
      )}
      {has('CANCEL_BID') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.CANCEL_BID}>
            <circle cx="12" cy="12" r="10" />
            <path d="m4.9 4.9 14.2 14.2" />
          </svg>
          <Trans>cancel</Trans>
        </span>
      )}
      {has('MODE_CHANGE') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.MODE_CHANGE}>
            <path d="M12 2v10" />
            <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
          </svg>
          <Trans>mode change</Trans>
        </span>
      )}
      {has('BID_PAUSED') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.BID_PAUSED}>
            <circle cx="12" cy="12" r="10" />
            <line x1="10" x2="10" y1="15" y2="9" />
            <line x1="14" x2="14" y1="15" y2="9" />
          </svg>
          <Trans>bid paused</Trans>
        </span>
      )}
      {has('BID_RESUMED') && (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <svg {...iconProps} stroke={colors.BID_RESUMED}>
            <circle cx="12" cy="12" r="10" />
            <polygon points="10 8 16 12 10 16 10 8" />
          </svg>
          <Trans>bid resumed</Trans>
        </span>
      )}
    </span>
  );
}

function UnpaidDropTooltip({
  tip,
  locale,
  denomination,
  onClose,
}: {
  tip: { tick_at: number; prev: number; cur: number; x: number; y: number; pinned: boolean };
  locale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const { pinned } = tip;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { left, top } = sideTooltipPosition(tip.x, tip.y, rect);
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, tip.tick_at]);

  const dropSat = tip.prev - tip.cur;
  const formatVal = (sat: number) => {
    const btc = sat / 1e8;
    if (denomination.mode === 'usd' && denomination.btcPrice !== null) {
      return `$${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(btc * denomination.btcPrice)}`;
    }
    if (denomination.mode === 'btc') {
      return `₿ ${new Intl.NumberFormat(locale, { minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(btc)}`;
    }
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(sat)} sat`;
  };

  return (
    <div
      ref={ref}
      id={pinned ? 'price-chart-pinned-unpaid-drop-tooltip' : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-violet-300">
          <Trans>PAYOUT INITIATED</Trans>
        </span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-300 mt-1">
        {fmt.timestamp(tip.tick_at)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(tip.tick_at)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(tip.tick_at)}</div>

      <div className="mt-2 flex justify-between gap-3 text-slate-300">
        <span className="text-slate-500"><Trans>amount</Trans></span>
        <span className="font-mono tabular-nums">{formatVal(dropSat)}</span>
      </div>

      <div className="mt-1 text-[10px] text-slate-500">
        <Trans>Ocean debited the unpaid balance. On-chain transaction follows shortly.</Trans>
      </div>
    </div>
  );
}
