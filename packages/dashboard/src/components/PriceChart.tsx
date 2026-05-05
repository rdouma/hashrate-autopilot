/**
 * Price chart: our primary bid (amber solid) vs the market-wide hashprice
 * (dashed purple), the cheapest fillable ask (cyan), the effective cap, and
 * — opt-in — the effective paid rate (emerald) reconstructed from per-tick
 * primary_bid_consumed_sat deltas. Under pay-your-bid (#53) the bid IS the
 * price paid, so the effective line should track the bid closely modulo
 * settlement smoothing. Bid events render as markers anchored to the
 * primary-price line. Sized and padded to match `HashrateChart` so the
 * X-axis aligns visually when stacked.
 */

import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useQuery } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
  type BidEventKind,
} from '@braiins-hashrate/shared';

import { api, type BidEventView, type DecisionDetail, type DecisionSummary, type MetricPoint } from '../lib/api';
import { copyToClipboard } from '../lib/clipboard';
import { useDenomination } from '../lib/denomination';
import {
  formatAgeMinutes,
  formatCompactNumber,
  formatNumber,
  formatTimestamp,
  formatTimestampHuman,
  formatTimestampUtc,
} from '../lib/format';
import { useLocale } from '../lib/locale';
import { SatSymbol } from './SatSymbol';

const WIDTH = 880;
const HEIGHT = 200;
// Match HashrateChart's padding exactly so the two charts stack with a
// pixel-perfect X-axis alignment. Y labels are on the left; right
// padding only needs to keep the last X-axis timestamp from clipping.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };

// Tailwind amber-500 — shared with the Hashrate chart's delivered
// (Braiins) line so the two charts speak the same visual language
// for "our bid / what we pay Braiins for".
const COLOR_PRICE = '#f59e0b';
const COLOR_CREATE = '#34d399';
const COLOR_EDIT = '#fbbf24';
const COLOR_EDIT_SPEED = '#60a5fa';
const COLOR_CANCEL = '#f87171';

interface TooltipState {
  event: BidEventView;
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
// overpay cushion visually explicit — every bid edit is explained
// by a move in this line.
const COLOR_FILLABLE = '#22d3ee'; // cyan-400
// Effective rate — what Braiins actually charged, per-tick from
// primary_bid_consumed_sat deltas. Emerald so it's clearly a
// "realised" number distinct from the bid (amber) and the market
// (orange/violet).
const COLOR_EFFECTIVE = '#34d399';

/**
 * #93: which series to draw on the Price chart's right Y-axis.
 * - 'none': hide the right axis entirely.
 * - 'estimated_block_reward': sat - follows the currency toggle.
 * - 'btc_usd_price': USD - always rendered as $ regardless of toggle.
 * - 'ocean_unpaid_sat': sat - follows the currency toggle.
 * - 'network_difficulty': raw integer, formatted in trillions.
 */
export type PriceRightAxis =
  | 'none'
  | 'effective_rate'
  | 'estimated_block_reward'
  | 'btc_usd_price'
  | 'ocean_unpaid_sat'
  | 'network_difficulty';

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
): string {
  if (denomination.mode === 'usd' && denomination.btcPrice !== null) {
    return `$${formatCompactNumber((sat / 100_000_000) * denomination.btcPrice, locale)}`;
  }
  if (denomination.mode === 'btc') {
    const btc = sat / 100_000_000;
    const abs = Math.abs(btc);
    const fmt = (decimals: number): string =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      }).format(btc);
    if (abs >= 1) return fmt(2);
    if (abs >= 0.1) return fmt(4);
    if (abs >= 0.001) return fmt(6);
    if (abs === 0) return '0';
    return btc.toExponential(2);
  }
  return formatCompactNumber(sat, locale);
}

export const PriceChart = memo(function PriceChart({
  points,
  events = [],
  showEventKinds,
  maxOverpayVsHashpriceSatPerPhDay = null,
  overpaySatPerPhDay = null,
  priceSmoothingMinutes = 1,
  rightAxisSeries = 'none',
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
   * the flat `max_bid` — matches what decide() actually uses each
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
   * history — past tooltips are approximate if the value was tuned.
   */
  overpaySatPerPhDay?: number | null;
  /**
   * Rolling-mean window (minutes) applied to `our bid` and `effective`
   * only. 1 = raw (no smoothing). Mirrors the smoothing knobs the
   * Hashrate chart already has for the Braiins and Datum series
   * (issue #42). The noisy-per-tick `effective` line in particular
   * benefits — `amount_consumed_sat` updates asynchronously from
   * `avg_speed_ph` at Braiins, so a tick-resolution rate can wiggle
   * around the real trend by ±a few percent.
   */
  priceSmoothingMinutes?: number;
  /**
   * #93: secondary Y-axis series. 'none' hides the right axis.
   * `'effective_rate'` plots the window-aggregated effective rate
   * (Δconsumed ÷ delivered×Δt) on the right axis with its own scale,
   * so the line's per-tick volatility no longer drags the left-axis
   * range — that was the rationale for the legacy `show_effective_rate_on_price_chart`
   * checkbox. The toggle migrated to this dropdown 2026-05-05.
   */
  rightAxisSeries?: PriceRightAxis;
}) {
  const { i18n } = useLingui();
  void i18n;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const chartHeight = expanded ? HEIGHT * 2 : HEIGHT;
  const { intlLocale } = useLocale();
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

    // Effective rate — what Braiins actually charged per PH per day —
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
    // Window = max(3, priceSmoothingMinutes) — 1-minute resolution is
    // smaller than Braiins' own settlement cadence, so a minimum of 3
    // minutes keeps the line legible even with smoothing "off".
    //
    // Per-interval validity filters: skip when either consumed endpoint
    // is null (pre-migration or no primary bid), counter reset
    // (Δ < 0), tick gap > MAX_EFFECTIVE_DT_MS (daemon restart or
    // legitimate bucket boundary on long ranges), near-zero delivery.
    // Final outlier rejection: if aggregated rate exceeds 1.5× bid at
    // the anchor tick, drop — the bid is a hard upper bound by
    // definition, anything above is a computation artifact.
    //
    // Long-range scaling (#81): on 1w / 1m / 1y / all the API
    // pre-aggregates ticks into 30-min / 1-h / 1-day buckets via
    // CHART_RANGE_SPECS. The aggregated rows preserve
    // primary_bid_consumed_sat as MAX over the bucket, so per-bucket
    // deltas are still meaningful — but the previous fixed
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
    // activity than its wall-clock interval suggests — inflating
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
    // Braiins' primary_bid_consumed_sat counter settles in lumps — for
    // minutes at a time the counter stays flat while delivered_ph
    // keeps reporting a lagged nonzero value. Averaging those "stale
    // settlement" pairs into the rate pulls it toward zero, producing
    // visually dramatic dips that imply we got hashrate almost for
    // free — wrong and misleading. Two guards:
    //   1. Skip zero-delta pairs entirely (neither numerator nor
    //      denominator advance). They carry no information — the
    //      counter hasn't reported yet.
    //   2. Require at least MIN_NONZERO_PAIRS real settlements inside
    //      the window before trusting the average. Settlement lulls
    //      become gaps in the line (truthful) rather than dips toward
    //      zero (misleading). On bucketed long ranges one pair already
    //      represents many real settlements (a 1-h bucket aggregates
    //      ~60 individual settlements; a 1-d bucket many more), so
    //      drop the floor to 1 once medianDtMs is large.
    const MIN_NONZERO_PAIRS = medianDtMs > 5 * 60_000 ? 1 : 3;
    for (let i = 1; i < points.length; i += 1) {
      let deltaSum = 0;
      let phDaySum = 0;
      let nonZeroPairs = 0;
      let earliestCoveredT: number | null = null;
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
    }

    // The line the operator actually cares about: the effective cap
    // that decide() uses each tick, which is the tighter of the fixed
    // max_bid and the dynamic hashprice+max_overpay. When the dynamic
    // cap isn't configured, this collapses to max_bid and the line
    // looks exactly like the previous "max bid" line.
    const capPoints: PricePoint[] = points
      .filter((p) => Number.isFinite(p.max_bid_sat_per_ph_day))
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
    const minX = xs[0]!;
    const maxX = xs[xs.length - 1]!;

    const eventPrices = events
      .flatMap((e) => [e.old_price_sat_per_ph_day, e.new_price_sat_per_ph_day])
      .filter((p): p is number => p !== null && Number.isFinite(p));
    // Deliberately exclude capPoints from Y-axis auto-scaling. The cap
    // is usually far above the live data and letting it set the range
    // squashes the interesting lines (bid, fillable, hashprice) into
    // a thin strip at the bottom. If the cap happens to fall inside
    // the auto-ranged window it's drawn; otherwise it sits above the
    // viewport and the excluded-zone shading clips to the top edge —
    // which is exactly the intended "the ceiling is up there somewhere"
    // affordance without hijacking the chart.
    // Include effectivePoints in Y-axis scaling. With window-aggregated
    // rates (not per-tick ratios) the values are well-bounded — the
    // 1.5×-bid last-chance outlier filter prevents any spike from
    // pulling the scale, and legitimate effective values routinely
    // sit below the bid/fillable band (the whole point of charting
    // this line is to see that gap). Earlier we excluded effective
    // to protect against per-tick rate spikes; that threat is gone
    // now that aggregation is numerator-and-denominator-summed.
    // Effective values are included in Y-scale sampling ONLY when the
    // operator has opted-in to seeing the line. Otherwise they're
    // excluded — the whole point of the toggle is that the flatter
    // bid/fillable/hashprice detail is crushed when the volatile
    // effective line drags the Y-axis range down.
    const priceSample = [
      ...pricePoints.map((p) => p.v),
      ...hashpricePoints.map((p) => p.v),
      ...fillablePoints.map((p) => p.v),
      ...eventPrices,
    ];
    const hasPrice = priceSample.length > 0;
    const priceMinRaw = hasPrice ? Math.min(...priceSample) : 0;
    const priceMaxRaw = hasPrice ? Math.max(...priceSample) : 1;
    const priceSpan = Math.max(1, priceMaxRaw - priceMinRaw);

    const yTicks = niceYTicks(
      Math.max(0, priceMinRaw - priceSpan * 0.05),
      priceMaxRaw + priceSpan * 0.05,
      5,
    );
    const priceMin = yTicks[0] ?? 0;
    const priceMax = yTicks[yTicks.length - 1] ?? 1;

    // Per-tick effective rate values (sat/PH/day), aligned with the
    // points array — sparse list lifted into a map keyed on tick_at
    // for O(1) lookup. Used by the effective_rate right-axis case.
    const effectiveByTick = new Map<number, number>(
      effectivePoints.map((p) => [p.t, p.v]),
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
      formatTick: (v: number) => string;
    } | null = (() => {
      switch (rightAxisSeries) {
        case 'none':
          return null;
        case 'effective_rate':
          return {
            values: points.map((p) => effectiveByTick.get(p.tick_at) ?? null),
            stroke: COLOR_EFFECTIVE,
            axisLabel: 'effective (sat/PH/day)',
            formatTick: (v) =>
              new Intl.NumberFormat(intlLocale, {
                maximumFractionDigits: 0,
              }).format(v),
          };
        case 'estimated_block_reward':
          return {
            values: points.map((p) => p.estimated_block_reward_sat),
            stroke: '#cbd5e1',
            axisLabel: `block reward (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v) => formatSatCompact(v, denomination, intlLocale),
          };
        case 'btc_usd_price':
          return {
            values: points.map((p) => p.btc_usd_price),
            stroke: '#cbd5e1',
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
            stroke: '#cbd5e1',
            axisLabel: `unpaid (${denomination.mode === 'usd' ? '$' : denomination.mode === 'btc' ? '₿' : 'sat'})`,
            formatTick: (v) => formatSatCompact(v, denomination, intlLocale),
          };
        case 'network_difficulty':
          return {
            values: points.map((p) => p.network_difficulty),
            stroke: '#cbd5e1',
            axisLabel: 'difficulty',
            // Difficulty in trillions, compact - chain difficulty
            // sits ~1.4e14, so /1e12 lands at ~140. formatCompactNumber
            // then renders as "140".
            formatTick: (v) =>
              `${formatCompactNumber(v / 1e12, intlLocale)} T`,
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
      const valid = rightAxis.values.filter(
        (v): v is number => v !== null && Number.isFinite(v),
      );
      const rmin = Math.min(...valid);
      const rmax = Math.max(...valid);
      const rspan = Math.max(rmax - rmin, Math.abs(rmax) * 0.1, 1e-6);
      rightYTicks = niceYTicks(
        Math.max(0, rmin - rspan * 0.1),
        rmax + rspan * 0.1,
        5,
      );
      rightYMin = rightYTicks[0] ?? 0;
      rightYMax = rightYTicks[rightYTicks.length - 1] ?? 1;
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
    // series — null values become segment breaks.
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
    // between two adjacent *valid* samples exceeds MAX_BRIDGE_MS —
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
    // window-aggregated above — no post-hoc smoothing needed.
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
    // its own closed polygon down to the baseline — `M x0,y0 L…L xN,yN
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

    // Effective-rate path — pre-computed as its own {t,v} series, not
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

    // Cap is config-derived — `max_bid_sat_per_ph_day` is always
    // present when the daemon is running. The only way it goes
    // "missing" is when the dynamic branch kicks in and hashprice
    // happens to be null for that tick; in that case the fallback
    // is the fixed cap, so cap has a value regardless. Still use
    // the null-gap builder for uniformity — pre-migration rows
    // (max_bid column null) will now break cleanly instead of
    // drawing a long bridge from the first post-migration sample.
    const capByTick = new Map<number, number>(
      capPoints.map((p) => [p.t, p.v]),
    );
    const capPath = pathWithNullGaps((p) => capByTick.get(p.tick_at) ?? null);

    // Polygon tracing the "excluded" region above the cap — the chart
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
    // polygon's "top" edge BELOW the cap and inverts the fill —
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
            // to the last cap point — that seals the polygon above
            // the cap curve.
            const close = ` L${rightEdgeX},${top} L${leftEdgeX},${top} Z`;
            return capTrace + close;
          })()
        : null;

    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    const allowedKinds = new Set(showEventKinds);
    const visibleEvents = allowedKinds.size === 0
      ? []
      : events.filter(
          (e) => allowedKinds.has(e.kind) && e.occurred_at >= minX && e.occurred_at <= maxX,
        );

    return { pricePoints, minX, maxX, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, priceAreaPath, hashpricePath, fillablePath, fillableHasData: fillablePoints.length > 0, effectivePath, effectiveHasData: effectivePoints.length > 0, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents, rightAxis, hasRightAxis, rightAxisPath, rightYTicks, rightYScale, padRight };
  }, [points, events, showEventKinds, priceSmoothingMinutes, maxOverpayVsHashpriceSatPerPhDay, chartHeight, rightAxisSeries, denomination, intlLocale]);

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
  // Hover opens a transient tooltip; clicking a marker pins it — pinned
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

  const { pricePoints, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, priceAreaPath, hashpricePath, fillablePath, fillableHasData, effectivePath, effectiveHasData, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents, rightAxis, hasRightAxis, rightAxisPath, rightYTicks, rightYScale, padRight } = chartData;

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
    <div ref={containerRef} className="bg-slate-900 border rounded-lg p-4 relative border-slate-800">
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
          <Legend color={COLOR_PRICE} label={t`our bid`} />
          {fillableHasData && <Legend color={COLOR_FILLABLE} label={t`fillable`} />}
          {rightAxisSeries === 'effective_rate' && effectiveHasData && (
            <Legend color={COLOR_EFFECTIVE} label={t`effective`} />
          )}
          <Legend color={COLOR_HASHPRICE} label={t`hashprice`} dashed />
          <Legend color={COLOR_MAXBID} label={t`max bid`} />
          {hasRightAxis && rightAxis && (
            <Legend color={rightAxis.stroke} label={rightAxis.axisLabel} />
          )}
          {showEventKinds.length > 0 && <EventLegend kinds={showEventKinds} />}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${chartHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
      >
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
                {rightAxis.formatTick(v)}
              </text>
            </g>
          ))}

        {/* Fillable ask — the tracking anchor for the controller.
            bid = fillable + overpay (clamped to cap). Rendered below
            the amber bid line so the vertical gap between them is the
            overpay cushion at a glance; any edit the controller
            makes is explained by this line moving. */}
        {fillablePath && (
          <path
            d={fillablePath}
            stroke={COLOR_FILLABLE}
            strokeWidth="1.2"
            fill="none"
            opacity="0.75"
          />
        )}

        {/* Hashprice break-even line — now a time series, not a static
            horizontal line. Moves with difficulty adjustments + block
            reward fluctuations. Below = profitable, above = unprofitable. */}
        {hashpricePath && (
          <path
            d={hashpricePath}
            stroke={COLOR_HASHPRICE}
            strokeWidth="1.2"
            strokeDasharray="6 4"
            fill="none"
            opacity="0.7"
          />
        )}
        {/* Effective cap — the tighter of fixed max_bid and the
            dynamic hashprice+max_overpay cap. Anything above this
            line is the "off-limits" region, shaded with a red
            gradient that fades down to transparent at the cap curve
            so the operator reads it as "walled off" without obscuring
            detail near the cap. */}
        {capExclusionPolygon && (
          <>
            <defs>
              <linearGradient id="capExclusion" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_MAXBID} stopOpacity="0.28" />
                <stop offset="100%" stopColor={COLOR_MAXBID} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={capExclusionPolygon} fill="url(#capExclusion)" stroke="none" />
          </>
        )}
        {capPath && (
          <path
            d={capPath}
            stroke={COLOR_MAXBID}
            strokeWidth="1.4"
            fill="none"
            opacity="0.85"
          />
        )}
        {priceAreaPath && (
          /* Soft gradient fill below the price line — mirrors the
             delivered-hashrate fill on the chart above. Each null-gap
             sub-run is its own closed polygon down to the baseline
             (#46 — the earlier single-closure variant painted diagonal
             wedges across gaps after #44 split the line into subpaths). */
          <path d={priceAreaPath} fill="url(#priceFill)" opacity="0.5" />
        )}
        {pricePath && (
          <path d={pricePath} stroke={COLOR_PRICE} strokeWidth="1.8" fill="none" opacity="0.95" />
        )}
        {/* Effective rate is now plotted via the right-axis machinery
            (rightAxisPath) when the operator picks 'effective_rate'
            from the right-axis dropdown — it gets its own scale so
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
          if (e.kind === 'CREATE_BID') {
            return (
              <g key={e.id} {...common}>
                <line x1={cx - 5} x2={cx + 5} y1={cy} y2={cy} stroke={COLOR_CREATE} strokeWidth="2.2" />
                <line x1={cx} x2={cx} y1={cy - 5} y2={cy + 5} stroke={COLOR_CREATE} strokeWidth="2.2" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
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
            // Speed-edit marker: hollow blue diamond on the price line at
            // the event time. Earlier I parked it at chart-top reasoning
            // that a speed change has no inherent price coordinate — but
            // operator pointed out (correctly) that anchoring it to the
            // price line is what makes it readable: you see *at what
            // price* the capacity got resized, lined up with the rest of
            // the events.
            const r = 4.5;
            return (
              <g key={e.id} {...common}>
                <polygon
                  points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                  fill="none"
                  stroke={COLOR_EDIT_SPEED}
                  strokeWidth="1.6"
                />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'CANCEL_BID') {
            return (
              <g key={e.id} {...common}>
                <line x1={cx - 5} x2={cx + 5} y1={cy - 5} y2={cy + 5} stroke={COLOR_CANCEL} strokeWidth="2.2" />
                <line x1={cx - 5} x2={cx + 5} y1={cy + 5} y2={cy - 5} stroke={COLOR_CANCEL} strokeWidth="2.2" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          return null;
        })}

        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
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
                {formatTimeTick(t, xTickInterval, intlLocale)}
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

        {/* #93: right-axis line + rotated label. Drawn last so it
            sits on top of the left-axis grid + data series. */}
        {hasRightAxis && rightAxis && (
          <>
            <path
              d={rightAxisPath}
              stroke={rightAxis.stroke}
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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
          </>
        )}
      </svg>

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
// string including the timezone. Non-destructive — returns a new
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
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Find the tick_metrics row for the event's timestamp so the
  // tooltip can surface fillable / hashprice / max_bid at that
  // moment in sat/PH/day — the numbers the operator needs to
  // sanity-check "did the escalation make sense" without digging
  // into the JSON payload.
  const marketAtEvent = useMemo(() => {
    if (!tip.pinned) return null;
    const target = tip.event.occurred_at;
    let best: MetricPoint | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.tick_at - target);
      // Within ±2 min of the event is close enough — tick_metrics
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

  const effectiveCapAtEvent = useMemo(() => {
    if (!marketAtEvent || marketAtEvent.max_bid_sat_per_ph_day === null) return null;
    const fixed = marketAtEvent.max_bid_sat_per_ph_day;
    const hashprice = marketAtEvent.hashprice_sat_per_ph_day;
    const dyn =
      maxOverpayVsHashpriceSatPerPhDay !== null && hashprice !== null
        ? hashprice + maxOverpayVsHashpriceSatPerPhDay
        : null;
    return dyn !== null ? Math.min(fixed, dyn) : fixed;
  }, [marketAtEvent, maxOverpayVsHashpriceSatPerPhDay]);

  // Prefetch recent decisions + the specific matched detail so the copy
  // payload reflects the rich context the operator saw in the old
  // Decisions tab. Only runs once pinned — hover-only tooltips don't
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
    const margin = 12;
    const safeEdge = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = tip.x + margin;
    if (left + rect.width > vw - safeEdge) {
      // Flip to the left side of the cursor.
      left = tip.x - rect.width - margin;
    }
    if (left < safeEdge) left = safeEdge;

    let top = tip.y + margin;
    if (top + rect.height > vh - safeEdge) {
      // Flip above the cursor.
      top = tip.y - rect.height - margin;
    }
    if (top < safeEdge) top = safeEdge;

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
          : t`CANCEL`;
  const headerColor =
    e.kind === 'CREATE_BID'
      ? 'text-emerald-300'
      : e.kind === 'EDIT_PRICE'
        ? 'text-amber-300'
        : e.kind === 'EDIT_SPEED'
          ? 'text-sky-300'
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
            max_overpay_vs_hashprice_sat_per_ph_day: maxOverpayVsHashpriceSatPerPhDay,
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
      // `fixed` so positioning is purely viewport-relative — no chart
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
        {formatTimestamp(e.occurred_at)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(e.occurred_at)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(e.occurred_at)}</div>

      {e.kind === 'CREATE_BID' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row label={t`price`} value={`${formatNumber(Math.round(e.new_price_sat_per_ph_day ?? 0))} sat/PH/day`} />
          <Row label={t`speed`} value={`${e.speed_limit_ph ?? '—'} PH/s`} />
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
          <Row label={t`new speed`} value={`${e.speed_limit_ph ?? '—'} PH/s`} />
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
          {overpaySatPerPhDay !== null && (
            <Row
              label={t`overpay`}
              value={`${formatNumber(Math.round(overpaySatPerPhDay))} sat/PH/day`}
            />
          )}
          {marketAtEvent.hashprice_sat_per_ph_day !== null ? (
            <Row
              label={t`hashprice`}
              value={`${formatNumber(Math.round(marketAtEvent.hashprice_sat_per_ph_day))} sat/PH/day`}
            />
          ) : (
            <Row label={t`hashprice`} value={t`— (not recorded this tick)`} />
          )}
          {maxOverpayVsHashpriceSatPerPhDay !== null && (
            <Row
              label={t`max overpay vs hashprice`}
              value={`${formatNumber(Math.round(maxOverpayVsHashpriceSatPerPhDay))} sat/PH/day`}
            />
          )}
          {maxOverpayVsHashpriceSatPerPhDay !== null &&
            marketAtEvent.hashprice_sat_per_ph_day !== null && (
              <Row
                label={t`hashprice + max overpay`}
                value={`${formatNumber(
                  Math.round(
                    marketAtEvent.hashprice_sat_per_ph_day + maxOverpayVsHashpriceSatPerPhDay,
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
          <span className="text-[10px] text-slate-500">
            {detailLoading ? t`loading decision…` : t`click outside to close`}
          </span>
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
 * Mirror of Status.tsx's helpers — split "46,940 sat/PH/day" into
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

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-slate-400">
      <svg width="14" height="6">
        <line
          x1="0"
          y1="3"
          x2="14"
          y2="3"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '3 2' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function EventLegend({ kinds }: { kinds: readonly BidEventKind[] }) {
  const has = (k: BidEventKind) => kinds.includes(k);
  return (
    <span className="flex items-center gap-2 text-slate-400 pl-2 border-l border-slate-700">
      {has('CREATE_BID') && (
        <span className="flex items-center gap-1">
          <svg width="10" height="10">
            <line x1="1" y1="5" x2="9" y2="5" stroke={COLOR_CREATE} strokeWidth="2" />
            <line x1="5" y1="1" x2="5" y2="9" stroke={COLOR_CREATE} strokeWidth="2" />
          </svg>
          <Trans>create</Trans>
        </span>
      )}
      {has('EDIT_PRICE') && (
        <span className="flex items-center gap-1">
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="3.5" fill={COLOR_EDIT} />
          </svg>
          <Trans>edit price</Trans>
        </span>
      )}
      {has('EDIT_SPEED') && (
        <span className="flex items-center gap-1">
          <svg width="10" height="10">
            <polygon
              points="5,1 9,5 5,9 1,5"
              fill="none"
              stroke={COLOR_EDIT_SPEED}
              strokeWidth="1.4"
            />
          </svg>
          <Trans>edit speed</Trans>
        </span>
      )}
      {has('CANCEL_BID') && (
        <span className="flex items-center gap-1">
          <svg width="10" height="10">
            <line x1="1" y1="1" x2="9" y2="9" stroke={COLOR_CANCEL} strokeWidth="2" />
            <line x1="9" y1="1" x2="1" y2="9" stroke={COLOR_CANCEL} strokeWidth="2" />
          </svg>
          <Trans>cancel</Trans>
        </span>
      )}
    </span>
  );
}
