/**
 * #266: configurable StatsBar - operator-pickable tile slots.
 *
 * Replaces the build-611 hardcoded 6-tile grid. Each slot has a
 * dropdown over the catalogue declared in @hashrate-autopilot/shared.
 * Click anywhere on a tile's header row to open the picker; the
 * picker is the *single* customisation surface (replace / remove /
 * add another tile - all from the same dropdown). No separate
 * "rearrange mode" gate for tiles, because the operator's design-
 * interview pick was "same flow whether you're in rearrange mode or
 * not" - matching the cleanest path the question listed.
 *
 * Choice persists to `config.dashboard_tiles` (daemon-side, follows
 * the operator across browsers and devices).
 *
 * Pointer-events note: the picker controls (header button + + add)
 * carry `pointer-events-auto` because the parent SortableDashboard
 * applies `pointer-events-none` to block content while the operator
 * is in rearrange mode (#244, intentional - stops a stray tap from
 * firing a button mid-drag). For tiles we WANT that tap to fire,
 * because the only way to customise the layout *is* a tap. The
 * override is local to the picker controls; the rest of the tile
 * content stays inert during rearrange so the chart-pan-during-drag
 * problem #244 was protecting against doesn't regress.
 *
 * Data sources are the queries Status already runs (statsQuery,
 * statusQuery, oceanQuery). Tiles whose data isn't loaded yet (or
 * isn't enabled on this install) render an em-dash; they're still
 * pickable so the operator can lay out their dashboard before the
 * underlying integration is configured.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMemo, useRef, useState, useEffect } from 'react';

import {
  DEFAULT_DASHBOARD_TILES,
  MAX_DASHBOARD_TILES,
  TILE_CATALOGUE,
  type DashboardTileId,
} from '@hashrate-autopilot/shared';

import { useDenomination } from '../lib/denomination';
import { useLocale } from '../lib/locale';
import { formatNumber } from '../lib/format';
import { SatSymbol } from './SatSymbol';
import type { StatsResponse, StatusResponse, OceanResponse } from '../lib/api';

export interface TilesBarProps {
  readonly tileIds: ReadonlyArray<DashboardTileId>;
  readonly statsData: StatsResponse | undefined;
  readonly statusData: StatusResponse | undefined;
  readonly oceanData: OceanResponse | undefined;
  /**
   * Called when the operator adds, removes, or swaps a tile. The new
   * full list (in render order) is passed; caller persists to
   * `config.dashboard_tiles`.
   */
  readonly onTilesChange: (next: DashboardTileId[]) => void;
}

interface TileResult {
  readonly value: string;
  readonly tooltip?: string;
  readonly color?: string;
}

interface TileCtx {
  readonly stats: StatsResponse | undefined;
  readonly status: StatusResponse | undefined;
  readonly ocean: OceanResponse | undefined;
  readonly intlLocale: string;
  readonly denomination: ReturnType<typeof useDenomination>;
}

const EM_DASH = '—';
const DASH: TileResult = { value: EM_DASH };

function fmtPct(v: number | null | undefined, digits = 1, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits }, intlLocale)}%`;
}

function fmtX(v: number | null | undefined, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, intlLocale)}×`;
}

const TILE_RENDERERS: Record<DashboardTileId, (ctx: TileCtx) => TileResult> = {
  uptime: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_pct ?? null, 1, intlLocale),
    tooltip: t`Duration-weighted % of time with delivered hashrate > 0, computed over the selected chart range. Each tick is weighted by its actual duration so gaps after restarts count proportionally. Updates with the range selector.`,
    color:
      stats?.uptime_pct == null
        ? 'text-slate-400'
        : stats.uptime_pct >= 90
          ? 'text-emerald-300'
          : stats.uptime_pct >= 50
            ? 'text-amber-300'
            : 'text-red-300',
  }),
  avg_braiins: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Braiins reports delivering over the selected range. Includes downtime in the denominator so a bad stretch shows up here, not just on the live card.`,
  }),
  avg_datum: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_datum_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Datum measures at the gateway over the selected range. A sustained gap below Avg Braiins means Braiins is billing for hashrate Datum never saw arrive.`,
  }),
  avg_ocean: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_ocean_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Ocean credits to our payout address over the selected range. A sustained gap below Avg Braiins / Avg Datum means the pool isn't crediting work we think we delivered.`,
  }),
  avg_cost_delivered: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_cost_per_ph_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_cost_per_ph_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average effective rate over the selected range - what Braiins actually charged per PH/day delivered. Spend-weighted; zero-delivery periods contribute zero to both sides.`,
  }),
  avg_cost_vs_hashprice: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_overpay_vs_hashprice_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_overpay_vs_hashprice_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`(avg cost delivered) minus the spend-weighted average hashprice during periods we were actually billed, computed over the selected range. Negative = paid below break-even.`,
    color:
      stats?.avg_overpay_vs_hashprice_sat_per_ph_day == null
        ? 'text-slate-100'
        : stats.avg_overpay_vs_hashprice_sat_per_ph_day < 0
          ? 'text-emerald-300'
          : stats.avg_overpay_vs_hashprice_sat_per_ph_day > 0
            ? 'text-red-300'
            : 'text-slate-100',
  }),
  uptime_bid_coverage: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_bid_coverage_pct ?? null, 1, intlLocale),
    tooltip: t`% of the window with an active Braiins bid. Low = orderbook didn't cooperate ("expected" downtime - nothing matched your criteria), not a failure on your side.`,
  }),
  uptime_delivery_when_bid_active: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_delivery_when_bid_active_pct ?? null, 1, intlLocale),
    tooltip: t`% of the bid-active time that actually delivered hashrate. Low = hardware / connection / Datum-side failure while a bid was up ("unexpected" downtime).`,
  }),
  hashrate_target: ({ status, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(
      status?.config_summary?.effective_target_hashrate_ph ?? null,
      intlLocale,
    ),
    tooltip: t`Live effective hashrate target. Steps to cheap_target_hashrate_ph when cheap-mode engages, back to target_hashrate_ph when it disengages.`,
  }),
  avg_overpay_intent: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_intent_overpay_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_intent_overpay_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average overpay above the fillable ask the controller chose to set as the bid. Measures how aggressive the autopilot was being, separate from how much was actually billed.`,
  }),
  avg_overpay_settled: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_settled_overpay_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_settled_overpay_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average overpay above the fillable ask on the bid price the controller actually had live (post-edit-deadband). Measures what the operator paid for, separate from what the controller intended.`,
  }),
  hashprice_now: ({ ocean, intlLocale, denomination }) => ({
    value:
      ocean?.user?.hashprice_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(ocean.user.hashprice_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Current Ocean hashprice (sat per PH per day at the pool's most recent rolling window). The break-even reference the controller bids against.`,
  }),
  pool_blocks_30d: ({ ocean, intlLocale }) => ({
    value: ocean?.blocks_30d != null ? formatNumber(ocean.blocks_30d, {}, intlLocale) : EM_DASH,
    tooltip: t`Ocean blocks found in the past 30 days. Used by the pool-luck calculation as the numerator.`,
  }),
  pool_luck_24h: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_24h ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 24 h: actual blocks found ÷ statistically expected blocks at the pool's hashrate. >1 = lucky, <1 = unlucky.`,
  }),
  pool_luck_7d: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_7d ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 7 days. Same formula as 24 h, longer window.`,
  }),
  pool_luck_30d: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_30d ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 30 days. Longest-window luck reading.`,
  }),
  share_log_pct: ({ ocean, intlLocale }) => ({
    value: fmtPct(ocean?.user?.share_log_pct ?? null, 4, intlLocale),
    tooltip: t`Your share of Ocean's reward window. Approximately your hashrate ÷ pool hashrate; drives the unpaid-earnings line on the price chart.`,
  }),
  share_rejection_pct: () => ({
    value: EM_DASH,
    tooltip: t`Share-rejection rate. Tile data source pending - currently shown only on the chart's right axis. Will populate in a follow-up.`,
  }),
  wallet_runway_days: ({ status, intlLocale }) => {
    const balance = status?.balances?.[0]?.total_balance_sat ?? null;
    const dailySpend = status?.actual_spend_per_day_sat_3h ?? null;
    if (balance === null || dailySpend === null || dailySpend <= 0) return DASH;
    const days = balance / dailySpend;
    const text =
      days >= 10
        ? formatNumber(Math.round(days), {}, intlLocale)
        : formatNumber(days, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, intlLocale);
    return {
      value: `${text} d`,
      tooltip: t`Days of Braiins wallet runway at the current 3 h average spend rate. = total balance ÷ daily spend. Doesn't account for upcoming deposits.`,
      color:
        days >= 14 ? 'text-emerald-300' : days >= 7 ? 'text-amber-300' : 'text-red-300',
    };
  },
  bitaxe_fleet_hashrate: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet hashrate. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_power: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet power draw. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_efficiency_j_per_th: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet efficiency in J/TH. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
};

function labelFor(id: DashboardTileId): string {
  switch (id) {
    case 'uptime': return t`uptime`;
    case 'avg_braiins': return t`avg braiins`;
    case 'avg_datum': return t`avg datum`;
    case 'avg_ocean': return t`avg ocean`;
    case 'avg_cost_delivered': return t`avg cost delivered`;
    case 'avg_cost_vs_hashprice': return t`avg cost vs hashprice`;
    case 'uptime_bid_coverage': return t`bid coverage`;
    case 'uptime_delivery_when_bid_active': return t`delivery rate (while bidding)`;
    case 'hashrate_target': return t`hashrate target`;
    case 'avg_overpay_intent': return t`avg overpay (intent)`;
    case 'avg_overpay_settled': return t`avg overpay (settled)`;
    case 'hashprice_now': return t`hashprice now`;
    case 'pool_blocks_30d': return t`pool blocks 30d`;
    case 'pool_luck_24h': return t`pool luck 24h`;
    case 'pool_luck_7d': return t`pool luck 7d`;
    case 'pool_luck_30d': return t`pool luck 30d`;
    case 'share_log_pct': return t`share log %`;
    case 'share_rejection_pct': return t`share rejection`;
    case 'wallet_runway_days': return t`wallet runway`;
    case 'bitaxe_fleet_hashrate': return t`Bitaxe hashrate`;
    case 'bitaxe_fleet_power': return t`Bitaxe power`;
    case 'bitaxe_fleet_efficiency_j_per_th': return t`Bitaxe efficiency`;
  }
}

/**
 * Split a formatted value like "46,362 sat/PH/day" or "718 sat/PH/day"
 * into a big-number half and a small-caption unit half, so the tile
 * matches the original StatCard idiom: large mono number above, slim
 * grey unit below. The original implementation lives in Status.tsx;
 * duplicated here to avoid coupling the TilesBar to a private helper.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  const spaced = v.match(
    /^(.+?)\s+((?:sat|₿)\/(?:TH|PH|EH)\/day|(?:TH|PH|EH)\/s|PH·h|sat|₿)(\s*(?:\(.*\))?)$/,
  );
  if (spaced?.[1] && spaced[2]) return { num: spaced[1], unit: spaced[2] + (spaced[3] ?? '') };
  const usdRate = v.match(/^(.+?)(\/(?:TH|PH|EH)\/day)$/);
  if (usdRate?.[1] && usdRate[2]) return { num: usdRate[1], unit: usdRate[2] };
  const pct = v.match(/^(.+?)(%)$/);
  if (pct?.[1] && pct[2]) return { num: pct[1], unit: pct[2] };
  const dSuffix = v.match(/^(.+?)\s+(d)$/);
  if (dSuffix?.[1] && dSuffix[2]) return { num: dSuffix[1], unit: dSuffix[2] };
  return null;
}

/** Render the unit half with the muted-grey "subtitle" look. */
function UnitCaption({ unit }: { unit: string }) {
  const { i18n } = useLingui();
  void i18n;
  const phDayLabel = t`/PH/day`;
  const localized = unit.replace('/PH/day', phDayLabel);
  if (localized === 'sat' || localized === '₿') {
    return (
      <span className="inline-block w-3 text-center">
        {localized === 'sat' ? <SatSymbol className="opacity-70" /> : localized}
      </span>
    );
  }
  if (localized === '%') {
    return <span className="inline-block w-3 text-center">{localized}</span>;
  }
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

export function TilesBar({
  tileIds,
  statsData,
  statusData,
  oceanData,
  onTilesChange,
}: TilesBarProps) {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  // Render the operator's saved tile list, or fall back to defaults
  // when they haven't customised. Empty array doesn't mean "no
  // tiles" - it means "use the defaults" (the dashboard's standing
  // look). The operator removes the last tile by clicking ×; if they
  // remove all of them the bar reverts to defaults on next render so
  // the page is never tile-less and unrecoverable.
  const effective = tileIds.length === 0 ? DEFAULT_DASHBOARD_TILES : tileIds;

  const ctx: TileCtx = {
    stats: statsData,
    status: statusData,
    ocean: oceanData,
    intlLocale: intlLocale ?? 'en-US',
    denomination,
  };

  const replaceAt = (idx: number, next: DashboardTileId) => {
    const arr = [...effective] as DashboardTileId[];
    arr[idx] = next;
    onTilesChange(arr);
  };
  const removeAt = (idx: number) => {
    const arr = [...effective] as DashboardTileId[];
    arr.splice(idx, 1);
    onTilesChange(arr);
  };
  const addTile = (id: DashboardTileId) => {
    onTilesChange([...effective, id] as DashboardTileId[]);
  };

  return (
    // Auto-fitting grid: each tile gets `minmax(160px, 1fr)` so the
    // row reflows naturally as the viewport widens. Above ~7 columns
    // (≈1200px content area) tiles stop stretching and start adding
    // new columns; on a wide 4K screen the bar happily reaches 10+
    // columns instead of being capped at the legacy 6-up layout.
    // `pointer-events-auto` re-enables clicks inside the section even
    // when the parent SortableDashboard is in rearrange-inert mode.
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))] pointer-events-auto">
      {effective.map((id, idx) => (
        <TileSlot
          key={`${id}-${idx}`}
          id={id}
          inUse={effective}
          result={(TILE_RENDERERS[id] ?? (() => DASH))(ctx)}
          onReplace={(next) => replaceAt(idx, next)}
          onRemove={effective.length > 1 ? () => removeAt(idx) : undefined}
        />
      ))}
      {/*
        #266 follow-up: the always-visible "+ add" tile ate a whole
        row's worth of vertical space whenever the operator was on a
        non-multiple-of-6 count. Replaced by a small `+` icon button
        anchored to the SECTION (top-right), only visible on hover or
        focus of the section. Discoverable but not occupying a slot.
      */}
      {effective.length < MAX_DASHBOARD_TILES && (
        <InlineAddButton excluded={effective} onAdd={addTile} />
      )}
    </section>
  );
}

/**
 * #266 follow-up: replaces the dashed "+ add" tile from build 614.
 * Renders as an absolutely-positioned `+` button at the section's
 * top-right corner so it doesn't consume a tile slot. Visible only
 * on hover / focus to avoid permanent chrome; on touch screens
 * stays visible because hover doesn't fire.
 */
function InlineAddButton({
  excluded,
  onAdd,
}: {
  excluded: ReadonlyArray<DashboardTileId>;
  onAdd: (id: DashboardTileId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div
      ref={ref}
      // Tiny "ghost tile" at the end of the row that the auto-fit
      // grid sees as one more column, but renders as a 1-rem-wide
      // strip with just the + button. When the picker opens it
      // expands to fit the dropdown. Border-dashed kept for a
      // subtle "you can add more" hint without dominating the row.
      className="relative pointer-events-auto flex items-center justify-center min-h-[6rem] rounded-lg border border-dashed border-slate-800/50 hover:border-amber-500/30 transition"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-slate-600 hover:text-amber-300 text-base leading-none px-2 py-1 rounded"
        title={t`Add a tile`}
        aria-label={t`Add a tile`}
      >
        +
      </button>
      {open && (
        <div className="absolute z-30 left-0 top-full mt-1">
          <TilePickerDropdown
            inUse={excluded}
            onPick={(id) => {
              onAdd(id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface TileSlotProps {
  readonly id: DashboardTileId;
  readonly inUse: ReadonlyArray<DashboardTileId>;
  readonly result: TileResult;
  readonly onReplace: (id: DashboardTileId) => void;
  readonly onRemove: (() => void) | undefined;
}

function TileSlot({ id, inUse, result, onReplace, onRemove }: TileSlotProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const split = splitUnit(result.value);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div
      ref={ref}
      // `pointer-events-auto` override: when the parent SortableDashboard
      // wraps the indicators block in pointer-events-none (rearrange
      // mode, #244), we still want tile clicks to register because
      // those clicks ARE the customisation flow.
      className="relative pointer-events-auto"
    >
      <button
        type="button"
        title={result.tooltip}
        onClick={() => setOpen((v) => !v)}
        className="block w-full text-left bg-slate-900 border border-slate-800 rounded-lg p-4 cursor-pointer hover:border-slate-700"
      >
        {/* Two-line label header for cross-card baseline alignment. */}
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2 min-h-8 leading-4 flex items-start justify-center gap-1">
          <span className="truncate">{labelFor(id)}</span>
          <span className="text-slate-500 text-[10px] leading-none mt-0.5">▾</span>
        </div>
        <div
          className={`text-2xl font-mono tabular-nums text-center ${result.color ?? 'text-slate-100'}`}
        >
          {split ? split.num : result.value}
        </div>
        {split && (
          <div className="text-xs text-slate-500 mt-0.5 text-center">
            <UnitCaption unit={split.unit} />
          </div>
        )}
      </button>
      {open && (
        <TilePickerDropdown
          currentId={id}
          inUse={inUse}
          onPick={(next) => {
            onReplace(next);
            setOpen(false);
          }}
          onRemove={
            onRemove
              ? () => {
                  onRemove();
                  setOpen(false);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

interface PickerProps {
  readonly currentId?: DashboardTileId;
  readonly inUse: ReadonlyArray<DashboardTileId>;
  readonly onPick: (id: DashboardTileId) => void;
  readonly onRemove?: () => void;
}

function TilePickerDropdown({ currentId, inUse, onPick, onRemove }: PickerProps) {
  const inUseSet = useMemo(() => new Set(inUse), [inUse]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof TILE_CATALOGUE[number][]>();
    for (const meta of TILE_CATALOGUE) {
      const arr = m.get(meta.group) ?? [];
      arr.push(meta);
      m.set(meta.group, arr);
    }
    return [...m.entries()];
  }, []);

  return (
    <div className="absolute z-30 left-0 top-full mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 text-xs pointer-events-auto">
      {grouped.map(([group, items]) => (
        <div key={group} className="mb-2 last:mb-0">
          <div className="text-[9px] uppercase tracking-wider text-slate-500 px-1 mb-1">
            {group}
          </div>
          <ul className="space-y-px">
            {items.map((meta) => {
              const isCurrent = meta.id === currentId;
              const isElsewhere = !isCurrent && inUseSet.has(meta.id);
              return (
                <li key={meta.id}>
                  <button
                    type="button"
                    onClick={() => onPick(meta.id)}
                    className={`w-full text-left px-2 py-0.5 rounded hover:bg-slate-800 ${
                      isCurrent ? 'text-amber-300 font-medium' : 'text-slate-300'
                    }`}
                  >
                    {labelFor(meta.id)}
                    {isCurrent && (
                      <span className="ml-1 text-[9px] text-slate-500">
                        <Trans>(current)</Trans>
                      </span>
                    )}
                    {isElsewhere && (
                      <span className="ml-1 text-[9px] text-slate-600">
                        <Trans>(in another tile)</Trans>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {onRemove && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          <button
            type="button"
            onClick={onRemove}
            className="w-full text-left px-2 py-0.5 rounded text-red-400 hover:bg-red-900/20"
          >
            <Trans>Remove this tile</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

