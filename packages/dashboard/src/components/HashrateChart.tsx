/**
 * Hashrate-only chart: Braiins-delivered hashrate as a filled area,
 * Datum-measured hashrate as a second line when the Datum integration
 * is active, and target + floor as dashed reference lines. The two
 * series let the operator eyeball the gap between what Braiins bills
 * for and what Datum actually sees arrive at the gateway. Pairs with
 * `PriceChart` rendered immediately below it so price moves can be
 * matched against fill events visually — both charts share the same
 * time-range filter and X-axis layout.
 */

import { Trans, t } from '@lingui/macro';
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
} from '@braiins-hashrate/shared';

import type { MetricPoint, OurBlockMarker } from '../lib/api';
import { formatAgeMinutes, formatNumber, formatTimestamp, formatTimestampUtc } from '../lib/format';
import { useLocale } from '../lib/locale';
import { applyExplorerTemplate } from '../lib/blockExplorer';

const WIDTH = 880;
const HEIGHT = 200;
// Padding kept identical to PriceChart so the two charts can be stacked
// and the X-axis lines up tick-for-tick. Right padding is small now that
// the price-side Y-axis moved to the left — just enough to keep the
// rightmost timestamp from clipping the edge.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };

// Tailwind amber-500 — the deeper "our bid" amber on the PriceChart.
// Previously #fbbf24 (amber-400); nudged a shade darker at the
// operator's eyecheck so the Braiins-delivered line reads as a
// saturated amber/orange rather than pale yellow. The PriceChart
// "our bid" line shares this constant.
const COLOR_DELIVERED = '#f59e0b';
// Green — measured locally at the DATUM gateway.
const COLOR_DATUM = '#34d399';
// Same saturated blue as the TIDES-credited block cubes on this
// chart — reinforces the "Ocean → blue" association and contrasts
// harder against the green Datum line than cyan did.
const COLOR_OCEAN = '#3b82f6';
const COLOR_TARGET = '#94a3b8';
const COLOR_FLOOR = '#64748b';
// Gold for the rare "we found this block ourselves" case
// (found_by_us === true). Reads as "jackpot" against the dark
// background.
const COLOR_OUR_BLOCK = '#fbbf24';
// Same hue as COLOR_OCEAN by design — TIDES-credited block cubes
// and the Ocean hashrate line share the Ocean-is-blue association.
const COLOR_POOL_BLOCK = '#3b82f6';

/**
 * Rolling-mean smoother over a time window. For each point at time
 * `xs[i]`, computes the mean of all non-null values whose timestamp
 * falls in `[xs[i] - windowMs, xs[i]]`. Null input values are
 * skipped; a window with no non-null samples yields null (keeps
 * null-gap rendering intact). Window ≤ 0 or 1 minute returns the
 * input unchanged — 1 is the "off" sentinel from the config.
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

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

interface BlockTooltipState {
  block: OurBlockMarker;
  x: number;
  y: number;
  pinned: boolean;
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
   *  series; 1 = raw. Ocean is not smoothed here — /user_hashrate
   *  already returns a server-side 5-min average. */
  braiinsSmoothingMinutes?: number;
  datumSmoothingMinutes?: number;
}) {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const [blockTip, setBlockTip] = useState<BlockTooltipState | null>(null);

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

  const chartData = useMemo(() => {
    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    // Counter-derived Braiins delivered (#52). Braiins' own
    // `delivered_ph` is a lagged rolling average that holds elevated
    // for minutes after shares actually stop flowing — during
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
        return ((c1 - c0) * 86_400_000) / (bid * dt);
      }
      return p.delivered_ph;
    });
    const targets = points.map((p) => p.target_ph);
    const floors = points.map((p) => p.floor_ph);
    const rawDatumYs = points.map((p) => p.datum_hashrate_ph);
    const hasDatum = rawDatumYs.some((v) => v !== null);
    const oceanYs = points.map((p) => p.ocean_hashrate_ph);
    // Apply operator-configured rolling-mean smoothing to the raw
    // per-tick signals. Ocean is left alone — /user_hashrate is
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

    const minX = xs[0]!;
    const maxX = xs[xs.length - 1]!;

    const yMaxData = Math.max(...ys, ...targets, ...floors, datumMax, oceanMax);

    const yTicks = niceYTicks(0, yMaxData > 0 ? yMaxData * 1.1 : 1, 5);
    const yMin = yTicks[0] ?? 0;
    const yMax = yTicks[yTicks.length - 1] ?? 1;

    const xScale = (x: number): number => {
      const usable = WIDTH - PADDING.left - PADDING.right;
      if (maxX === minX) return PADDING.left + usable / 2;
      return PADDING.left + ((x - minX) / (maxX - minX)) * usable;
    };
    const yScale = (y: number): number => {
      const usable = HEIGHT - PADDING.top - PADDING.bottom;
      return HEIGHT - PADDING.bottom - ((y - yMin) / (yMax - yMin)) * usable;
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
    };
  }, [points, braiinsSmoothingMinutes, datumSmoothingMinutes]);

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

  const { minX, maxX, xScale, yScale, deliveredPath, datumPath, hasDatum, oceanPath, hasOcean, targetPath, floorPath, yTicks, xTickInterval, xTicks } = chartData;

  return (
    <div className="bg-slate-900 border rounded-lg p-4 border-slate-800">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">
          <Trans>Hashrate</Trans>
        </h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <Legend color={COLOR_DELIVERED} label={t`delivered (Braiins)`} />
          {hasDatum && (
            <Legend color={COLOR_DATUM} label={t`received (Datum)`} />
          )}
          {hasOcean && (
            <Legend color={COLOR_OCEAN} label={t`received (Ocean)`} />
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
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
      >
        {yTicks.map((v, i) => (
          <g key={`y-${i}`}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
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
              {formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, intlLocale)}
            </text>
          </g>
        ))}

        <path d={targetPath} stroke={COLOR_TARGET} strokeWidth="1.2" strokeDasharray="4 3" fill="none" opacity="0.6" />
        <path d={floorPath} stroke={COLOR_FLOOR} strokeWidth="1" strokeDasharray="2 3" fill="none" opacity="0.5" />

        <path
          d={`${deliveredPath} L${xScale(maxX).toFixed(1)},${yScale(0)} L${xScale(minX).toFixed(1)},${yScale(0)} Z`}
          fill="url(#deliveredFill)"
          opacity="0.5"
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

        {ourBlocks
            .filter((b) => b.timestamp_ms >= minX && b.timestamp_ms <= maxX)
            .map((b) => {
              const x = xScale(b.timestamp_ms);
              const color = b.found_by_us ? COLOR_OUR_BLOCK : COLOR_POOL_BLOCK;
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
                    y2={HEIGHT - PADDING.bottom}
                    stroke={color}
                    strokeWidth={b.found_by_us ? '1.8' : '1'}
                    strokeDasharray={b.found_by_us ? '4 2' : '2 3'}
                    opacity={b.found_by_us ? '0.95' : '0.55'}
                  />
                  {/* Transparent wide hit-target so hover/click on the
                      thin dashed line is forgiving. */}
                  <rect
                    x={x - 6}
                    y={PADDING.top - 9}
                    width={12}
                    height={HEIGHT - PADDING.bottom - PADDING.top + 9}
                    fill="transparent"
                  />
                  {/* Small isometric cube, matching Ocean's block icon.
                      Three rhombus faces — top, front, right — stroked
                      in the marker colour. Centered on the line. */}
                  <g
                    transform={`translate(${x - 5}, ${PADDING.top - 9})`}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                  >
                    <path d="M5 0 L10 2.5 L5 5 L0 2.5 Z" fill={color} fillOpacity="0.25" />
                    <path d="M0 2.5 L0 7.5 L5 10 L5 5 Z" fill={color} fillOpacity="0.15" />
                    <path d="M5 5 L5 10 L10 7.5 L10 2.5 Z" fill={color} fillOpacity="0.35" />
                  </g>
                </g>
              );
            })}

        <defs>
          <linearGradient id="deliveredFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_DELIVERED} stopOpacity="0.45" />
            <stop offset="100%" stopColor={COLOR_DELIVERED} stopOpacity="0" />
          </linearGradient>
        </defs>

        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={HEIGHT - PADDING.bottom}
          y2={HEIGHT - PADDING.bottom}
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
                y1={HEIGHT - PADDING.bottom}
                y2={HEIGHT - PADDING.bottom + 3}
                stroke="#475569"
                strokeWidth="1"
              />
              <text
                x={x}
                y={HEIGHT - 8}
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

        <text
          x={14}
          y={PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2}
          textAnchor="middle"
          fontSize="10"
          fill="#64748b"
          fontFamily="monospace"
          transform={`rotate(-90 14 ${PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2})`}
        >
          PH/s
        </text>
      </svg>
      {blockTip && (
        <BlockTooltip
          tip={blockTip}
          explorerTemplate={blockExplorerTemplate}
          locale={intlLocale}
          shareLogPct={shareLogPct}
          onClose={closeBlockTip}
        />
      )}
    </div>
  );
});

function BlockTooltip({
  tip,
  explorerTemplate,
  locale,
  shareLogPct,
  onClose,
}: {
  tip: BlockTooltipState;
  explorerTemplate: string;
  locale: string | undefined;
  shareLogPct: number | null;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
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
  const headerColor = block.found_by_us ? 'text-amber-300' : 'text-sky-300';
  const kindLabel = block.found_by_us ? t`FOUND BY US` : t`POOL BLOCK`;

  return (
    <div
      ref={ref}
      id={pinned ? 'hashrate-chart-pinned-tooltip' : undefined}
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
        {formatTimestamp(block.timestamp_ms, locale)}
        <span className="text-slate-500 ml-2">· {formatAgeMinutes(block.timestamp_ms)}</span>
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(block.timestamp_ms)}</div>

      <div className="mt-2 space-y-0.5 text-slate-300">
        <BtcRow label={t`pool reward`} btc={rewardBtc} locale={locale} />
        <BtcRow label={t`subsidy`} btc={subsidyBtc} locale={locale} muted />
        <BtcRow label={t`fees`} btc={feesBtc} locale={locale} muted />
      </div>

      {shareLogPct !== null && shareLogPct > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-800 space-y-0.5 text-slate-300">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
            <Trans>our share (est.)</Trans>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500"><Trans>share log</Trans></span>
            <span className="font-mono tabular-nums">{shareLogPct.toFixed(4)}%</span>
          </div>
          <BtcRow
            label={t`our earnings`}
            btc={(rewardBtc * shareLogPct) / 100}
            locale={locale}
          />
          <div className="text-[10px] text-slate-500 italic mt-0.5 whitespace-normal max-w-[18rem]">
            <Trans>
              uses current share_log — an approximation for older blocks,
              since share_log drifts as pool hashrate moves.
            </Trans>
          </div>
        </div>
      )}

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

function RangePicker({
  current,
  onChange,
}: {
  current: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
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
            {CHART_RANGE_SPECS[r].label}
          </button>
        );
      })}
    </div>
  );
}
