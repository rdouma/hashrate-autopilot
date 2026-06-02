/**
 * Hashrate-only chart: Braiins-delivered hashrate as a filled area,
 * Datum-measured hashrate as a second line when the Datum integration
 * is active, and target + floor as dashed reference lines. The two
 * series let the operator eyeball the gap between what Braiins bills
 * for and what Datum actually sees arrive at the gateway. Pairs with
 * `PriceChart` rendered immediately below it so price moves can be
 * matched against fill events visually - both charts share the same
 * time-range filter and X-axis layout.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { memo, useCallback, useEffect, useMemo, useState, useRef, useLayoutEffect } from 'react';
import type React from 'react';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
  type ChartRange,
} from '@hashrate-autopilot/shared';

import type { MetricPoint, OurBlockMarker } from '../lib/api';
import { getChartColor, parseOverrides } from '../lib/chartColors';
import {
  formatAgeMinutes,
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatTimestampUtc,
} from '../lib/format';
import { useDenomination } from '../lib/denomination';
import { useDateTimeLocale, useFormatters, useLocale, useTemperatureUnit } from '../lib/locale';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { localizedRangeLabel } from '../lib/range-label';

const WIDTH = 880;
const HEIGHT = 200;
// Padding kept identical to PriceChart so the two charts can be stacked
// and the X-axis lines up tick-for-tick. Right padding is small now that
// the price-side Y-axis moved to the left - just enough to keep the
// rightmost timestamp from clipping the edge.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };
// When the optional share_log overlay is on, the chart grows a second
// (right-hand) Y-axis. Mirror the left-axis padding so the violet axis
// labels have the same breathing room as PH/s on the left.
const PADDING_RIGHT_WITH_SHARE_LOG = 80;

// Tailwind amber-500 - the deeper "our bid" amber on the PriceChart.
// Previously #fbbf24 (amber-400); nudged a shade darker at the
// operator's eyecheck so the Braiins-delivered line reads as a
// saturated amber/orange rather than pale yellow. The PriceChart
// "our bid" line shares this constant.
const COLOR_DELIVERED = '#f59e0b';
// Green - measured locally at the DATUM gateway.
const COLOR_DATUM = '#34d399';
// Same saturated blue as the TIDES-credited block cubes on this
// chart - reinforces the "Ocean → blue" association and contrasts
// harder against the green Datum line than cyan did.
const COLOR_OCEAN = '#3b82f6';
const COLOR_TARGET = '#94a3b8';
const COLOR_FLOOR = '#64748b';
// Gold for the rare "we found this block ourselves" case
// (found_by_us === true). Reads as "jackpot" against the dark
// background. After #115 this colour drives the celebratory
// CROWN marker for own blocks - the most attention-grabbing
// shape on the chart for the highest-value event.
const COLOR_OUR_BLOCK = '#fbbf24';
// Same hue as COLOR_OCEAN by design - TIDES-credited block cubes
// and the Ocean hashrate line share the Ocean-is-blue association.
const COLOR_POOL_BLOCK = '#3b82f6';
// Tailwind yellow-300 - distinct from the amber/gold of own blocks
// and from the saturated Ocean blue of vanilla pool blocks. After
// #115 this colour drives the BIP 110-signalling marker (a compact
// yellow cube). Visually softer than the gold crown so the rare
// own-block stays the loudest thing on the row.
const COLOR_BIP110 = '#fde047';
// Tailwind violet-400 - distinct from amber/green/blue/gray; reads
// well against the slate background. Used for the opt-in `% of Ocean`
// (share_log) overlay on the right Y-axis.
const COLOR_SHARE_LOG = '#a78bfa';

/**
 * Rolling-mean smoother over a time window. For each point at time
 * `xs[i]`, computes the mean of all non-null values whose timestamp
 * falls in `[xs[i] - windowMs, xs[i]]`. Null input values are
 * skipped; a window with no non-null samples yields null (keeps
 * null-gap rendering intact). Window ≤ 0 or 1 minute returns the
 * input unchanged - 1 is the "off" sentinel from the config.
 */
function rollingMean(
  xs: readonly number[],
  values: readonly (number | null | undefined)[],
  windowMinutes: number,
): (number | null)[] {
  if (windowMinutes <= 1 || xs.length === 0) {
    return values.map((v) => (v === undefined ? null : v));
  }
  const windowMs = windowMinutes * 60_000;
  const out: (number | null)[] = new Array(values.length);
  let start = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v !== null && v !== undefined) {
      sum += v;
      count += 1;
    }
    const cutoff = (xs[i] ?? 0) - windowMs;
    while (start <= i && (xs[start] ?? 0) < cutoff) {
      const dropped = values[start];
      if (dropped !== null && dropped !== undefined) {
        sum -= dropped;
        count -= 1;
      }
      start += 1;
    }
    out[i] = count > 0 ? sum / count : null;
  }
  return out;
}

/**
 * #229: derive the retarget block height from an `OurBlockMarker[]`
 * window. Bitcoin's difficulty retargets at every multiple of 2016,
 * so any pool block whose height we know lets us snap to its epoch
 * start. Walks `ourBlocks` for the block whose timestamp is closest
 * to the retarget tick, then:
 *   - If that block is AT or AFTER the retarget, its height lives
 *     in the new epoch -> retarget block = floor(height / 2016) * 2016.
 *   - If BEFORE, it lives in the prior epoch -> retarget block =
 *     the next 2016 boundary above its height.
 * Returns null when `ourBlocks` is empty or carries no height field
 * for the closest match. Exported for PriceChart's mirror builder.
 */
export function inferRetargetBlockHeight(
  retargetTickAt: number,
  ourBlocks: ReadonlyArray<{ timestamp_ms: number; height: number | null | undefined }>,
): number | null {
  let best: { timestamp_ms: number; height: number | null | undefined } | null = null;
  let bestDiff = Infinity;
  for (const b of ourBlocks) {
    if (typeof b.height !== 'number') continue;
    const diff = Math.abs(b.timestamp_ms - retargetTickAt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = b;
    }
  }
  if (!best || typeof best.height !== 'number') return null;
  if (best.timestamp_ms >= retargetTickAt) {
    return Math.floor(best.height / 2016) * 2016;
  }
  return Math.ceil((best.height + 1) / 2016) * 2016;
}

/**
 * #229: count pool blocks whose height falls inside the prior
 * epoch's range `[retargetHeight - 2016, retargetHeight)`. Used by
 * the retarget tooltip to surface "how many blocks did Ocean find
 * last epoch" in operator-relevant terms.
 *
 * #229 follow-up: returns `null` when we can't prove full coverage
 * of the prior epoch. A fresh install (or any adjustment older than
 * our 60-day server-side pool_blocks cutoff) won't have a block at
 * or before `epochStart`, which means the count is artificially
 * low - showing "5 blocks this epoch" right after a fresh install
 * would mislead the operator into thinking Ocean had a horrible
 * run when actually we just don't have the data yet. The coverage
 * check requires at least one block whose height is ≤ `epochStart`;
 * its existence proves we were recording (or backfilled to) before
 * the epoch began. The tooltip hides the row on null.
 */
export function countPriorEpochPoolBlocks(
  retargetHeight: number,
  ourBlocks: ReadonlyArray<{ height: number | null | undefined }>,
): number | null {
  const epochStart = retargetHeight - 2016;
  let haveCoverage = false;
  let count = 0;
  for (const b of ourBlocks) {
    if (typeof b.height !== 'number') continue;
    if (b.height <= epochStart) haveCoverage = true;
    if (b.height >= epochStart && b.height < retargetHeight) count += 1;
  }
  return haveCoverage ? count : null;
}

export interface RetargetEvent {
  /** Tick timestamp of the first sample at the new difficulty. */
  tick_at: number;
  /** New difficulty (raw integer). */
  difficulty: number;
  /** Difficulty during the previous epoch. */
  previous: number;
  /** Pool luck just before the retarget (previous tick). Present only
   *  when the right axis is a pool-luck variant. */
  luckBefore?: number | null;
  /** Pool luck at the retarget tick. */
  luckAfter?: number | null;
  /**
   * #229: retarget block height, derived from `ourBlocks` (the
   * pool_blocks table). Any Ocean block within the prior or new
   * epoch lets us snap to the epoch boundary via
   * `floor(height / 2016) × 2016`. Null when no pool block in the
   * relevant window is available (rare; Ocean finds ~3 blocks/day,
   * so a 14-day epoch will normally have ~40+).
   */
  block_height?: number | null;
  /**
   * #229: count of Ocean pool blocks whose height falls inside the
   * prior epoch's range `[block_height - 2016, block_height)`.
   * Surfaces "how lucky were we last epoch" in operator-relevant
   * terms. Null when `block_height` is null.
   */
  pool_blocks_prior_epoch?: number | null;
}

export interface RetargetTooltipState {
  event: RetargetEvent;
  x: number;
  y: number;
  pinned: boolean;
}

/**
 * #93: which series to draw on the chart's right Y-axis.
 * - 'none': hide the right axis entirely.
 * - 'share_log': legacy violet `% of Ocean` line.
 * - 'network_difficulty' / 'pool_hashrate': new options sourced
 *   from tick_metrics columns added in #89.
 */
export type HashrateRightAxis =
  | 'none'
  | 'share_log'
  | 'network_difficulty'
  | 'pool_hashrate'
  | 'pool_luck_24h'
  | 'pool_luck_7d'
  | 'pool_luck_30d'
  // #149: solo-mining fleet series. Fed from /api/solo-miners/series
  // (separate query, not from MetricPoint). All three render in the
  // shared right-axis purple.
  | 'solo_hashrate'
  | 'solo_device_count'
  | 'solo_max_temp'
  | 'solo_best_diff';

/** Per-tick aggregated fleet series row from /api/solo-miners/series. */
export interface SoloSeriesRow {
  tick_at: number;
  total_hashrate_ghs: number | null;
  total_power_w: number | null;
  max_temp_c: number | null;
  device_count: number;
  max_best_diff: number | null;
}

/**
 * Project the fleet's per-tick series onto the chart's x-axis using
 * nearest-neighbor matching with a 15s tolerance. The series and
 * the chart points come from two different SQLite tables whose
 * tick_at values can be offset by hundreds of ms (each subsystem
 * captures its own Date.now() during the tick), so an exact-match
 * join misses every row. 15s is well within the 60s tick cadence
 * but tight enough to never bridge a missing tick.
 *
 * Both inputs are assumed sorted ascending by tick_at - the
 * daemon side does ORDER BY tick_at ASC and points[] is built from
 * a similarly-ordered query. Linear two-pointer walk: O(n + m).
 */
export const SOLO_SERIES_TOLERANCE_MS = 15_000;

export function projectSoloSeries(
  pointTickAts: ReadonlyArray<number>,
  series: ReadonlyArray<SoloSeriesRow>,
  pick: (r: SoloSeriesRow) => number | null,
): (number | null)[] {
  if (series.length === 0) return pointTickAts.map(() => null);
  const out = new Array<number | null>(pointTickAts.length);
  let j = 0;
  for (let i = 0; i < pointTickAts.length; i++) {
    const t = pointTickAts[i]!;
    // Advance j while the next series row would be a closer match.
    while (
      j + 1 < series.length &&
      Math.abs(series[j + 1]!.tick_at - t) <= Math.abs(series[j]!.tick_at - t)
    ) {
      j++;
    }
    const closest = series[j]!;
    if (Math.abs(closest.tick_at - t) <= SOLO_SERIES_TOLERANCE_MS) {
      out[i] = pick(closest);
    } else {
      out[i] = null;
    }
  }
  return out;
}

interface RightAxisSpec {
  /** Per-point values pulled off MetricPoint. */
  values: (number | null)[];
  /** Y-tick label formatter. Receives the raw value. */
  formatTick: (v: number) => string;
  /** Axis label drawn vertically on the right edge. */
  axisLabel: string;
  /** Stroke colour for the line. */
  stroke: string;
  /**
   * Optional tick-generation hint. `'integer'` forces step ≥ 1 and
   * pins the band to whole numbers so a constant integer series
   * (e.g. device count = 3 every tick on a short range) doesn't
   * produce seven fractional ticks that all toFixed-format to the
   * same label. Use for any series whose `formatTick` rounds to an
   * integer.
   */
  tickHint?: 'integer';
}

export const HashrateChart = memo(function HashrateChart({
  points,
  range,
  onRangeChange,
  ourBlocks = [],
  blockExplorerTemplate = 'https://mempool.space/block/{hash}',
  shareLogPct = null,
  braiinsSmoothingMinutes = 1,
  datumSmoothingMinutes = 1,
  rightAxisSeries = 'none',
  soloSeries = [],
  bestDiffEvents = [],
  markersHiddenCount = 0,
  viewportHandlers,
  wheelRef,
  isDragging = false,
  isFocused = false,
  viewportSince,
  viewportUntil,
  chartColorOverrides,
}: {
  points: readonly MetricPoint[];
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
  /** Pool blocks credited to our wallet (every recent pool block
   *  under TIDES while mining, plus a gold-flagged subset for the
   *  rare solo-finder case). */
  ourBlocks?: readonly OurBlockMarker[];
  /** Template applied at click time to turn a block hash/height into
   *  an explorer URL. `{hash}` and `{height}` placeholders are
   *  substituted; at least one must be present. */
  blockExplorerTemplate?: string;
  /** Current Ocean share-log percentage (e.g. 0.0182). Used in the
   *  block-marker tooltip to estimate our share of each block's
   *  reward. Approximation: share_log shifts as pool/user hashrate
   *  changes, so applying current share_log to older blocks is an
   *  estimate of what Ocean would have credited at the time. */
  shareLogPct?: number | null;
  /** Rolling-mean window (minutes) applied to the Braiins-delivered
   *  series; 1 = raw. Ocean is not smoothed here - /user_hashrate
   *  already returns a server-side 5-min average. */
  braiinsSmoothingMinutes?: number;
  datumSmoothingMinutes?: number;
  /** #93: which series to render on the right Y-axis. 'none' hides
   *  the axis entirely. 'share_log' is the legacy violet line. The
   *  other options pull from new tick_metrics columns added in #89.
   *  When the chosen series has no non-null values in the visible
   *  range the axis silently hides itself. */
  rightAxisSeries?: HashrateRightAxis;
  /** #149: per-tick aggregated solo-mining fleet series; only used when rightAxisSeries is one of the `solo_*` variants. */
  soloSeries?: ReadonlyArray<SoloSeriesRow>;
  /** #204: record-breaking best difficulty events for trophy markers on the chart. */
  bestDiffEvents?: ReadonlyArray<{ recorded_at: number; difficulty: number }>;
  /** #172: number of markers hidden by the global marker cap. */
  markersHiddenCount?: number;
  viewportHandlers?: {
    onPointerDown: React.PointerEventHandler<SVGSVGElement>;
    onPointerMove: React.PointerEventHandler<SVGSVGElement>;
    onPointerUp: React.PointerEventHandler<SVGSVGElement>;
    onDoubleClick: () => void;
  };
  /** Ref callback that registers a non-passive wheel listener for scroll-to-zoom. */
  wheelRef?: (node: SVGSVGElement | null) => void;
  isDragging?: boolean;
  isFocused?: boolean;
  viewportSince?: number;
  viewportUntil?: number;
  /** #238: per-series chart color overrides as a JSON string from
   *  `config.chart_color_overrides`. Empty `'{}'` (or undefined)
   *  resolves every series to its built-in default. */
  chartColorOverrides?: string;
}) {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  // #238: resolve per-series colors from the operator's config.
  // These shadow the module-scope `COLOR_*` defaults so the rest of
  // the component body keeps using the same names without changes.
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const _colorOverrides = useMemo(
    () => parseOverrides(chartColorOverrides),
    [chartColorOverrides],
  );
  /* eslint-disable @typescript-eslint/no-shadow */
  const COLOR_DELIVERED = getChartColor('hashrate.delivered', _colorOverrides);
  const COLOR_DATUM = getChartColor('hashrate.received_datum', _colorOverrides);
  const COLOR_OCEAN = getChartColor('hashrate.received_ocean', _colorOverrides);
  const COLOR_TARGET = getChartColor('hashrate.target', _colorOverrides);
  const COLOR_FLOOR = getChartColor('hashrate.floor', _colorOverrides);
  const COLOR_OUR_BLOCK = getChartColor('hashrate.pool_block_ours', _colorOverrides);
  const COLOR_POOL_BLOCK = getChartColor('hashrate.pool_block_others', _colorOverrides);
  const COLOR_RIGHT_AXIS = getChartColor('hashrate.right_axis', _colorOverrides);
  /* eslint-enable @typescript-eslint/no-shadow */
  const dateTimeLocale = useDateTimeLocale();
  const denomination = useDenomination();
  const tempUnit = useTemperatureUnit();
  const [blockTip, setBlockTip] = useState<PoolBlockTooltipState | null>(null);
  // Difficulty-retarget markers (#22 follow-up): when the right-axis
  // series is `network_difficulty`, place a dot on the line at every
  // detected retarget tick with a tooltip showing the new difficulty
  // and the % change vs the previous epoch.
  const [retargetTip, setRetargetTip] = useState<RetargetTooltipState | null>(null);
  // #128: pool-luck step markers + tooltips. State is local to this
  // chart; the marker only renders when the right axis is one of the
  // pool-luck variants (otherwise the line itself isn't drawn).
  const [stepTip, setStepTip] = useState<PoolLuckStepTooltipState | null>(null);
  // #105: parity with PriceChart - operator can double chart height
  // for closer inspection of floor breaches / BIP 110 marker positions.
  // State is local; PriceChart's expand toggle is independent.
  const [expanded, setExpanded] = useState(false);
  const chartHeight = expanded ? HEIGHT * 2 : HEIGHT;

  const onBlockEnter = useCallback(
    (block: OurBlockMarker) => (e: React.MouseEvent) => {
      setBlockTip((prev) => {
        if (prev?.pinned) return prev;
        return { block, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onBlockLeave = useCallback(() => {
    setBlockTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onBlockClick = useCallback(
    (block: OurBlockMarker) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setBlockTip({ block, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeBlockTip = useCallback(() => setBlockTip(null), []);

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

  const onStepEnter = useCallback(
    (event: PoolLuckStepEvent) => (e: React.MouseEvent) => {
      setStepTip((prev) => {
        if (prev?.pinned) return prev;
        return { event, x: e.clientX, y: e.clientY, pinned: false };
      });
    },
    [],
  );
  const onStepLeave = useCallback(() => {
    setStepTip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onStepClick = useCallback(
    (event: PoolLuckStepEvent) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setStepTip({ event, x: e.clientX, y: e.clientY, pinned: true });
    },
    [],
  );
  const closeStepTip = useCallback(() => setStepTip(null), []);

  useEffect(() => {
    if (!retargetTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('hashrate-chart-pinned-retarget-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setRetargetTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [retargetTip?.pinned]);

  useEffect(() => {
    if (!blockTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document.getElementById('hashrate-chart-pinned-tooltip')?.contains(target)
      ) {
        return;
      }
      setBlockTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [blockTip?.pinned]);

  useEffect(() => {
    if (!stepTip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (
        target &&
        document
          .getElementById('hashrate-chart-pinned-luckstep-tooltip')
          ?.contains(target)
      ) {
        return;
      }
      setStepTip(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [stepTip?.pinned]);

  // Detect retarget points where `network_difficulty` steps. The
  // sustained-check filter (current matches the next non-null tick)
  // suppresses spurious detection on bucket-AVG-aggregated long
  // ranges where the bucket spanning the retarget shows an
  // intermediate averaged value. The 0.5% threshold separates real
  // retargets from rounding noise.
  //
  // Single-pass O(N): a reverse pre-pass builds a lookup table of
  // the next non-null difficulty value at or after each index, so
  // the forward pass doesn't have to re-scan to find it.
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
    const luckKey = rightAxisSeries === 'pool_luck_24h' ? 'pool_luck_24h' as const
                  : rightAxisSeries === 'pool_luck_7d' ? 'pool_luck_7d' as const
                  : rightAxisSeries === 'pool_luck_30d' ? 'pool_luck_30d' as const
                  : null;
    const out: RetargetEvent[] = [];
    let prev: number | null = null;
    for (let i = 0; i < n; i += 1) {
      const d = points[i]!.network_difficulty;
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      if (prev !== null && Math.abs(d - prev) / prev > 0.005) {
        const next = i + 1 < n ? nextNonNull[i + 1] ?? null : null;
        if (next === null || Math.abs(next - d) / d <= 0.005) {
          // #229: derive retarget block height + prior-epoch pool
          // block count from `ourBlocks` (the pool_blocks table).
          // Trivial to compute since the helpers walk the array;
          // doing it here means the tooltip just reads the field.
          const retargetTickAt = points[i]!.tick_at;
          const blockHeight = inferRetargetBlockHeight(retargetTickAt, ourBlocks);
          const poolBlocksPriorEpoch = blockHeight !== null
            ? countPriorEpochPoolBlocks(blockHeight, ourBlocks)
            : null;
          out.push({
            tick_at: retargetTickAt,
            difficulty: d,
            previous: prev,
            luckBefore: luckKey && i > 0 ? points[i - 1]![luckKey] : undefined,
            luckAfter: luckKey ? points[i]![luckKey] : undefined,
            block_height: blockHeight,
            pool_blocks_prior_epoch: poolBlocksPriorEpoch,
          });
        }
      }
      prev = d;
    }
    return out;
  }, [points, rightAxisSeries, ourBlocks]);

  const chartData = useMemo(() => {
    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    // Counter-derived Braiins delivered (#52). Braiins' own
    // `delivered_ph` is a lagged rolling average that holds elevated
    // for minutes after shares actually stop flowing - during
    // outages the orange line sat at 3.67 PH/s while Datum/Ocean
    // correctly dipped to near-zero and the counter stopped ticking.
    // Deriving PH from `Δprimary_bid_consumed_sat / (our_bid × Δt)`
    // tracks real matching activity; the same signal already drives
    // the PRICE chart's effective-rate line, so both charts agree
    // about when we're actually getting hashrate vs when we aren't.
    // Fallback to raw `delivered_ph` when we don't have a clean
    // counter delta (pre-migration rows, counter reset, null bid).
    const rawYs: (number | null)[] = points.map((p, i) => {
      if (i === 0) return p.delivered_ph;
      const prev = points[i - 1]!;
      const c0 = prev.primary_bid_consumed_sat;
      const c1 = p.primary_bid_consumed_sat;
      const bid = p.our_primary_price_sat_per_ph_day;
      const dt = p.tick_at - prev.tick_at;
      if (
        c0 !== null && c1 !== null && c0 > 0 && c1 >= c0 &&
        bid !== null && Number.isFinite(bid) && bid > 0 &&
        dt > 0 && dt <= 5 * 60_000
      ) {
        const derived = ((c1 - c0) * 86_400_000) / (bid * dt);
        const ceiling = Math.max(p.delivered_ph, p.target_ph) * 5;
        if (ceiling > 0 && derived > ceiling) return p.delivered_ph;
        return derived;
      }
      return p.delivered_ph;
    });
    const targets = points.map((p) => p.target_ph);
    const floors = points.map((p) => p.floor_ph);
    const rawDatumYs = points.map((p) => p.datum_hashrate_ph);
    const hasDatum = rawDatumYs.some((v) => v !== null);
    const oceanYs = points.map((p) => p.ocean_hashrate_ph);
    // #93: pick the right-axis series spec from rightAxisSeries.
    // Each spec defines the per-point values, the tick formatter, the
    // axis label, and the line stroke colour. 'none' produces null.
    const rightAxis: RightAxisSpec | null = (() => {
      switch (rightAxisSeries) {
        case 'none':
          return null;
        case 'share_log':
          return {
            values: points.map((p) => p.share_log_pct),
            formatTick: (v) =>
              `${new Intl.NumberFormat(intlLocale, {
                minimumFractionDigits: 4,
                maximumFractionDigits: 4,
              }).format(v)}%`,
            axisLabel: '% of Ocean',
            stroke: COLOR_RIGHT_AXIS,
          };
        case 'network_difficulty':
          return {
            values: points.map((p) => p.network_difficulty),
            // Difficulty is a huge integer; render in trillions for a
            // legible 2-decimal axis.
            formatTick: (v) =>
              `${(v / 1e12).toLocaleString(intlLocale, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 2,
              })} T`,
            axisLabel: 'difficulty',
            stroke: COLOR_RIGHT_AXIS,
          };
        case 'pool_hashrate':
          return {
            values: points.map((p) => p.pool_hashrate_ph),
            // Honours the global hashrate-unit toggle. Compact form
            // because pool hashrate at typical Ocean magnitudes is
            // ~30 EH/s and the operator wants 1-decimal readability,
            // not 5-decimal noise.
            formatTick: (v) => {
              const unit = denomination.hashrateUnit;
              const factor = unit === 'TH' ? 1000 : unit === 'EH' ? 0.001 : 1;
              return formatCompactNumber(v * factor, intlLocale);
            },
            axisLabel: `pool ${denomination.hashrateSuffix}`,
            stroke: COLOR_RIGHT_AXIS,
          };
        case 'solo_hashrate': {
          // Project the per-tick fleet series onto the chart's x-axis.
          // We deliberately use nearest-neighbor matching with a ±15s
          // tolerance rather than an exact `tick_at` join: each
          // subsystem (`tick_metrics`, `solo_miner_samples`) captures
          // its own `Date.now()` during the tick, so the two tables
          // can be offset by hundreds of ms. The fix on the daemon
          // side pins both to the canonical tick_at going forward;
          // this fallback keeps pre-fix historical samples renderable
          // and any future skew tolerable.
          const xs = points.map((p) => p.tick_at);
          return {
            values: projectSoloSeries(xs, soloSeries, (r) => r.total_hashrate_ghs),
            formatTick: (v) => {
              if (v >= 1e6) return `${(v / 1e6).toFixed(2)} PH/s`;
              if (v >= 1000) return `${(v / 1000).toFixed(2)} TH/s`;
              return `${v.toFixed(0)} GH/s`;
            },
            axisLabel: 'solo hashrate',
            stroke: COLOR_RIGHT_AXIS,
          };
        }
        case 'solo_device_count': {
          const xs = points.map((p) => p.tick_at);
          return {
            values: projectSoloSeries(xs, soloSeries, (r) => r.device_count),
            formatTick: (v) => v.toFixed(0),
            axisLabel: 'solo devices',
            stroke: COLOR_RIGHT_AXIS,
            // Whole-device counts only - prevents the degenerate
            // "constant value over a tight range" case where every
            // tick would round-format to the same integer.
            tickHint: 'integer',
          };
        }
        case 'solo_max_temp': {
          const xs = points.map((p) => p.tick_at);
          const convert = (v: number | null): number | null =>
            v === null ? null : (tempUnit === 'F' ? v * 9 / 5 + 32 : v);
          return {
            values: projectSoloSeries(xs, soloSeries, (r) => convert(r.max_temp_c)),
            formatTick: (v) => `${v.toFixed(1)} °${tempUnit}`,
            axisLabel: tempUnit === 'F' ? 'solo max temp (°F)' : 'solo max temp (°C)',
            stroke: COLOR_RIGHT_AXIS,
          };
        }
        case 'solo_best_diff': {
          const xs = points.map((p) => p.tick_at);
          const raw = projectSoloSeries(xs, soloSeries, (r) => r.max_best_diff);
          // Compute running max so the line is a staircase that only goes up.
          let runningMax: number | null = null;
          const values = raw.map((v) => {
            if (v !== null && (runningMax === null || v > runningMax)) runningMax = v;
            return runningMax;
          });
          return {
            values,
            formatTick: (v) => {
              if (v >= 1e18) return `${(v / 1e18).toFixed(1)}E`;
              if (v >= 1e15) return `${(v / 1e15).toFixed(1)}P`;
              if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
              if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
              if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
              if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
              return v.toFixed(0);
            },
            axisLabel: 'solo best difficulty',
            stroke: COLOR_RIGHT_AXIS,
          };
        }
        case 'pool_luck_24h':
        case 'pool_luck_7d':
        case 'pool_luck_30d': {
          const key = rightAxisSeries as 'pool_luck_24h' | 'pool_luck_7d' | 'pool_luck_30d';
          const label = key === 'pool_luck_24h' ? 'pool luck (24h)'
                      : key === 'pool_luck_7d' ? 'pool luck (7d)'
                      : 'pool luck (30d)';
          return {
            values: points.map((p) => p[key]),
            formatTick: (v) =>
              `${new Intl.NumberFormat(intlLocale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }).format(v)}×`,
            axisLabel: label,
            stroke: COLOR_RIGHT_AXIS,
          };
        }
      }
    })();
    const shareLogYs = rightAxis?.values ?? points.map(() => null);
    const hasShareLog = rightAxis !== null && shareLogYs.some((v) => v !== null);
    // Mirror the left-axis padding when the overlay is on so the
    // right-axis labels have breathing room equal to PH/s on the left.
    // Off → unchanged from today (no layout shift).
    const padRight = hasShareLog ? PADDING_RIGHT_WITH_SHARE_LOG : PADDING.right;
    // Apply operator-configured rolling-mean smoothing to the raw
    // per-tick signals. Ocean is left alone - /user_hashrate is
    // already a 5-min server-side average. The counter-derived
    // Braiins series can be null for pre-migration rows (falls back
    // to delivered_ph in the map above), so `?? 0` is only defensive.
    // `datum_hashrate_ph` legitimately carries nulls (gateway
    // not configured / poll failed), which `pathWithNullGaps`
    // renders as segment breaks.
    const smoothedYs = rollingMean(xs, rawYs, braiinsSmoothingMinutes).map((v) => v ?? 0);
    const ys: readonly number[] = smoothedYs;
    const datumYs = rollingMean(xs, rawDatumYs, datumSmoothingMinutes);
    const datumMax = datumYs.reduce<number>(
      (acc, v) => (v !== null && v > acc ? v : acc),
      0,
    );
    const oceanMax = oceanYs.reduce<number>(
      (acc, v) => (v !== null && v > acc ? v : acc),
      0,
    );
    const hasOcean = oceanYs.some((v) => v !== null);

    const dataMinX = xs[0]!;
    const dataMaxX = xs[xs.length - 1]!;
    const minX = viewportSince ?? dataMinX;
    const maxX = viewportUntil ?? dataMaxX;

    let yMaxData = 0;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i]! < minX || xs[i]! > maxX) continue;
      const v = Math.max(ys[i]!, targets[i]!, floors[i]!);
      if (v > yMaxData) yMaxData = v;
      const d = datumYs[i] ?? null;
      if (d !== null && d > yMaxData) yMaxData = d;
      const o = oceanYs[i] ?? null;
      if (o !== null && o > yMaxData) yMaxData = o;
    }

    const yTicks = niceYTicks(0, yMaxData > 0 ? yMaxData * 1.1 : 1, 5);
    const yMin = yTicks[0] ?? 0;
    const yMax = yTicks[yTicks.length - 1] ?? 1;

    const xScale = (x: number): number => {
      const usable = WIDTH - PADDING.left - padRight;
      if (maxX === minX) return PADDING.left + usable / 2;
      return PADDING.left + ((x - minX) / (maxX - minX)) * usable;
    };
    const yScale = (y: number): number => {
      const usable = chartHeight - PADDING.top - PADDING.bottom;
      return chartHeight - PADDING.bottom - ((y - yMin) / (yMax - yMin)) * usable;
    };

    // Right-side Y-axis for the share_log overlay. niceYTicks gives a
    // human-readable scale (0.01, 0.02, 0.03 etc.) without us having
    // to special-case the 4-decimal magnitude - the ticks come out as
    // round numbers and the formatter renders them with 4 decimals to
    // match Ocean's display convention.
    let shareLogYTicks: number[] = [];
    let shareLogYMin = 0;
    let shareLogYMax = 1;
    if (hasShareLog) {
      let slMin = Infinity;
      let slMax = -Infinity;
      for (let i = 0; i < shareLogYs.length; i += 1) {
        const raw = shareLogYs[i];
        if (raw === null || raw === undefined || !Number.isFinite(raw)) continue;
        if (xs[i]! < minX || xs[i]! > maxX) continue;
        if (raw < slMin) slMin = raw;
        if (raw > slMax) slMax = raw;
      }
      if (rightAxis?.tickHint === 'integer') {
        // Integer-tick path: build the band on integer boundaries so
        // a constant series (e.g. device_count = 3) doesn't collapse
        // into seven 0.01-step ticks that all toFixed-render to "3".
        // Anchor low at 0 (an "of N total" frame the operator actually
        // wants for a count series), high at max(observed) + 1 with a
        // minimum span of 3 so the line never sits on the top rule.
        const lo = 0;
        const hi = Math.max(Math.ceil(slMax) + 1, 3);
        shareLogYTicks = [];
        for (let v = lo; v <= hi; v++) shareLogYTicks.push(v);
      } else if (
        rightAxisSeries === 'solo_hashrate' ||
        rightAxisSeries === 'solo_max_temp'
      ) {
        const yFloor = 0;
        const yCeiling = slMax > 0 ? slMax * 1.1 : 1;
        shareLogYTicks = niceYTicks(yFloor, yCeiling, 5);
      } else {
        const rawSpan = slMax - slMin;
        let yFloor: number;
        let yCeiling: number;
        if (rawSpan === 0) {
          if (slMax === 0) {
            yFloor = 0;
            yCeiling = 1;
          } else {
            const pad = Math.max(Math.abs(slMax) * 0.1, 1);
            yFloor = Math.max(0, slMax - pad);
            yCeiling = slMax + pad;
          }
        } else {
          yFloor = Math.max(0, slMin - rawSpan * 0.1);
          yCeiling = slMax + rawSpan * 0.1;
        }
        shareLogYTicks = niceYTicks(yFloor, yCeiling, 5);
      }
      shareLogYMin = shareLogYTicks[0] ?? 0;
      shareLogYMax = shareLogYTicks[shareLogYTicks.length - 1] ?? 1;
      // #236 follow-up: when every tick renders to the same formatted
      // label, the data is constant within the formatter's display
      // precision (e.g. network difficulty over a 24h window where
      // niceYTicks pads ±0.0001 around the central value but the
      // trillion-scale "X.XX T" formatter rounds them all identically).
      // Re-pad with a value-relative minimum (5%) so the surrounding
      // scale shows distinct round-number ticks, and anchor the
      // actual data value at the top so the line sits where the
      // operator expects (138.96 T at top, 132/134/136 below). The
      // collapsed-to-one-label variant of this fix turned out to be
      // too austere - the operator wants a real scale, just an
      // honest one.
      if (rightAxis) {
        const labels = new Set(shareLogYTicks.map((v) => rightAxis.formatTick(v)));
        if (labels.size === 1 && shareLogYTicks.length > 1) {
          const center = (slMin + slMax) / 2;
          const pad = Math.max(Math.abs(center) * 0.05, 1);
          const newFloor = Math.max(0, center - pad);
          const newCeiling = center;
          const niceTicks = niceYTicks(newFloor, newCeiling, 4);
          const tooClose = pad * 0.2;
          const filteredNice = niceTicks.filter((tk) => Math.abs(tk - center) > tooClose);
          shareLogYTicks = [...filteredNice, center];
          shareLogYMin = shareLogYTicks[0] ?? newFloor;
          shareLogYMax = center;
        }
      }
    }
    const shareLogYScale = (y: number): number => {
      const usable = chartHeight - PADDING.top - PADDING.bottom;
      const span = shareLogYMax - shareLogYMin;
      if (span <= 0) return chartHeight - PADDING.bottom;
      return (
        chartHeight - PADDING.bottom - ((y - shareLogYMin) / span) * usable
      );
    };

    const hashratePath = (values: readonly number[]): string =>
      values
        .map((v, i) => {
          const cmd = i === 0 ? 'M' : 'L';
          return `${cmd}${xScale(xs[i]!).toFixed(1)},${yScale(v).toFixed(1)}`;
        })
        .join(' ');

    // Datum / Ocean paths: break into segments on null. Without this,
    // SVG would render a straight line across gaps (pre-migration
    // data, poll failures) and make those gaps look like real data.
    const pathWithNullGaps = (values: readonly (number | null | undefined)[]): string => {
      const segments: string[] = [];
      let current = '';
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        if (v === null || v === undefined) {
          if (current) {
            segments.push(current);
            current = '';
          }
          continue;
        }
        const x = xScale(xs[i]!).toFixed(1);
        const y = yScale(v).toFixed(1);
        current += `${current ? 'L' : 'M'}${x},${y} `;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    };
    const datumPath = pathWithNullGaps(datumYs);
    const oceanPath = pathWithNullGaps(oceanYs);
    // Share-log uses its own Y-scale (right-side axis), so it can't
    // share `pathWithNullGaps` above which closes over the left-axis
    // yScale. Build the path inline against shareLogYScale.
    const shareLogPath = ((): string => {
      if (!hasShareLog) return '';
      const segments: string[] = [];
      let current = '';
      for (let i = 0; i < shareLogYs.length; i += 1) {
        const v = shareLogYs[i];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          if (current) {
            segments.push(current);
            current = '';
          }
          continue;
        }
        const x = xScale(xs[i]!).toFixed(1);
        const y = shareLogYScale(v).toFixed(1);
        current += `${current ? 'L' : 'M'}${x},${y} `;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    })();

    const deliveredPath = hashratePath(ys);
    const targetPath = hashratePath(targets);
    const floorPath = hashratePath(floors);

    // X-axis: round local-time ticks (08:00, 09:00, ...) instead of the
    // arbitrary first/last timestamps. Same ticks shared with PriceChart.
    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    return {
      xs,
      minX,
      maxX,
      dataMinX,
      dataMaxX,
      yMax,
      yMin,
      xScale,
      yScale,
      deliveredPath,
      datumPath,
      hasDatum,
      oceanPath,
      hasOcean,
      targetPath,
      floorPath,
      yTicks,
      xTickInterval,
      xTicks,
      hasShareLog,
      shareLogPath,
      shareLogYTicks,
      shareLogYScale,
      padRight,
      rightAxis,
      // #167/#173: split fillable-null spans into marketplace-empty vs
      // Braiins-unreachable. Pre-migration rows (braiins_reachable null)
      // keep the legacy gray band.
      ...(() => {
        const marketplaceEmptyIntervals: Array<{ x0: number; x1: number }> = [];
        const braiinsUnreachableIntervals: Array<{ x0: number; x1: number }> = [];
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
        return { marketplaceEmptyIntervals, braiinsUnreachableIntervals, daemonOfflineIntervals };
      })(),
    };
  }, [
    points,
    braiinsSmoothingMinutes,
    datumSmoothingMinutes,
    rightAxisSeries,
    soloSeries,
    denomination,
    intlLocale,
    chartHeight,
    viewportSince,
    viewportUntil,
  ]);

  // Pre-computed retarget marker positions. Filtered to the visible
  // x-range and resolved to (cx, cy) once per (markers x scales)
  // change so the SVG render path doesn't re-walk the array on
  // every parent re-render.
  //
  // MUST sit above the `if (!chartData)` early return below: React
  // requires hook-call order to be stable across renders, and on
  // first paint chartData can be null. The callback handles the
  // null case internally.
  const visibleRetargetMarkers = useMemo(() => {
    const empty: Array<{ event: RetargetEvent; cx: number; cy: number }> = [];
    if (!chartData) return empty;
    const isLuck = rightAxisSeries === 'pool_luck_24h' || rightAxisSeries === 'pool_luck_7d' || rightAxisSeries === 'pool_luck_30d';
    if (rightAxisSeries !== 'network_difficulty' && !isLuck) return empty;
    const { dataMinX, dataMaxX, xScale, shareLogYScale } = chartData;
    return difficultyRetargets
      .filter((r) => r.tick_at >= dataMinX && r.tick_at <= dataMaxX)
      .map((r) => ({
        event: r,
        cx: xScale(r.tick_at),
        cy: isLuck && r.luckAfter != null
          ? shareLogYScale(r.luckAfter)
          : shareLogYScale(r.difficulty),
      }));
  }, [chartData, difficultyRetargets, rightAxisSeries]);

  // #128: pool-luck step markers. Each pool block generates two
  // events:
  //   - 'in'  at  block.timestamp_ms (the moment the pool found it -
  //          numerator goes from N to N+1, line steps up)
  //   - 'out' at  block.timestamp_ms + windowMs (the moment it ages
  //          out of the rolling window - line steps down)
  // The marker positions on the new value (post-step), found by
  // scanning `points` for the first tick at-or-after the event time
  // and reading its persisted pool_luck column. Skips the event when
  // we have no point that close (predates our tick history; the line
  // wouldn't be drawn there either).
  const visibleLuckStepMarkers = useMemo(() => {
    const empty: Array<{
      event: PoolLuckStepEvent;
      cx: number;
      cy: number;
      blockCx: number;
    }> = [];
    if (!chartData) return empty;
    if (
      rightAxisSeries !== 'pool_luck_24h' &&
      rightAxisSeries !== 'pool_luck_7d' &&
      rightAxisSeries !== 'pool_luck_30d'
    ) {
      return empty;
    }
    const DAY_MS = 24 * 60 * 60 * 1000;
    const windowMs = rightAxisSeries === 'pool_luck_24h' ? DAY_MS
                   : rightAxisSeries === 'pool_luck_7d' ? 7 * DAY_MS
                   : 30 * DAY_MS;
    const { dataMinX, dataMaxX, xScale, shareLogYScale } = chartData;
    const countKey = rightAxisSeries === 'pool_luck_24h' ? 'pool_blocks_24h_count'
                   : rightAxisSeries === 'pool_luck_7d' ? 'pool_blocks_7d_count'
                   : 'pool_blocks_30d_count';
    const luckKey = rightAxisSeries as 'pool_luck_24h' | 'pool_luck_7d' | 'pool_luck_30d';
    // The block-count column updates with the Ocean refresher's cadence
    // (~few minutes), not on the on-chain block timestamp. If we picked
    // `before`/`after` as the two ticks straddling the event time, both
    // would still have the pre-event count and the tooltip would report
    // "luck went from 0.47× to 0.47×" even when the chart line visibly
    // steps a few ticks later (#161). Find instead the first tick where
    // the count actually changed in the direction we expect and use
    // that as `after`; `before` is the tick immediately preceding the
    // step. Linear scans are fine - chart point counts are small.
    const MAX_LAG_TICKS = 15; // ~15 min of slack at 60 s cadence
    const out: typeof empty = [];
    for (const block of ourBlocks) {
      for (const kind of ['in', 'out'] as const) {
        const t =
          kind === 'in' ? block.timestamp_ms : block.timestamp_ms + windowMs;
        if (t < dataMinX || t > dataMaxX) continue;
        // Locate the tick at or after the event time - the count-change
        // we're scanning for is somewhere from here onwards.
        let eventIdx = -1;
        for (let i = 0; i < points.length; i++) {
          if (points[i]!.tick_at >= t) {
            eventIdx = i;
            break;
          }
        }
        if (eventIdx < 0) continue;
        // Pre-event count: use the tick just before the event time, or
        // fall back to the event-time tick when the event is at the
        // start of the chart range (no earlier tick available).
        const baseCount =
          eventIdx > 0
            ? points[eventIdx - 1]![countKey]
            : points[eventIdx]![countKey];
        if (baseCount === null) continue;
        // Scan forward for the first tick where the count moved in the
        // expected direction. For 'in', count should go up by one (the
        // newly-credited block); for 'out', down by one (the block
        // rotating out of the rolling window).
        let afterIdx = -1;
        const scanEnd = Math.min(points.length, eventIdx + MAX_LAG_TICKS);
        for (let i = eventIdx; i < scanEnd; i++) {
          const c = points[i]![countKey];
          if (c === null) continue;
          if (kind === 'in' ? c > baseCount : c < baseCount) {
            afterIdx = i;
            break;
          }
        }
        if (afterIdx < 0) continue; // daemon hasn't reflected the step yet
        const after = points[afterIdx]!;
        const before = afterIdx > 0 ? points[afterIdx - 1]! : null;
        const luckAfter = after[luckKey];
        const luckBefore = before === null ? null : before[luckKey];
        if (luckAfter === null) continue;
        out.push({
          event: { kind, t, block, luckBefore, luckAfter, windowMs },
          cx: xScale(after.tick_at),
          cy: shareLogYScale(luckAfter),
          blockCx: xScale(t),
        });
      }
    }
    return out;
  }, [chartData, ourBlocks, points, rightAxisSeries]);

  if (!chartData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Hashrate</Trans>
          </h3>
        </div>
        <div className="mt-4 text-sm text-slate-500">
          <Trans>Not enough data in this range yet.</Trans>
        </div>
      </div>
    );
  }

  const { minX, maxX, dataMinX, dataMaxX, xScale, yScale, deliveredPath, datumPath, hasDatum, oceanPath, hasOcean, targetPath, floorPath, yTicks, xTickInterval, xTicks, hasShareLog, shareLogPath, shareLogYTicks, shareLogYScale, padRight, rightAxis, marketplaceEmptyIntervals, braiinsUnreachableIntervals, daemonOfflineIntervals } = chartData;

  return (
    <div className="bg-slate-900 border rounded-lg p-4 border-slate-800">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Hashrate</Trans>
          </h3>
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
          <Legend color={COLOR_DELIVERED} label={t`delivered (Braiins)`} />
          {hasDatum && (
            <Legend color={COLOR_DATUM} label={t`received (Datum)`} />
          )}
          {hasOcean && (
            <Legend color={COLOR_OCEAN} label={t`received (Ocean)`} />
          )}
          {hasShareLog && rightAxis && (
            <Legend color={rightAxis.stroke} label={rightAxis.axisLabel} />
          )}
          <Legend color={COLOR_TARGET} label={t`target`} dashed />
          <Legend color={COLOR_FLOOR} label={t`floor`} dashed />
          {ourBlocks.some(
              (b) =>
                b.timestamp_ms >= chartData.minX &&
                b.timestamp_ms <= chartData.maxX &&
                !b.found_by_us,
            ) && <Legend color={COLOR_POOL_BLOCK} label={t`pool block`} dashed />}
          {ourBlocks.some(
              (b) =>
                b.timestamp_ms >= chartData.minX &&
                b.timestamp_ms <= chartData.maxX &&
                b.found_by_us,
            ) && <Legend color={COLOR_OUR_BLOCK} label={t`found by us`} dashed />}
          {markersHiddenCount > 0 && (
            <span
              className="text-[10px] text-slate-500 italic"
              title={t`Markers were hidden because the combined count exceeded the configured chart-marker cap. Adjust the cap on Config → Display & Logging.`}
            >
              <Trans>{markersHiddenCount} markers hidden (cap)</Trans>
            </span>
          )}
        </div>
      </div>
      <svg
        ref={wheelRef}
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
        {...viewportHandlers}
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
              {(() => {
                // Compact tick labels - the chart already shows the
                // unit on the rotated axis label, so the per-tick
                // text just needs the scaled value. formatHashrate
                // gives 5 decimals on EH which wastes axis width;
                // formatCompactNumber drops trailing zeros and uses
                // k/M/B suffixes when needed.
                const unit = denomination.hashrateUnit;
                const factor = unit === 'TH' ? 1000 : unit === 'EH' ? 0.001 : 1;
                return formatCompactNumber(v * factor, intlLocale);
              })()}
            </text>
          </g>
        ))}

        {hasShareLog && rightAxis &&
          shareLogYTicks.map((v, i) => (
            <g key={`y-share-${i}`}>
              <text
                x={WIDTH - padRight + 6}
                y={shareLogYScale(v) + 4}
                textAnchor="start"
                fontSize="10"
                fill={rightAxis.stroke}
                fontFamily="monospace"
              >
                {rightAxis.formatTick(v)}
              </text>
            </g>
          ))}

        <defs>
          <clipPath id="hr-data-clip">
            <rect x={PADDING.left} y={0} width={WIDTH - PADDING.left - padRight} height={chartHeight} />
          </clipPath>
        </defs>
        <g clipPath="url(#hr-data-clip)">
        {/* #167: marketplace-empty bands. Drawn behind data lines so
            they sit behind the traces without obscuring them. Each
            interval represents a contiguous run of ticks where the
            Braiins orderbook had no asks that could fill the target
            hashrate. Diagonal-hatch pattern (vs an earlier flat tint)
            makes the band actually stand out at a glance - the
            12%-opacity slate fill alone was easy to miss until you
            hovered for the tooltip. */}
        {marketplaceEmptyIntervals.length > 0 && (
          <defs>
            <pattern
              id="mktEmptyHatchHr"
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
              fill="url(#mktEmptyHatchHr)"
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
              id="braiinsUnreachHatchHr"
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
              fill="url(#braiinsUnreachHatchHr)"
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
              id="offlineHatchHr"
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
              fill="url(#offlineHatchHr)"
            >
              <title>
                {`Daemon offline (${formatDuration(iv.x1 - iv.x0)})`}
              </title>
            </rect>
          );
        })}
        <path d={targetPath} stroke={COLOR_TARGET} strokeWidth="1.2" strokeDasharray="4 3" fill="none" opacity="0.6" />
        <path d={floorPath} stroke={COLOR_FLOOR} strokeWidth="1" strokeDasharray="2 3" fill="none" opacity="0.5" />

        <path
          d={`${deliveredPath} L${xScale(dataMaxX).toFixed(1)},${yScale(0)} L${xScale(dataMinX).toFixed(1)},${yScale(0)} Z`}
          fill="url(#deliveredFill)"
          opacity="0.5"
          pointerEvents="none"
        />
        <path d={deliveredPath} stroke={COLOR_DELIVERED} strokeWidth="1.8" fill="none" />
        {hasDatum && (
          <path
            d={datumPath}
            stroke={COLOR_DATUM}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {hasOcean && (
          <path
            d={oceanPath}
            stroke={COLOR_OCEAN}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {hasShareLog && rightAxis && (
          <path
            d={shareLogPath}
            stroke={rightAxis.stroke}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {rightAxis &&
          visibleRetargetMarkers.map(({ event, cx, cy }) => (
            <g
              key={`retarget-${event.tick_at}`}
              onMouseEnter={onRetargetEnter(event)}
              onMouseLeave={onRetargetLeave}
              onClick={onRetargetClick(event)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={cx}
                cy={cy}
                r="4.5"
                fill={rightAxis.stroke}
                stroke="#0f172a"
                strokeWidth="1.5"
              />
              <rect x={cx - 9} y={cy - 9} width="18" height="18" fill="transparent" />
            </g>
          ))}

        {/* #128: pool-luck step markers. Same colour as the line so
            they read as "events on this curve". Both 'in' and 'out'
            kinds use the same shape per operator preference; the
            tooltip tells direction. */}
        {rightAxis &&
          visibleLuckStepMarkers.map(({ event, cx, cy, blockCx }) => (
            <g
              key={`luckstep-${event.kind}-${event.block.height}`}
              onMouseEnter={onStepEnter(event)}
              onMouseLeave={onStepLeave}
              onClick={onStepClick(event)}
              style={{ cursor: 'pointer' }}
            >
              {Math.abs(cx - blockCx) > 2 && (
                <line
                  x1={blockCx}
                  y1={cy}
                  x2={cx}
                  y2={cy}
                  stroke={rightAxis.stroke}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.5"
                  pointerEvents="none"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r="3.5"
                fill={rightAxis.stroke}
                stroke="#0f172a"
                strokeWidth="1.2"
              />
              <rect x={cx - 7} y={cy - 7} width="14" height="14" fill="transparent" />
            </g>
          ))}

        {ourBlocks
            .filter((b) => b.timestamp_ms >= dataMinX && b.timestamp_ms <= dataMaxX)
            .map((b) => {
              const x = xScale(b.timestamp_ms);
              // #115: marker semantics, in precedence order.
              // - Own block (found_by_us): GOLD CROWN. The rarest,
              //   loudest event on the chart.
              // - BIP 110-signalling pool block: YELLOW cube. Quieter
              //   than the gold crown but still distinct from the
              //   default blue cube.
              // - Anything else: default Ocean-blue cube.
              const isOurs = b.found_by_us;
              const isBip110 = !isOurs && b.signals_bip110 === true;
              const color = isOurs
                ? COLOR_OUR_BLOCK
                : isBip110
                  ? COLOR_BIP110
                  : COLOR_POOL_BLOCK;
              return (
                <g
                  key={b.block_hash || b.height}
                  onMouseEnter={onBlockEnter(b)}
                  onMouseLeave={onBlockLeave}
                  onClick={onBlockClick(b)}
                  style={{ cursor: 'pointer' }}
                >
                  <line
                    x1={x}
                    x2={x}
                    y1={PADDING.top + 8}
                    y2={chartHeight - PADDING.bottom}
                    stroke={color}
                    strokeWidth={isOurs ? '1.8' : '1'}
                    strokeDasharray={isOurs ? '4 2' : '2 3'}
                    opacity={isOurs ? '0.95' : '0.55'}
                    pointerEvents="none"
                  />
                  {/* Transparent hit-target scoped to the icon area
                      only (#post-#115). The earlier rect spanned the
                      entire chart height to make the thin dashed line
                      forgiving to click, but that caused every chart
                      column near a block's vertical line to register
                      as a pool-block click - confusing on the wider
                      ranges where many blocks sit close together.
                      Now the click anchor is the icon itself plus a
                      small ~3px forgiveness margin; the dashed
                      vertical line is decoration, not a hit target.
                      Icon glyph is 10x10 translated to
                      (x - 5, PADDING.top - 9), so the icon's bbox
                      is roughly (x - 5..x + 5, PADDING.top - 9..
                      PADDING.top + 1). The rect adds 3px slack on
                      each axis. */}
                  <rect
                    x={x - 8}
                    y={PADDING.top - 12}
                    width={16}
                    height={16}
                    fill="transparent"
                  />
                  {isOurs ? (
                    // CROWN - reserved post-#115 for the rare
                    // own-block case. Same path data as before; what
                    // changed is the trigger condition.
                    <g
                      transform={`translate(${x - 5}, ${PADDING.top - 9})`}
                      fill={color}
                      fillOpacity="0.45"
                      stroke={color}
                      strokeWidth="1.1"
                      strokeLinejoin="round"
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
                  x1={x}
                  x2={x}
                  y1={PADDING.top + 8}
                  y2={chartHeight - PADDING.bottom}
                  stroke="#c084fc"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.4"
                  pointerEvents="none"
                />
                <rect
                  x={x - 9}
                  y={PADDING.top - 13}
                  width={18}
                  height={18}
                  fill="transparent"
                />
                <svg
                  x={x - 7} y={PADDING.top - 11}
                  width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="#c084fc" strokeWidth="2"
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

        <defs>
          <linearGradient id="deliveredFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_DELIVERED} stopOpacity="0.45" />
            <stop offset="100%" stopColor={COLOR_DELIVERED} stopOpacity="0" />
          </linearGradient>
        </defs>
        </g>

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

        <text
          x={14}
          y={PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2}
          textAnchor="middle"
          fontSize="10"
          fill="#64748b"
          fontFamily="monospace"
          transform={`rotate(-90 14 ${PADDING.top + (chartHeight - PADDING.top - PADDING.bottom) / 2})`}
        >
          {denomination.hashrateSuffix}
        </text>
        {hasShareLog && rightAxis && (
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

        {rightAxisSeries === 'solo_best_diff' && bestDiffEvents
          .filter((ev) => ev.recorded_at >= dataMinX && ev.recorded_at <= dataMaxX)
          .map((ev) => {
            const x = xScale(ev.recorded_at);
            return (
              <g key={ev.recorded_at}>
                <line
                  x1={x}
                  x2={x}
                  y1={PADDING.top + 8}
                  y2={chartHeight - PADDING.bottom}
                  stroke="#f59e0b"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.45"
                  pointerEvents="none"
                />
                <rect
                  x={x - 9}
                  y={PADDING.top - 13}
                  width={18}
                  height={18}
                  fill="transparent"
                />
                <svg
                  x={x - 7} y={PADDING.top - 11}
                  width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="#f59e0b" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  opacity="0.85"
                >
                  <path d="M6 2h12v6a6 6 0 0 1-12 0V2z" fill="#f59e0b" fillOpacity="0.25" />
                  <path d="M12 14v4" />
                  <path d="M8 18h8" />
                  <path d="M4 2v4a2 2 0 0 0 2 2" />
                  <path d="M20 2v4a2 2 0 0 1-2 2" />
                </svg>
              </g>
            );
          })}

      </svg>
      {blockTip && (
        <PoolBlockTooltip
          tip={blockTip}
          explorerTemplate={blockExplorerTemplate}
          locale={intlLocale}
          shareLogPct={shareLogPct}
          onClose={closeBlockTip}
          pinnedDomId="hashrate-chart-pinned-tooltip"
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
      {stepTip && (
        <PoolLuckStepTooltip
          tip={stepTip}
          explorerTemplate={blockExplorerTemplate ?? ''}
          locale={intlLocale}
          onClose={closeStepTip}
        />
      )}
    </div>
  );
});

export interface PoolBlockTooltipState {
  block: OurBlockMarker;
  x: number;
  y: number;
  pinned: boolean;
}

/**
 * Shared between HashrateChart and PriceChart so both can render the
 * same rich pool-block tooltip - reward, our share, BIP-110 signal,
 * explorer link - when a marker is hovered or clicked. Caller is
 * responsible for the marker geometry; this component only handles
 * the floating panel + viewport-edge clamping.
 */
export function PoolBlockTooltip({
  tip,
  explorerTemplate,
  locale,
  shareLogPct,
  onClose,
  pinnedDomId,
}: {
  tip: PoolBlockTooltipState;
  explorerTemplate: string;
  locale: string | undefined;
  shareLogPct: number | null;
  onClose: () => void;
  /** DOM id used by the host chart's outside-click listener to detect
   *  clicks inside the pinned tooltip and avoid closing it. */
  pinnedDomId?: string;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const { block, pinned } = tip;
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
    const margin = 8;
    let left = tip.x + 12;
    let top = tip.y + 12;
    if (left + rect.width > window.innerWidth - margin) left = tip.x - rect.width - 12;
    if (top + rect.height > window.innerHeight - margin) top = tip.y - rect.height - 12;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, block.block_hash]);

  const url = applyExplorerTemplate(explorerTemplate, block);
  const rewardBtc = block.total_reward_sat / 1e8;
  const subsidyBtc = block.subsidy_sat / 1e8;
  const feesBtc = block.fees_sat / 1e8;
  // #115: header colour + label match the chart-marker semantics:
  // gold crown for own blocks, yellow cube for BIP 110-signalling
  // (and not own), sky-blue cube otherwise.
  const isOurs = block.found_by_us;
  const isBip110 = !isOurs && block.signals_bip110 === true;
  const headerColor = isOurs
    ? 'text-amber-300'
    : isBip110
      ? 'text-yellow-200'
      : 'text-sky-300';
  const kindLabel = isOurs
    ? t`FOUND BY US`
    : isBip110
      ? t`BIP 110 SIGNAL`
      : t`POOL BLOCK`;

  return (
    <div
      ref={ref}
      id={pinned ? pinnedDomId : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`font-semibold uppercase tracking-wider ${headerColor}`}>
          {kindLabel} · #{block.height.toLocaleString(locale)}
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
        {fmt.timestamp(block.timestamp_ms)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(block.timestamp_ms)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(block.timestamp_ms)}</div>

      <div className="mt-2 space-y-0.5 text-slate-300">
        <BtcRow label={t`pool reward`} btc={rewardBtc} locale={locale} />
        <BtcRow label={t`subsidy`} btc={subsidyBtc} locale={locale} muted />
        <BtcRow label={t`fees`} btc={feesBtc} locale={locale} muted />
      </div>

      {block.signals_bip110 === true && (
        <div className="mt-2 pt-2 border-t border-slate-800 text-amber-300 text-[11px]">
          <Trans>Signaling BIP 110 (Reduced Data Temporary Soft Fork)</Trans>
        </div>
      )}

      {(() => {
        // Prefer the per-block historical share_log captured at the
        // block's moment; only fall back to the live share_log (with
        // the drift caveat) when we have no tick within tolerance -
        // i.e. the block predates our tick history.
        const historical = block.share_log_pct_at_block;
        const usingHistorical = historical !== null && historical > 0;
        const effective = usingHistorical
          ? historical
          : shareLogPct !== null && shareLogPct > 0
            ? shareLogPct
            : null;
        if (effective === null) return null;
        return (
          <div className="mt-2 pt-2 border-t border-slate-800 space-y-0.5 text-slate-300">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
              <Trans>our share (est.)</Trans>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500"><Trans>share log</Trans></span>
              <span className="font-mono tabular-nums">
                {new Intl.NumberFormat(locale, {
                  minimumFractionDigits: 4,
                  maximumFractionDigits: 4,
                }).format(effective)}%
              </span>
            </div>
            <BtcRow
              label={t`our earnings`}
              btc={(rewardBtc * effective) / 100}
              locale={locale}
            />
            {!usingHistorical && (
              <div className="text-[10px] text-slate-500 italic mt-0.5 whitespace-normal max-w-[18rem]">
                <Trans>
                  uses current share_log - an approximation for older blocks,
                  since share_log drifts as pool hashrate moves.
                </Trans>
              </div>
            )}
          </div>
        );
      })()}

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
    </div>
  );
}

/**
 * Tooltip rendered when an operator hovers / clicks one of the
 * difficulty-retarget dots on the right-axis network_difficulty
 * line. Shows the date of the retarget tick, the new difficulty in
 * trillions, and the % change vs the previous epoch (positive
 * green, negative red - matches the "easier vs harder" intuition).
 */
export function RetargetTooltip({
  tip,
  locale,
  dateTimeLocale,
  onClose,
}: {
  tip: RetargetTooltipState;
  locale: string | undefined;
  dateTimeLocale: string | undefined;
  onClose: () => void;
}) {
  void dateTimeLocale;
  const fmt = useFormatters();
  const { i18n } = useLingui();
  void i18n;
  const { event, pinned } = tip;
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
    const margin = 8;
    let left = tip.x + 12;
    let top = tip.y + 12;
    if (left + rect.width > window.innerWidth - margin) left = tip.x - rect.width - 12;
    if (top + rect.height > window.innerHeight - margin) top = tip.y - rect.height - 12;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, event.tick_at]);

  const pct = ((event.difficulty - event.previous) / event.previous) * 100;
  const pctText = `${pct >= 0 ? '+' : ''}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pct)}%`;
  const pctColor = pct >= 0 ? 'text-red-300' : 'text-emerald-300';
  const diffT = (event.difficulty / 1e12).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prevT = (event.previous / 1e12).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const hasLuck = event.luckBefore != null && event.luckAfter != null;
  const fmtLuck = (v: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);

  // #229: avg block time over the prior epoch, derived exactly from
  // the difficulty delta. Bitcoin's retarget formula is
  //   new_difficulty / old_difficulty = target_timespan / actual_timespan
  // so actual avg block time = 600s × (old / new). Render as
  // "9m 52s" with sub-minute precision.
  const avgBlockSec = event.previous > 0 && event.difficulty > 0
    ? 600 * (event.previous / event.difficulty)
    : null;
  const avgBlockText = avgBlockSec !== null
    ? `${Math.floor(avgBlockSec / 60)}m ${Math.round(avgBlockSec % 60)}s`
    : '-';

  // #229: network hashrate from difficulty. `difficulty × 2^32 / 600`
  // gives H/s. Bitcoin's network is in the high-hundreds-of-EH range
  // at retarget time so always render EH/s with one decimal.
  const hashrateEHs = event.difficulty * 2 ** 32 / 600 / 1e18;
  const hashrateText = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(hashrateEHs);

  const heightText = event.block_height !== null && event.block_height !== undefined
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(event.block_height)
    : null;

  // #229: pool blocks Ocean found in the prior epoch. Hidden when
  // null (no nearby pool block available to derive the epoch range)
  // or when the count is zero (Ocean had a no-luck epoch - surface
  // it as a gap rather than misleadingly imply we know the count
  // is exactly zero; in practice this is near-impossible).
  const poolBlocksText = event.pool_blocks_prior_epoch !== null
      && event.pool_blocks_prior_epoch !== undefined
      && event.pool_blocks_prior_epoch > 0
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(event.pool_blocks_prior_epoch)
    : null;

  return (
    <div
      ref={ref}
      id={pinned ? 'hashrate-chart-pinned-retarget-tooltip' : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-violet-300">
          <Trans>DIFFICULTY ADJUSTMENT</Trans>
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
        {fmt.timestamp(event.tick_at)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(event.tick_at)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(event.tick_at)}</div>

      <div className="mt-2 space-y-0.5 text-slate-300">
        <div className="flex justify-between gap-3">
          <span className="text-slate-500"><Trans>new difficulty</Trans></span>
          <span className="font-mono tabular-nums">{diffT} T</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-500"><Trans>previous</Trans></span>
          <span className="font-mono tabular-nums text-slate-400">{prevT} T</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-500"><Trans>change</Trans></span>
          <span className={`font-mono tabular-nums ${pctColor}`}>{pctText}</span>
        </div>
        {/* #229: enrichment fields below the existing three. All
            derived from the event payload + the pool_blocks lookup;
            no new daemon plumbing. */}
        {heightText !== null && (
          <div className="flex justify-between gap-3">
            <span className="text-slate-500"><Trans>block height</Trans></span>
            <span className="font-mono tabular-nums">{heightText}</span>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <span className="text-slate-500"><Trans>avg block time</Trans></span>
          <span className="font-mono tabular-nums">{avgBlockText}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-500"><Trans>network hashrate</Trans></span>
          <span className="font-mono tabular-nums">≈ {hashrateText} EH/s</span>
        </div>
        {poolBlocksText !== null && (
          <div className="flex justify-between gap-3">
            <span className="text-slate-500"><Trans>pool blocks this epoch</Trans></span>
            <span className="font-mono tabular-nums">{poolBlocksText}</span>
          </div>
        )}
      </div>

      {hasLuck && (
        <div className="mt-2 pt-2 border-t border-slate-800 space-y-0.5 text-slate-300">
          <div className="flex justify-between gap-3">
            <span className="text-slate-500"><Trans>luck after</Trans></span>
            <span className="font-mono tabular-nums">{fmtLuck(event.luckAfter!)}x</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500"><Trans>luck before</Trans></span>
            <span className="font-mono tabular-nums text-slate-400">{fmtLuck(event.luckBefore!)}x</span>
          </div>
        </div>
      )}
    </div>
  );
}

function BtcRow({
  label,
  btc,
  locale,
  muted = false,
}: {
  label: string;
  btc: number;
  locale: string | undefined;
  muted?: boolean;
}) {
  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(btc);
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono tabular-nums ${muted ? 'text-slate-400' : ''}`}>
        <span className="text-slate-500 mr-1">₿</span>
        {text}
      </span>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-slate-400 whitespace-nowrap">
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

function RangePicker({
  current,
  onChange,
}: {
  current: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
  const { i18n } = useLingui();
  return (
    <div className="flex gap-0.5 bg-slate-950/70 border border-slate-800 rounded-md p-0.5 pl-2 items-center">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 pr-1"><Trans>range</Trans></span>
      {CHART_RANGES.map((r) => {
        const active = r === current;
        return (
          <button
            key={r}
            onClick={() => onChange(r)}
            className={
              'px-2 py-1 text-[11px] rounded transition font-mono ' +
              (active
                ? 'bg-amber-400 text-slate-900 font-medium'
                : 'text-slate-300 hover:bg-slate-800')
            }
          >
            {localizedRangeLabel(r, i18n.locale)}
          </button>
        );
      })}
    </div>
  );
}

// #128: pool-luck step marker types + tooltip.
//
// Each pool block produces two step events on the pool-luck line:
//   - 'in':  numerator +1 the moment the block lands (line jumps up)
//   - 'out': numerator -1 when the block ages out of the rolling
//            window (line steps down, `windowMs` later)

interface PoolLuckStepEvent {
  readonly kind: 'in' | 'out';
  /** Timestamp of the step. For 'in' = block.timestamp_ms; for 'out' = block.timestamp_ms + windowMs. */
  readonly t: number;
  readonly block: OurBlockMarker;
  /** Pool-luck value at the tick immediately before the step. Null if the chart's tick history starts after the step. */
  readonly luckBefore: number | null;
  /** Pool-luck value at the first tick at-or-after the step. */
  readonly luckAfter: number;
  /** Window the active right-axis is using (24h, 7d, or 30d), in ms. */
  readonly windowMs: number;
}

interface PoolLuckStepTooltipState {
  readonly event: PoolLuckStepEvent;
  readonly x: number;
  readonly y: number;
  readonly pinned: boolean;
}

function PoolLuckStepTooltip({
  tip,
  explorerTemplate,
  locale,
  onClose,
}: {
  tip: PoolLuckStepTooltipState;
  explorerTemplate: string;
  locale: string | undefined;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const { event, pinned } = tip;
  const { kind, block, luckBefore, luckAfter, windowMs } = event;
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
    const margin = 8;
    let left = tip.x + 12;
    let top = tip.y + 12;
    if (left + rect.width > window.innerWidth - margin) left = tip.x - rect.width - 12;
    if (top + rect.height > window.innerHeight - margin) top = tip.y - rect.height - 12;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, event.kind, block.height]);

  const url = applyExplorerTemplate(explorerTemplate, block);
  const rewardBtc = block.total_reward_sat / 1e8;
  const DAY = 24 * 60 * 60 * 1000;
  const windowLabel = windowMs <= DAY ? '24h' : windowMs <= 7 * DAY ? '7d' : '30d';
  const headerLabel =
    kind === 'in' ? t`POOL LUCK +` : t`POOL LUCK -`;
  // #223: the previous copy said "numerator went from X× to Y×" which
  // misframed the value - the numerator of the luck formula is the
  // block count over the rolling window (an integer, N → N±1), not
  // the luck multiplier itself. The values shown are the luck before
  // and after the step. Rewording to talk about pool luck directly.
  const directionText =
    kind === 'in'
      ? t`Block landed - pool luck went from ${
          luckBefore === null ? '-' : `${luckBefore.toFixed(2)}×`
        } to ${luckAfter.toFixed(2)}× (rolling-${windowLabel} window).`
      : t`Block aged out of the rolling-${windowLabel} window - pool luck went from ${
          luckBefore === null ? '-' : `${luckBefore.toFixed(2)}×`
        } to ${luckAfter.toFixed(2)}×.`;

  return (
    <div
      ref={ref}
      id={pinned ? 'hashrate-chart-pinned-luckstep-tooltip' : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-violet-300">
          {headerLabel} #{block.height.toLocaleString(locale)}
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
      <div className="text-slate-300 mt-1 whitespace-normal max-w-xs">
        {directionText}
      </div>
      <div className="text-slate-500 mt-2 text-[11px]">
        <Trans>block found:</Trans> {fmt.timestamp(block.timestamp_ms)}
      </div>
      <div className="text-slate-500 text-[10px]">
        {formatTimestampUtc(block.timestamp_ms)}
      </div>
      {kind === 'out' && (
        <div className="text-slate-500 mt-1 text-[11px]">
          <Trans>aged out:</Trans>{' '}
          {fmt.timestamp(block.timestamp_ms + windowMs)}
        </div>
      )}
      <div className="mt-2 space-y-0.5 text-slate-300">
        <BtcRow label={t`pool reward`} btc={rewardBtc} locale={locale} />
      </div>
      {block.signals_bip110 === true && (
        <div className="mt-2 pt-2 border-t border-slate-800 text-amber-300 text-[11px]">
          <Trans>Signaling BIP 110</Trans>
        </div>
      )}
      {block.found_by_us && (
        <div className="mt-2 pt-2 border-t border-slate-800 text-amber-300 text-[11px]">
          <Trans>Found by us</Trans>
        </div>
      )}
      {pinned && (
        <div className="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="text-[10px] text-slate-500">
            <Trans>click outside to close</Trans>
          </span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:underline text-[11px]"
            >
              <Trans>open in explorer</Trans>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
