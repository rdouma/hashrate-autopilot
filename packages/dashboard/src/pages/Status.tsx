import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@braiins-hashrate/shared';

import { HashrateChart } from '../components/HashrateChart';
import { PriceChart } from '../components/PriceChart';
import { ModeBadge } from '../components/ModeBadge';
import { SatSymbol } from '../components/SatSymbol';
import { Tooltip } from '../components/Tooltip';
import {
  api,
  UnauthorizedError,
  type BalanceView,
  type BidView,
  type FinanceResponse,
  type FinanceRangeResponse,
  type NextActionView,
  type OceanResponse,
  type ProposalView,
  type StatsResponse,
  type TickNowResponse,
  type StatusResponse,
} from '../lib/api';
import {
  formatAge,
  formatAgePrecise,
  formatCountdownPrecise,
  formatHashratePH,
  formatNumber,
  formatSatPerPH,
  formatSats,
  formatTimestamp,
  formatTimestampUtc,
} from '../lib/format';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { useDenomination } from '../lib/denomination';
import { copyToClipboard } from '../lib/clipboard';
import { actionModeLabel, bidStatusClass, bidStatusLabel } from '../lib/labels';
import { useLocale } from '../lib/locale';
import { localizedRangeLabel } from '../lib/range-label';

const RUN_MODES = ['DRY_RUN', 'LIVE', 'PAUSED'] as const;
const CHART_RANGE_STORAGE_KEY = 'hashrate-chart-range';
const STATUS_QUERY_KEY = ['status'] as const;

function readStoredChartRange(): ChartRange {
  if (typeof window === 'undefined') return DEFAULT_CHART_RANGE;
  return parseChartRange(window.localStorage.getItem(CHART_RANGE_STORAGE_KEY)) ?? DEFAULT_CHART_RANGE;
}

export function Status() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const [chartRange, setChartRangeState] = useState<ChartRange>(() => readStoredChartRange());
  useEffect(() => {
    window.localStorage.setItem(CHART_RANGE_STORAGE_KEY, chartRange);
  }, [chartRange]);
  const setChartRange = (r: ChartRange) => setChartRangeState(r);

  const query = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    // Status is the headline data (price, delivered, next-action). 30s
    // is fast enough for an autopilot that ticks once per minute and
    // slow enough that the operator's tab isn't constantly thrashing.
    // Per-second timers (NextActionFooter, NextActionProgress) tick
    // client-side so they keep moving between polls.
    refetchInterval: 30_000,
  });

  const runModeMutation = useMutation({
    mutationFn: (run_mode: (typeof RUN_MODES)[number]) => api.setRunMode(run_mode),
    onMutate: async (newRunMode) => {
      await qc.cancelQueries({ queryKey: ['status'] });
      const previous = qc.getQueryData<StatusResponse>(['status']);
      if (previous) {
        qc.setQueryData<StatusResponse>(['status'], { ...previous, run_mode: newRunMode });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['status'], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const tickNowMutation = useMutation({
    mutationFn: () => api.tickNow(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const metricsQuery = useQuery({
    queryKey: ['metrics', chartRange],
    queryFn: () => api.metrics(chartRange),
    // Charts span hours-to-months — a 60s refresh is plenty.
    refetchInterval: 60_000,
  });

  const bidEventsQuery = useQuery({
    queryKey: ['bid-events', chartRange],
    queryFn: () => api.bidEvents(chartRange),
    refetchInterval: 60_000,
  });

  const statsQuery = useQuery({
    queryKey: ['stats', chartRange],
    queryFn: () => api.stats(chartRange),
    // Cached 60s server-side; poll every 60s client-side to match.
    refetchInterval: 60_000,
  });

  // Shared query instance for the Ocean panel AND the hashrate chart
  // marker overlay. React-query dedupes by queryKey so the Ocean card
  // and the chart use the same network call.
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 60_000,
  });

  const financeQuery = useQuery({
    queryKey: ['finance'],
    queryFn: api.finance,
    // Money is a slow-moving summary — earnings per day, lifetime
    // figures, ocean stats. Hourly refresh is plenty; the operator can
    // hit the refresh button on the panel for an immediate pull.
    refetchInterval: 3_600_000,
  });

  // Range-aware aggregates for the P&L per-day card (issue #43).
  // Separate query from /api/finance because the two have different
  // cadences — lifetime/Ocean data is hourly; range aggregates track
  // the ~1-min tick cadence. Keyed on `chartRange` so switching the
  // chart range picker above refetches with the new window.
  const financeRangeQuery = useQuery({
    queryKey: ['finance-range', chartRange],
    queryFn: () => api.financeRange(chartRange),
    refetchInterval: 60_000,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 60_000,
  });

  // Operator availability removed from the UI (API bids bypass 2FA;
  // see research.md §0.9). Backend field remains in case Braiins
  // changes policy. The endpoint still exists for future use.

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (query.isLoading) return <div className="text-slate-400"><Trans>loading…</Trans></div>;
  if (!query.data) {
    return <div className="text-red-400"><Trans>failed to load: {(query.error as Error)?.message}</Trans></div>;
  }

  const s: StatusResponse = query.data;

  return (
    <div className="space-y-5">
      {/* No "Status" h2 header — the top nav already announces the
          page, and last-tick info is duplicated in the
          NextActionCard's footer. Saved a chunk of vertical real
          estate above the fold. */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 h-full">
          <OperationsCard
            s={s}
            currentBidPH={primaryBidPricePH(s)}
            hashpricePH={financeQuery.data?.ocean?.hashprice_sat_per_ph_day ?? null}
            onRunMode={(m) => runModeMutation.mutate(m)}
            runModePending={runModeMutation.isPending}
          />
        </div>
        <div className="lg:col-span-3 h-full">
          <NextActionCard
            s={s}
            onTickNow={() => tickNowMutation.mutate()}
            tickPending={tickNowMutation.isPending}
            tickResult={tickNowMutation.data}
          />
        </div>
      </section>

      <FilterBar
        range={chartRange}
        onRangeChange={setChartRange}
      />

      <StatsBar statsData={statsQuery.data} />

      <HashrateChart
        points={metricsQuery.data?.points ?? []}
        range={chartRange}
        onRangeChange={setChartRange}
        ourBlocks={oceanQuery.data?.our_recent_blocks ?? []}
        blockExplorerTemplate={configQuery.data?.config?.block_explorer_url_template}
        shareLogPct={oceanQuery.data?.user?.share_log_pct ?? null}
        braiinsSmoothingMinutes={configQuery.data?.config?.braiins_hashrate_smoothing_minutes ?? 1}
        datumSmoothingMinutes={configQuery.data?.config?.datum_hashrate_smoothing_minutes ?? 1}
        showShareLogOverlay={configQuery.data?.config?.show_share_log_on_hashrate_chart ?? false}
      />
      <PriceChart
        points={metricsQuery.data?.points ?? []}
        events={bidEventsQuery.data?.events ?? []}
        showEvents={CHART_RANGE_SPECS[chartRange].showEvents}
        maxOverpayVsHashpriceSatPerPhDay={s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day}
        overpaySatPerPhDay={
          configQuery.data?.config?.overpay_sat_per_eh_day != null
            ? configQuery.data.config.overpay_sat_per_eh_day / EH_PER_PH
            : null
        }
        priceSmoothingMinutes={configQuery.data?.config?.braiins_price_smoothing_minutes ?? 1}
        showEffectiveRate={configQuery.data?.config?.show_effective_rate_on_price_chart ?? false}
      />

      {/*
       * Pipeline order: Braiins → Datum → Ocean (a share travels
       * Braiins-marketplace → Datum-gateway → Ocean-pool). Caps
       * live inside the Braiins card because they only describe
       * what we do in the marketplace. P&L sits below Bids as its
       * own full-width section; it's a financial summary of the
       * pipeline, not a pipeline step.
       */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card
          title="Braiins"
          nextRefreshAtMs={s.next_tick_at}
          refetchQueryKey={STATUS_QUERY_KEY}
          badges={
            <ReachabilityBadge
              label={t`API reachable`}
              reachable={s.market !== null}
              downLabel={t`API DOWN`}
              title={t`Braiins marketplace API — reachable when the last observe() read market/orderbook/balance without error.`}
            />
          }
        >
          <Row k={t`delivered`} v={formatHashratePH(s.actual_hashrate_ph)} />
          <Row
            k={t`target`}
            v={
              s.config_summary.cheap_mode_active
                ? `${formatHashratePH(s.config_summary.effective_target_hashrate_ph)} ${t`(cheap mode)`}`
                : formatHashratePH(s.config_summary.target_hashrate_ph)
            }
          />
          <Row k={t`floor`} v={formatHashratePH(s.config_summary.minimum_floor_hashrate_ph)} />
          {s.below_floor_since && (
            <div className="text-xs text-amber-400 mt-1">
              <Trans>below floor since {formatAge(s.below_floor_since)}</Trans>
            </div>
          )}
          {/*
           * Market + pricing block — Braiins-sourced numbers only.
           * Fillable-at-target leads (what we'd actually pay). Then
           * max-bid (+ its dynamic sibling) — the ceiling. Best bid /
           * best ask are market color at the bottom.
           *
           * Hashprice (break-even) is shown in the Ocean card — it's
           * an Ocean-derived figure, not a Braiins one, and mixing
           * them here misled operators into thinking the controller
           * was using a Braiins-sourced break-even reference.
           */}
          <div className="border-t border-slate-800 mt-2 pt-2">
            <Row
              k={s.config_summary.binding_cap === 'fixed' ? t`max bid (binding)` : t`max bid`}
              v={denomination.formatSatPerPhDay(s.config_summary.max_bid_sat_per_ph_day, intlLocale)}
            />
            {s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day !== null && (
              <>
                <Row
                  k={t`max over hashprice`}
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day,
                    intlLocale,
                  )}
                />
                <Row
                  k={s.config_summary.binding_cap === 'dynamic' ? t`effective cap (binding)` : t`effective cap`}
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.effective_cap_sat_per_ph_day,
                    intlLocale,
                  )}
                />
              </>
            )}
            <Row k={t`best bid`} v={denomination.formatSatPerPhDay(s.market?.best_bid_sat_per_ph_day ?? null, intlLocale)} />
            <Row k={t`best ask`} v={denomination.formatSatPerPhDay(s.market?.best_ask_sat_per_ph_day ?? null, intlLocale)} />
          </div>
          <div className="border-t border-slate-800 mt-2 pt-2">
            <BraiinsBalances
              balances={s.balances}
              actualSpendPerDaySat3h={s.actual_spend_per_day_sat_3h}
              locale={intlLocale}
              denomination={denomination}
            />
          </div>
        </Card>
        <DatumPanel
          url={s.config_summary.pool_url}
          reachable={s.pool.reachable}
          consecutiveFailures={s.pool.consecutive_failures}
          datum={s.datum}
          nextTickAt={s.next_tick_at}
        />
        <OceanPanel />
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Bids</Trans></h3>
        {s.bids.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-slate-500 text-sm">
            <Trans>no bids on this account</Trans>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 bg-slate-900/50">
                <tr>
                  <th className="text-left py-2 px-3"><Trans>id</Trans></th>
                  <th className="text-left py-2 px-3"><Trans>owner</Trans></th>
                  <th className="text-left py-2 px-3"><Trans>created</Trans></th>
                  <th className="text-right py-2 px-3"><Trans>price</Trans></th>
                  <th className="text-right py-2 px-3"><Trans>delivered / cap</Trans></th>
                  <th className="text-right py-2 px-3"><Trans>budget</Trans></th>
                  <th className="text-left py-2 px-3 w-32"><Trans>progress</Trans></th>
                  <th className="text-left py-2 px-3"><Trans>status</Trans></th>
                </tr>
              </thead>
              <tbody>
                {s.bids.map((b) => (
                  <tr key={b.braiins_order_id} className="border-t border-slate-800">
                    <td className="py-2 px-3 font-mono text-xs">
                      <BidIdCell id={b.braiins_order_id} />
                    </td>
                    <td className="py-2 px-3">
                      {b.is_owned ? (
                        <span className="text-emerald-400"><Trans>autopilot</Trans></span>
                      ) : (
                        <span className="text-amber-400"><Trans>unknown</Trans></span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {b.created_at_ms ? (
                        <>
                          <div className="text-slate-300">{formatTimestamp(b.created_at_ms)}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatTimestampUtc(b.created_at_ms)}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <FormattedValue v={denomination.formatSatPerPhDay(b.price_sat_per_ph_day, intlLocale)} />
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatHashratePH(b.avg_speed_ph)}
                      <span className="text-xs text-slate-500">
                        {' '}
                        / {b.speed_limit_ph ? formatHashratePH(b.speed_limit_ph) : '∞'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <FormattedValue v={denomination.formatSat(b.amount_sat, intlLocale)} />
                    </td>
                    <td className="py-2 px-3">
                      <BidProgress pct={b.progress_pct} />
                    </td>
                    <td className={`py-2 px-3 text-xs ${bidStatusClass(b.status)}`}>
                      {bidStatusLabel(b.status)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <FinancePanel
          data={financeQuery.data}
          rangeData={financeRangeQuery.data}
          status={s}
          chartRange={chartRange}
          onRefresh={() => {
            qc.invalidateQueries({ queryKey: ['finance'] });
            qc.invalidateQueries({ queryKey: ['finance-range'] });
          }}
          refreshing={financeQuery.isFetching || financeRangeQuery.isFetching}
        />
      </section>

      {s.last_proposals.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Last tick proposals</Trans></h3>
          <ul className="space-y-1">
            {s.last_proposals.map((p, i) => (
              <li key={i}>
                <ProposalLine p={p} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero operations card — run mode, action mode, operator avail, quiet hours.
// ---------------------------------------------------------------------------

const heroColors: Record<StatusResponse['run_mode'], string> = {
  DRY_RUN: 'from-sky-900/60 to-sky-950/40 border-sky-700/40',
  LIVE: 'from-emerald-900/60 to-emerald-950/40 border-emerald-700/40',
  PAUSED: 'from-amber-900/60 to-amber-950/40 border-amber-700/40',
};

/**
 * Pick the price (sat/PH/day) to display in the hero card from a
 * StatusResponse. We want the *current bid*, not the realised
 * effective rate (#69) - the latter is a per-tick measurement
 * artefact that swings with delivery and metering noise even after
 * the 30-min smoothing+cap layer. The bid is what we asked Braiins
 * to charge; under pay-your-bid that's the price actually paid.
 *
 * Returns null when no owned active bid exists yet (fresh install,
 * mid-CREATE, daemon paused). Caller renders an em-dash placeholder.
 */
function primaryBidPricePH(s: StatusResponse): number | null {
  const active = s.bids.find((b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE');
  if (active) return active.price_sat_per_ph_day;
  // Fall back to any owned bid (e.g. BID_STATUS_CREATED while waiting
  // for Telegram confirmation in legacy installs) so the operator
  // still sees what they're about to pay.
  const anyOwned = s.bids.find((b) => b.is_owned);
  return anyOwned ? anyOwned.price_sat_per_ph_day : null;
}

function OperationsCard({
  s,
  currentBidPH,
  hashpricePH,
  onRunMode,
  runModePending,
}: {
  s: StatusResponse;
  /**
   * Current owned-bid price in sat/PH/day. Under pay-your-bid this is
   * exactly the price Braiins charges per delivered EH-day, which is
   * what an operator wants to read at a glance. Distinct from the
   * window-averaged `AVG COST / PH DELIVERED` in the stats row (a
   * post-hoc realised rate where measurement noise washes out over
   * the chart range).
   */
  currentBidPH: number | null;
  /**
   * Current spot hashprice from Ocean, sat/PH/day. The delta next to
   * the price value is computed against this: positive = paying
   * above break-even, negative = paying below.
   */
  hashpricePH: number | null;
  onRunMode: (m: (typeof RUN_MODES)[number]) => void;
  runModePending: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const actionVisible = s.action_mode !== 'NORMAL';

  const activeOwned = s.bids.filter(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const currentPricePH = currentBidPH;

  const deliveredColor =
    s.actual_hashrate_ph < s.config_summary.minimum_floor_hashrate_ph
      ? 'text-red-400'
      : s.actual_hashrate_ph < s.config_summary.target_hashrate_ph
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <section
      className={`bg-gradient-to-br ${heroColors[s.run_mode]} border rounded-xl p-5 h-full flex flex-col justify-center items-center text-center`}
    >
      {currentPricePH !== null ? (
        <div className="grid grid-cols-2 gap-6 w-full">
          <Tooltip text={t`Current owned-bid price (sat/PH/day). Under pay-your-bid this is exactly what Braiins charges per delivered EH-day - the live price you're paying. The plus/minus next to it is the spread vs Ocean's spot hashprice (positive = paying above break-even, negative = below). For the realised effective rate (post-hoc, range-averaged across actual delivery and metering noise), see the AVG COST / PH DELIVERED stats card.`}>
            <div className="flex flex-col items-center cursor-help">
              <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1"><Trans>price</Trans></div>
              {/* relative wrapper so the ±delta can be position:absolute
                  outside the flow — that way the big number stays centered
                  regardless of how wide the badge gets (e.g. "+9" vs "+126"). */}
              <div className="relative leading-none">
                <span className="text-4xl font-mono font-semibold text-slate-100 tabular-nums">
                  {denomination.mode === 'usd' && denomination.btcPrice !== null
                    ? `$${new Intl.NumberFormat(intlLocale, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format((Math.round(currentPricePH) / 100_000_000) * denomination.btcPrice)}`
                    : formatNumber(Math.round(currentPricePH), {}, intlLocale)}
                </span>
                <span className="absolute left-full top-1/2 -translate-y-1/2 ml-1.5 whitespace-nowrap">
                  <PriceDeltaVsHashprice
                    currentPH={currentPricePH}
                    hashpricePH={hashpricePH}
                    intlLocale={intlLocale}
                  />
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1">
                {denomination.mode === 'usd' ? '$' : <><SatSymbol /></>}
                {t`/PH/day`}{' '}
                {activeOwned.length > 1 ? (
                  <Trans>current bid · primary of {activeOwned.length}</Trans>
                ) : (
                  <Trans>current bid</Trans>
                )}
              </div>
            </div>
          </Tooltip>
          <div className="flex flex-col items-center">
            <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1"><Trans>delivered</Trans></div>
            <div className={`text-4xl font-mono font-semibold tabular-nums leading-none ${deliveredColor}`}>
              {formatNumber(s.actual_hashrate_ph, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }, intlLocale)}
            </div>
            <div className="text-xs text-slate-400 mt-1">PH/s</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="text-3xl font-mono text-slate-500">—</div>
          <div className="text-xs text-slate-400 mt-0.5"><Trans>no active bid</Trans></div>
        </div>
      )}
      <RunModeToggle current={s.run_mode} onChange={onRunMode} disabled={runModePending} />
      {actionVisible && (
        <div className="mt-2 text-sm text-amber-200">
          ⚠ {actionModeLabel(s.action_mode)}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Next action card
// ---------------------------------------------------------------------------

const TICK_RESULT_STALE_MS = 30_000;

const TICK_RESULT_OUTCOME_STYLES: Record<string, string> = {
  EXECUTED: 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
  DRY_RUN: 'bg-slate-800 text-slate-300 border-slate-700',
  BLOCKED: 'bg-amber-900/40 text-amber-300 border-amber-700',
  FAILED: 'bg-red-900/40 text-red-300 border-red-700',
};

function NextActionCard({
  s,
  onTickNow,
  tickPending,
  tickResult,
}: {
  s: StatusResponse;
  onTickNow: () => void;
  tickPending: boolean;
  tickResult: TickNowResponse | undefined;
}) {
  const { i18n } = useLingui();
  void i18n;
  // Auto-fade the tick-result banner after a short window. Without
  // this the "Edit price: executed" line sits there long after the
  // decision ran and confuses "what just happened" with "what's
  // currently happening".
  const [tickResultStale, setTickResultStale] = useState(false);
  useEffect(() => {
    if (!tickResult) {
      setTickResultStale(false);
      return;
    }
    setTickResultStale(false);
    const id = setTimeout(() => setTickResultStale(true), TICK_RESULT_STALE_MS);
    return () => clearTimeout(id);
  }, [tickResult]);
  const showTickResult = tickResult && !tickResultStale;

  const tickResultKindLabels: Record<string, string> = {
    CREATE_BID: t`Create bid`,
    EDIT_PRICE: t`Edit price`,
    EDIT_SPEED: t`Edit speed`,
    CANCEL_BID: t`Cancel bid`,
    PAUSE: t`Pause`,
  };
  const tickResultReasonLabels: Record<string, string> = {
    RUN_MODE_NOT_LIVE: t`not in LIVE mode`,
    RUN_MODE_PAUSED: t`paused`,
    ACTION_MODE_BLOCKS_CREATE_OR_EDIT: t`action mode blocks this`,
    PRICE_DECREASE_COOLDOWN: t`Braiins 10-min cooldown`,
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-full flex flex-col">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-1"><Trans>Next action</Trans></h3>
        <JustExecutedBanner last={s.next_action.last_executed} />
        <NextActionMessage next={s.next_action} />
        <NextActionProgress next={s.next_action} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onTickNow}
          disabled={tickPending}
          title={t`Run the pending decision immediately — clears the post-edit lock and bypasses the patience/escalation timers so a waiting-to-settle EDIT_PRICE fires on this tick instead of after the full window.`}
          className="px-3 py-1.5 text-xs rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {tickPending ? <Trans>ticking…</Trans> : <Trans>Run decision now</Trans>}
        </button>
      </div>

      {showTickResult && tickResult && (
        <div className="mt-2 text-xs">
          {tickResult.ok
            ? (() => {
                const executed = tickResult.executed ?? [];
                if (executed.length === 0) {
                  return (
                    <span className="text-slate-400"><Trans>No action needed this tick.</Trans></span>
                  );
                }
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {executed.map((e, i) => {
                      const label = tickResultKindLabels[e.kind] ?? e.kind;
                      const pillClass =
                        TICK_RESULT_OUTCOME_STYLES[e.outcome] ??
                        'bg-slate-800 text-slate-300 border-slate-700';
                      const outcomeLabel = e.outcome.toLowerCase();
                      const reasonLabel = e.reason
                        ? tickResultReasonLabels[e.reason] ?? e.reason
                        : null;
                      return (
                        <span key={i} className="inline-flex items-center gap-1.5">
                          <span className="text-slate-300">{label}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${pillClass}`}
                          >
                            {outcomeLabel}
                          </span>
                          {reasonLabel && (
                            <span className="text-slate-500 text-[11px]">
                              — {reasonLabel}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })()
            : (
              <span className="text-red-400"><Trans>tick failed: {tickResult.error}</Trans></span>
            )}
        </div>
      )}

      <NextActionFooter
        tickAt={s.tick_at}
        nextTickAt={s.next_tick_at}
        tickIntervalMs={s.tick_interval_ms}
      />
    </section>
  );
}

/**
 * Single-line footer on the Next-Action card: left = "last tick" with
 * absolute timestamp + relative age, right = live-ticking countdown to
 * the next blip. The countdown ticks once per second client-side
 * (server poll only refreshes `next_tick_at` every 5s, which would
 * otherwise produce a step-jumping number).
 */
function NextActionFooter({
  tickAt,
  nextTickAt,
  tickIntervalMs,
}: {
  tickAt: number | null;
  nextTickAt: number | null;
  tickIntervalMs: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the server hasn't told us when the next tick is, fall back to
  // tick_at + interval so the countdown still has something to show.
  const eta =
    nextTickAt ?? (tickAt !== null ? tickAt + tickIntervalMs : null);
  const remainingSec =
    eta !== null ? Math.max(0, Math.ceil((eta - now) / 1000)) : null;

  return (
    <div className="mt-3 pt-2 border-t border-slate-800 flex items-baseline justify-between gap-3 text-[11px] text-slate-500 font-mono">
      <span title={tickAt !== null ? formatTimestampUtc(tickAt) : ''}>
        <Trans>last tick:</Trans>{' '}
        <span className="text-slate-400">
          {tickAt !== null ? formatTimestamp(tickAt) : '—'}
        </span>
        {tickAt !== null && (
          <span className="ml-1 text-slate-600">({formatAge(tickAt)})</span>
        )}
      </span>
      <span>
        {remainingSec === null
          ? '—'
          : remainingSec > 0 ? (
              <Trans>
                next in{' '}
                <span className="text-slate-300 tabular-nums">{remainingSec}s</span>
              </Trans>
            )
          : <span className="text-slate-400"><Trans>refreshing…</Trans></span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Effective-rate delta vs hashprice (hero card)
// ---------------------------------------------------------------------------

/**
 * Stock-ticker style ±delta of our effective-paid rate vs the spot
 * hashprice, rendered inline next to the big price number. Negative
 * (emerald) = paying below break-even.
 */
function PriceDeltaVsHashprice({
  currentPH,
  hashpricePH,
  intlLocale,
}: {
  currentPH: number;
  hashpricePH: number | null;
  intlLocale: string | undefined;
}) {
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;
  if (hashpricePH === null) return null;
  const delta = Math.round(currentPH - hashpricePH);
  const hashpricePretty = denomination.formatSatPerPhDay(Math.round(hashpricePH));

  if (delta === 0) {
    return (
      <span
        className="text-xs font-mono text-slate-400 cursor-help"
        title={t`Effective rate equals hashprice (${hashpricePretty}) — breaking even.`}
      >
        ±0
      </span>
    );
  }

  const sign = delta > 0 ? '+' : '−';
  const color = delta > 0 ? 'text-red-300' : 'text-emerald-300';
  const deltaFormatted = denomination.formatSatPerPhDay(Math.abs(delta));
  const tooltip =
    delta > 0
      ? t`Effective rate ${sign}${deltaFormatted} above hashprice (${hashpricePretty}) — positive means paying above break-even, negative means paying below (profitable).`
      : t`Effective rate ${sign}${deltaFormatted} below hashprice (${hashpricePretty}) — positive means paying above break-even, negative means paying below (profitable).`;

  return (
    <Tooltip text={tooltip}>
      <span className={`text-xs font-mono ${color} cursor-help`}>
        {sign}{denomination.mode === 'usd' && denomination.btcPrice
          ? denomination.formatSatPerPhDay(Math.abs(delta)).replace(/\/PH\/day$/, '')
          : formatNumber(Math.abs(delta), {}, intlLocale)}
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// "Just executed" breadcrumb on the Next-Action card
// ---------------------------------------------------------------------------

const JUST_EXECUTED_VISIBLE_MS = 90_000;

/**
 * Briefly surfaces the most recent autopilot mutation so the operator
 * sees explicit confirmation when a tick fires — instead of the panel
 * silently jumping from "Will lower …" to "On target". Auto-fades
 * after ~90s. Re-renders every 5s so the relative-age text refreshes.
 */
/**
 * Translates the next-action message via the operator's active locale
 * by switching on the structured `descriptor` the daemon emits. Falls
 * back to the daemon's English `summary` / `detail` strings when the
 * descriptor is null (older client/server pair or one of the rare
 * paths that hasn't been classified yet).
 */
function NextActionMessage({ next }: { next: NextActionView }) {
  const { i18n } = useLingui();
  void i18n;
  const d = next.descriptor;
  if (!d) {
    return (
      <>
        <div className="text-slate-100">{next.summary}</div>
        {next.detail && <div className="text-xs text-slate-400 mt-1">{next.detail}</div>}
      </>
    );
  }
  const summary = renderNextActionSummary(d);
  const detail = renderNextActionDetail(d);
  return (
    <>
      <div className="text-slate-100">{summary}</div>
      {detail && <div className="text-xs text-slate-400 mt-1">{detail}</div>}
    </>
  );
}

function renderNextActionSummary(d: NonNullable<NextActionView['descriptor']>): React.ReactNode {
  switch (d.kind) {
    case 'paused':
      return <Trans>Paused - no bids will be placed or edited until run mode changes.</Trans>;
    case 'unknown_bids':
      return <Trans>Unknown bid(s) detected - next tick will PAUSE the autopilot.</Trans>;
    case 'braiins_unreachable':
      return <Trans>Braiins API unreachable - waiting for connectivity.</Trans>;
    case 'awaiting_hashprice':
      return <Trans>Waiting for Ocean hashprice - trading is paused until the break-even reference is available.</Trans>;
    case 'no_market_supply':
      return <Trans>No hashrate available on the market right now.</Trans>;
    case 'will_create_bid': {
      const target = d.target_ph.toLocaleString('en-US');
      return d.run_mode === 'LIVE' ? (
        <Trans>Will place a CREATE_BID at {target} sat/PH/day on the next tick.</Trans>
      ) : (
        <Trans>Will log (dry-run) a CREATE_BID at {target} sat/PH/day on the next tick.</Trans>
      );
    }
    case 'bid_pending':
      return (
        <Trans>
          Bid {d.id_short} is {d.status} - waiting for it to become active.
        </Trans>
      );
    case 'cooldown_active':
      return <Trans>Bid above target - Braiins price-decrease cooldown active.</Trans>;
    case 'will_edit_bid': {
      const target = d.target_ph.toLocaleString('en-US');
      return d.run_mode === 'LIVE' ? (
        <Trans>Will edit bid to {target} sat/PH/day on the next tick.</Trans>
      ) : (
        <Trans>Will log edit (dry-run) bid to {target} sat/PH/day on the next tick.</Trans>
      );
    }
    case 'on_target':
      return d.capped ? (
        <Trans>At effective cap - desired fillable + overpay exceeds the ceiling.</Trans>
      ) : (
        <Trans>On target - bid at fillable + overpay.</Trans>
      );
  }
}

function renderNextActionDetail(d: NonNullable<NextActionView['descriptor']>): React.ReactNode | null {
  switch (d.kind) {
    case 'paused':
    case 'braiins_unreachable':
    case 'no_market_supply':
      return null;
    case 'unknown_bids':
      return <Trans>IDs: {d.ids.join(', ')}</Trans>;
    case 'awaiting_hashprice':
      return (
        <Trans>
          Ocean hashprice is required to evaluate the dynamic cap you configured. If this persists,
          check Ocean's reachability in the Ocean panel.
        </Trans>
      );
    case 'will_create_bid': {
      if (d.budget.kind === 'configured') {
        const sat = d.budget.sat.toLocaleString('en-US');
        return <Trans>{d.target_hashrate_ph} PH/s target, {sat} sat budget.</Trans>;
      }
      if (d.budget.kind === 'full_wallet') {
        const sat = d.budget.available_sat.toLocaleString('en-US');
        return (
          <Trans>
            {d.target_hashrate_ph} PH/s target, {sat} sat budget (full wallet).
          </Trans>
        );
      }
      return (
        <Trans>{d.target_hashrate_ph} PH/s target, full wallet balance (awaiting balance).</Trans>
      );
    }
    case 'bid_pending':
      // Telegram confirmation hint kept English-only on purpose: the
      // bot itself only speaks English. (Daemon-side `detail` is
      // non-null only when status is BID_STATUS_CREATED; in any other
      // pending state the detail line is absent.)
      return null;
    case 'cooldown_active': {
      const target = d.target_ph.toLocaleString('en-US');
      const current = d.current_ph.toLocaleString('en-US');
      return d.direction === 'lower' ? (
        <Trans>
          Will lower to {target} sat/PH/day in ~{d.mins_left} min (current {current}).
        </Trans>
      ) : (
        <Trans>
          Will raise to {target} sat/PH/day in ~{d.mins_left} min (current {current}).
        </Trans>
      );
    }
    case 'will_edit_bid': {
      const current = d.current_ph.toLocaleString('en-US');
      return d.clamped ? (
        <Trans>Current {current} sat/PH/day - tracking fillable + overpay (clamped).</Trans>
      ) : (
        <Trans>Current {current} sat/PH/day - tracking fillable + overpay.</Trans>
      );
    }
    case 'on_target': {
      const speed = d.avg_speed_ph.toFixed(2);
      return <Trans>Bid filling at {speed} PH/s.</Trans>;
    }
  }
}

function JustExecutedBanner({ last }: { last: NextActionView['last_executed'] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!last) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [last]);

  if (!last) return null;
  const age = now - last.executed_at_ms;
  if (age > JUST_EXECUTED_VISIBLE_MS) return null;

  return (
    <div className="mb-2 flex items-baseline gap-2 text-xs">
      <span className="text-emerald-400">✓</span>
      <span className="text-emerald-200">{last.summary}</span>
      <span className="text-slate-500 text-[11px]">({formatAge(last.executed_at_ms)})</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next-action progress bar (issue #4)
// ---------------------------------------------------------------------------

const EVENT_COLORS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'bg-amber-400',
  lower_after_override: 'bg-sky-400',
  lower_after_patience: 'bg-sky-400',
  lower_after_cooldown: 'bg-sky-400',
};

function NextActionProgress({ next }: { next: NextActionView }) {
  const { i18n } = useLingui();
  void i18n;
  // Re-render every second so the bar visibly creeps even between the
  // 5s status polls. Hook is only useful when an event is queued; gate
  // the interval below to avoid burning a timer in steady state.
  const hasEvent =
    next.eta_ms !== null && next.event_started_ms !== null && next.event_kind !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasEvent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasEvent]);

  if (!hasEvent) return null;
  const start = next.event_started_ms!;
  const end = next.eta_ms!;
  const span = Math.max(1, end - start);
  const elapsed = Math.max(0, Math.min(span, now - start));
  const fraction = elapsed / span;
  const remainingMs = Math.max(0, end - now);
  const overdue = end < now;
  const eventLabels: Record<NonNullable<NextActionView['event_kind']>, string> = {
    escalation: t`Escalation in`,
    lower_after_override: t`Override lock clears in`,
    lower_after_patience: t`Patience clears in`,
    lower_after_cooldown: t`Cooldown clears in`,
  };
  const label = eventLabels[next.event_kind!];
  const fillColor = overdue ? 'bg-red-400' : EVENT_COLORS[next.event_kind!];
  const remainingFormatted = formatRemaining(remainingMs);
  const overdueFormatted = formatRemaining(now - end);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-[11px] text-slate-400 mb-1 font-mono">
        <span>{label}</span>
        <span className={overdue ? 'text-red-300' : ''}>
          {overdue ? <Trans>overdue {overdueFormatted}</Trans> : remainingFormatted}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded overflow-hidden">
        <div
          className={`h-full ${fillColor} transition-[width] duration-1000 ease-linear`}
          style={{ width: `${(fraction * 100).toFixed(2)}%` }}
        />
      </div>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tuning stats bar (between charts and cards)
// ---------------------------------------------------------------------------

const EH_PER_PH = 1000;


function FilterBar({
  range,
  onRangeChange,
}: {
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  return (
    <section className="flex items-center justify-end flex-wrap gap-2">
      <div className="flex gap-1">
        {CHART_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`text-xs px-2 py-1 rounded ${
              r === range
                ? 'bg-emerald-700 text-emerald-100'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {localizedRangeLabel(r, i18n.locale)}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Four KPIs from the server-side `/api/stats` endpoint. The server
 * computes duration-weighted averages from the raw tick_metrics table
 * using SQL LEAD() window function, so each tick is weighted by its
 * actual duration — not an equal-weight approximation that distorts
 * on pre-aggregated chart buckets (1w/1m).
 *
 * Responds to the chart range filter (same query param) so the
 * operator can compare stats across 6h/24h/1w etc.
 */
function StatsBar({ statsData }: { statsData: StatsResponse | undefined }) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  if (!statsData) {
    const placeholderCards = [
      t`uptime`,
      t`avg braiins`,
      t`avg datum`,
      t`avg ocean`,
      t`avg cost / PH delivered`,
      t`avg cost vs hashprice`,
    ];
    return (
      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {placeholderCards.map((label) => (
          <StatCard key={label} label={label} value="—" tooltip={t`Loading or daemon restart required.`} />
        ))}
      </section>
    );
  }

  if (statsData.tick_count < 2) return null;

  const { uptime_pct, avg_hashrate_ph, avg_datum_hashrate_ph, avg_ocean_hashrate_ph, avg_cost_per_ph_sat_per_ph_day, avg_overpay_vs_hashprice_sat_per_ph_day } = statsData;
  // total_ph_hours + mutation_count remain on the server-side
  // StatsResponse even though no card consumes them — keeping the
  // shape stable so we can re-surface either later without a backend
  // round-trip.
  void statsData.total_ph_hours;
  void statsData.mutation_count;

  return (
    <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <StatCard
        label={t`uptime`}
        value={uptime_pct !== null ? `${uptime_pct.toFixed(1)}%` : '\u2014'}
        tooltip={t`Duration-weighted % of time with delivered hashrate > 0. Each tick is weighted by its actual duration (time until the next tick) so gaps after restarts count proportionally.`}
        color={
          uptime_pct === null
            ? 'text-slate-400'
            : uptime_pct >= 90
              ? 'text-emerald-300'
              : uptime_pct >= 50
                ? 'text-amber-300'
                : 'text-red-300'
        }
      />
      <StatCard
        label={t`avg braiins`}
        value={formatHashratePH(avg_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Braiins reports delivering. Includes downtime (where delivered = 0) so a bad stretch shows up in the average, not just the live card.`}
      />
      <StatCard
        label={t`avg datum`}
        value={formatHashratePH(avg_datum_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Datum measures at the gateway. A sustained gap below Avg Braiins means Braiins is billing for hashrate Datum never saw arrive.`}
      />
      <StatCard
        label={t`avg ocean`}
        value={formatHashratePH(avg_ocean_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Ocean credits to our payout address. Each tick (every 60 s) the daemon calls Ocean's /v1/user_hashrate endpoint and reads the \`hashrate_300s\` field — Ocean's own 5-minute sliding-window estimate for this wallet. So: sampled every minute, each sample is a 5-minute smoothed value. A sustained gap below Avg Braiins / Avg Datum means the pool isn't crediting work we think we delivered.`}
      />
      <StatCard
        label={t`avg cost / PH delivered`}
        value={avg_cost_per_ph_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_cost_per_ph_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip={t`Average effective rate over the selected chart range (default 3h) — what Braiins actually charged per PH/day delivered, from per-tick Δconsumed_sat ÷ (delivered_ph × Δt). Same metric the hero PRICE card shows; this pair is duplicated so each panel stands on its own. For the current bid price see the NEXT ACTION panel.`}
      />
      <StatCard
        label={t`avg cost vs hashprice`}
        value={avg_overpay_vs_hashprice_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_overpay_vs_hashprice_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip={t`Duration-weighted average of (effective price − hashprice). Negative means matched asks averaged below the break-even hashprice (good — cheaper than mining at current difficulty). Positive means above break-even.`}
        color={
          avg_overpay_vs_hashprice_sat_per_ph_day === null
            ? 'text-slate-100'
            : avg_overpay_vs_hashprice_sat_per_ph_day < 0
              ? 'text-emerald-300'
              : avg_overpay_vs_hashprice_sat_per_ph_day > 0
                ? 'text-red-300'
                : 'text-slate-100'
        }
      />
    </section>
  );
}

function StatCard({
  label,
  value,
  tooltip,
  color = 'text-slate-100',
}: {
  label: string;
  value: string;
  tooltip: string;
  color?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 cursor-help text-center">
        {/* Reserve two lines for the label so single-line cards
            ("uptime") line up with two-line cards ("avg cost / PH
            delivered") — otherwise the big numbers underneath
            don't share a baseline. */}
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2 min-h-8 leading-4 flex items-start justify-center">
          <span>{label}</span>
        </div>
        <div className={`text-2xl font-mono tabular-nums ${color}`}>
          {split ? split.num : value}
        </div>
        {split && (
          <div className="text-xs text-slate-500 mt-0.5"><SatUnit unit={split.unit} /></div>
        )}
      </div>
    </Tooltip>
  );
}

function formatFillTime(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m`;
}

// ---------------------------------------------------------------------------

/**
 * Self-ticking "updated X ago" label. Re-renders every 10 s so the
 * operator actually sees the age climb (previously it was pinned to
 * "0s ago" because `checked_at_ms` was Date.now() on every response).
 */
function TickingAge({ epochMs }: { epochMs: number | null | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return <span><Trans>updated {formatAgePrecise(epochMs)}</Trans></span>;
}

/**
 * Forward countdown — "refreshes in 42s", "refreshes in 2m 13s".
 * The panel decides when it will next fetch and hands us that
 * timestamp; we re-render once per second so the digits tick visibly.
 * Prefer this over {@link TickingAge} on panels that refresh on a
 * predictable cadence — operators want to know how long until new
 * data, not how old the current data is.
 */
function RefreshCountdown({
  nextAtMs,
  refetchQueryKey,
}: {
  nextAtMs: number | null | undefined;
  /**
   * When the countdown hits zero, invalidate this query so the
   * panel's data catches up without waiting for react-query's next
   * scheduled poll. Needed on panels whose `nextAtMs` tracks a
   * server-side cadence (daemon tick) that's faster than the
   * dashboard's background poll interval — otherwise "refreshing…"
   * sits on screen for up to the poll interval (30s for /api/status)
   * even when the underlying data source is instant.
   */
  refetchQueryKey?: readonly unknown[];
}) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!refetchQueryKey || nextAtMs == null) return;
    // Self-rescheduling timer. Naive setTimeout(..., msUntil + 300) is
    // not enough: `next_tick_at` is derived from `runtime.last_tick_at
    // + tickIntervalMs`, and `last_tick_at` is only written *after*
    // the tick's observe/decide/execute/persist chain finishes. If the
    // refetch lands while the daemon is mid-tick, the response still
    // carries the previous `next_tick_at` — same number as before, so
    // the effect-deps don't change, and the countdown stays on
    // "refreshing…" until the next react-query poll (up to
    // refetchInterval, i.e. 30 s for /api/status). Instead we keep
    // invalidating every 2 s while the current `nextAtMs` is still in
    // the past; the first fresh response updates `nextAtMs`, the
    // effect re-runs with a new dep value, and the polling stops.
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout>;
    const schedule = (delayMs: number) => {
      handle = setTimeout(() => {
        if (cancelled) return;
        const msUntil = nextAtMs - Date.now();
        if (msUntil > 0) {
          // Not yet expired. This can only happen on the first fire
          // (initial schedule) if the clock jumped, or if the tab was
          // backgrounded and the timer fired late. Reschedule to the
          // real expiry.
          schedule(msUntil + 300);
          return;
        }
        qc.invalidateQueries({ queryKey: refetchQueryKey });
        schedule(2_000);
      }, Math.max(0, delayMs));
    };
    schedule(Math.max(300, nextAtMs - Date.now() + 300));
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [nextAtMs, refetchQueryKey, qc]);
  if (nextAtMs == null) return <span>—</span>;
  const msUntil = nextAtMs - now;
  // Once the countdown crosses zero we're waiting on either the
  // server's next tick (which runs on the interval timer) or the
  // dashboard's next react-query poll. Either way "now" stuck on
  // screen for 30 seconds reads as broken; "refreshing…" is honest
  // about what's happening.
  if (msUntil <= 0) return <span><Trans>refreshing…</Trans></span>;
  return <span><Trans>refreshes in {formatCountdownPrecise(msUntil)}</Trans></span>;
}

function BidIdCell({ id }: { id: string }) {
  // Full ID on sm+ viewports; shortened head…tail with a copy button
  // on mobile. The raw ID is 18 chars and `break-all` wraps it one
  // char per line on narrow screens (#34). Keeping the full ID always
  // visible on desktop preserves the #26 behavior.
  const [copied, setCopied] = useState(false);
  const { i18n } = useLingui();
  void i18n;
  const copy = async () => {
    try {
      await copyToClipboard(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard fell back to execCommand and still failed; no-op */
    }
  };
  const shortId = id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`;
  return (
    <>
      <span className="hidden sm:inline whitespace-nowrap">{id}</span>
      <span className="sm:hidden flex items-center gap-1.5">
        <span>{shortId}</span>
        <button
          onClick={copy}
          aria-label={copied ? t`copied bid ID` : t`copy bid ID`}
          title={copied ? t`copied bid ID` : t`copy bid ID`}
          className={
            'shrink-0 p-0.5 rounded border border-slate-700 hover:bg-slate-800 ' +
            (copied ? 'text-emerald-300' : 'text-slate-400')
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </span>
    </>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Pill-style status indicator used across Braiins / Datum / Ocean
 * panels to show reachability of the underlying external service.
 * Renders a coloured dot + label inside a bordered chip.
 */
function ReachabilityBadge({
  label,
  reachable,
  downLabel,
  title,
}: {
  label: string;
  reachable: boolean;
  /** Override for the text when !reachable (e.g. "DOWN (3 consecutive)"). */
  downLabel?: string;
  title?: string;
}) {
  const { i18n } = useLingui();
  void i18n;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ' +
        (reachable
          ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
          : 'border-red-700 bg-red-900/30 text-red-300')
      }
      title={title}
    >
      <span
        className={
          'w-1.5 h-1.5 rounded-full ' + (reachable ? 'bg-emerald-400' : 'bg-red-400')
        }
      />
      {reachable ? label : (downLabel ?? t`${label} DOWN`)}
    </span>
  );
}

/**
 * Vertical money panel: cost on top, then the two income sources,
 * then net at the bottom. Reads naturally as a profit-and-loss page —
 * the two incomes obviously add up to "what we'll have", which is
 * then offset against "what we paid".
 *
 *   spent     — lifetime sat consumed across all autopilot-owned bids
 *   expected  — Ocean's "Unpaid Earnings" (pending next payout)
 *   collected — on-chain UTXOs at the configured payout address
 *   net       — collected + expected − spent (final result)
 *
 * Each input renders "—" when its source isn't reporting yet; net
 * stays "—" until both income halves have at least one observation.
 */
function BraiinsBalances({
  balances,
  actualSpendPerDaySat3h,
  locale,
  denomination,
}: {
  balances: readonly BalanceView[];
  /**
   * Actual sat/day spend over the last 3 h, from
   * `/api/status.actual_spend_per_day_sat_3h` (primary_bid_consumed_sat
   * deltas scaled to 24h). Null until the daemon has enough matched
   * data in the window. Drives the runway forecast; the old
   * bid × delivered model was lying under CLOB.
   */
  actualSpendPerDaySat3h: number | null;
  locale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
}) {
  const dailySpendSat = actualSpendPerDaySat3h ?? 0;
  const nowMs = Date.now();
  const { i18n } = useLingui();
  void i18n;
  if (balances.length === 0) {
    return <div className="text-slate-500 text-sm">{'\u2014'}</div>;
  }
  return (
    <>
      {balances.map((b) => {
        const runwayDays =
          dailySpendSat > 0 && b.total_balance_sat > 0
            ? b.total_balance_sat / dailySpendSat
            : null;
        const runwayText = (() => {
          if (runwayDays === null) return '\u2014';
          const exhaustAt = new Date(nowMs + runwayDays * 86_400_000);
          const dateLabel = exhaustAt.toLocaleDateString(locale, {
            month: 'short',
            day: 'numeric',
          });
          const daysCount = runwayDays >= 10
            ? Math.round(runwayDays).toString()
            : runwayDays.toFixed(1);
          return t`${daysCount} days \u00b7 ~${dateLabel}`;
        })();
        return (
          <div key={b.subaccount}>
            <Row k={t`available`} v={denomination.formatSat(b.available_balance_sat, locale)} />
            <Row k={t`blocked`} v={denomination.formatSat(b.blocked_balance_sat, locale)} />
            <Row k={t`total`} v={denomination.formatSat(b.total_balance_sat, locale)} />
            <Row k={t`runway`} v={runwayText} />
          </div>
        );
      })}
    </>
  );
}

function OceanPanel() {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  // React-query dedupes by queryKey, so this shares the in-flight
  // fetch + cached response with the parent's own `['ocean']` query
  // (used for the hashrate-chart block markers).
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
  });
  const explorerTemplate =
    configQuery.data?.config?.block_explorer_url_template ??
    'https://mempool.space/block/{hash}';

  const o = oceanQuery.data;

  if (!o || !o.configured) {
    return (
      <Card title="Ocean">
        <div className="text-slate-500 text-sm"><Trans>Not configured</Trans></div>
      </Card>
    );
  }

  // Ocean refreshes every minute client-side (and server caches for
  // the same). Countdown = last fetch + 1 min; reachable whenever
  // the last response carried data.
  const nextOceanRefreshMs =
    o.fetched_at_ms !== null ? o.fetched_at_ms + 60_000 : null;

  return (
    <Card
      title="Ocean"
      nextRefreshAtMs={nextOceanRefreshMs}
      badges={
        <ReachabilityBadge
          label={t`API reachable`}
          reachable={o.fetched_at_ms !== null && o.pool !== null}
          downLabel={t`API DOWN`}
          title={t`Ocean stats API — reachable when the last /api/ocean fetch returned a pool snapshot.`}
        />
      }
    >
      {/* Current observations — same genre as Datum's "datum hashrate"
          or Braiins' "delivered": what the pool reports about our
          wallet right now. */}
      {o.user && (
        <>
          <Row k={t`ocean hashrate`} v={formatHashratePH(o.user.hashrate_5m_ph, intlLocale)} />
          {o.user.hashprice_sat_per_ph_day != null && (
            <Row
              k={t`hashprice (break-even)`}
              v={denomination.formatSatPerPhDay(o.user.hashprice_sat_per_ph_day, intlLocale)}
            />
          )}
        </>
      )}

      {/* Our accrued / projected earnings. */}
      {o.user && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          <Row
            k={t`share log`}
            v={
              o.user.share_log_pct !== null
                ? `${o.user.share_log_pct.toFixed(4)}%`
                : '\u2014'
            }
          />
          <Row k={t`unpaid`} v={denomination.formatSat(o.user.unpaid_sat, intlLocale)} />
          <Row
            k={t`next block est.`}
            v={denomination.formatSat(o.user.next_block_sat, intlLocale)}
          />
          <Row
            k={t`income/day est.`}
            v={denomination.formatSat(o.user.daily_estimate_sat, intlLocale)}
          />
          {o.user.time_to_payout_text && (
            <Row k={t`next payout`} v={formatNextPayout(o.user.time_to_payout_text, intlLocale)} />
          )}
        </div>
      )}

      {/* Pool-wide context — less important day-to-day, so it lives
          at the bottom of the panel. */}
      <div className="border-t border-slate-800 mt-2 pt-2">
        {o.last_block ? (
          <>
            <LinkRow
              k={t`last pool block`}
              v={`#${o.last_block.height.toLocaleString(intlLocale)}`}
              href={applyExplorerTemplate(explorerTemplate, {
                block_hash: o.last_block.block_hash,
                height: o.last_block.height,
              })}
            />
            <Row k={t`found`} v={o.last_block.ago_text} />
            {/* Our estimated share of this block — same math as the
                chart tooltip: total_reward × current share_log. An
                approximation for older blocks since share_log drifts,
                but operator-relevant rather than the total block
                reward (which tells you nothing about our cut). */}
            <Row
              k={t`our earnings (est.)`}
              v={
                o.user?.share_log_pct != null
                  ? denomination.formatSat(
                      Math.round(
                        (o.last_block.total_reward_sat * o.user.share_log_pct) / 100,
                      ),
                      intlLocale,
                    )
                  : '\u2014'
              }
            />
          </>
        ) : (
          <Row k={t`last pool block`} v={'\u2014'} />
        )}
        <Row k={t`pool blocks 24h`} v={String(o.blocks_24h)} />
        <Row k={t`pool blocks 7d`} v={String(o.blocks_7d)} />
      </div>
      {o.pool && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          {o.pool.active_users !== null && (
            <Row k={t`pool users`} v={o.pool.active_users.toLocaleString(intlLocale)} />
          )}
          {o.pool.active_workers !== null && (
            <Row k={t`pool workers`} v={o.pool.active_workers.toLocaleString(intlLocale)} />
          )}
        </div>
      )}
    </Card>
  );
}

function FinancePanel({
  data,
  rangeData,
  status,
  chartRange,
  onRefresh,
  refreshing,
}: {
  data: FinanceResponse | undefined;
  rangeData: FinanceRangeResponse | undefined;
  status: StatusResponse;
  chartRange: ChartRange;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const qc = useQueryClient();
  const [rebuilding, setRebuilding] = useState(false);
  const { i18n } = useLingui();
  void i18n;

  const handleRebuild = async () => {
    if (rebuilding) return;
    if (!window.confirm(t`Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh? This is safe but slower than a normal refresh.`)) {
      return;
    }
    setRebuilding(true);
    try {
      await api.rebuildSpendCache();
      qc.invalidateQueries({ queryKey: ['finance'] });
    } finally {
      setRebuilding(false);
    }
  };

  // Per-day run-rate view (issue #43). Prefers the range-aware
  // aggregates from /api/finance/range (avg_price × avg_delivered and
  // avg_hashprice × avg_delivered over the selected chart range);
  // falls back to the instantaneous formula when the server doesn't
  // have enough ticks yet (fresh install, post-prune, daemon just
  // started). The "Ocean est." row is always the 3h snapshot from
  // Ocean's `daily_estimate_sat` regardless of range — it's
  // authoritative for the pool-view estimate.
  //
  // Computed BEFORE the `!data` early return so hook count is stable
  // across the null → defined transition of `data` (React error #310).
  const {
    dailySpendSat,
    hasDailySpend,
    oceanDailyIncomeSat,
    projectedDailyIncomeSat,
    dailyNetSat,
    dailyNetColor,
    rangeFallback,
  } = useMemo(() => {
    const hasActive = status.bids.some(
      (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
    );

    // Range-aware path: derived fields are null when the server
    // returns `insufficient_history`. Fall back to the 3h actual
    // spend rate carried on /api/status — which also derives from
    // primary_bid_consumed_sat deltas, just over a fixed 3h window
    // instead of the selected range.
    const haveRange =
      rangeData !== undefined &&
      !rangeData.insufficient_history &&
      rangeData.actual_spend_per_day_sat !== null;

    const spend = haveRange
      ? rangeData!.actual_spend_per_day_sat!
      : status.actual_spend_per_day_sat_3h ?? 0;
    const projectedIncome = haveRange
      ? rangeData!.projected_income_per_day_sat
      : null;
    const oceanIncome = data?.ocean?.daily_estimate_sat ?? null;
    // Net keyed off projected income (range-symmetric with spend)
    // when available; otherwise Ocean income to keep the old
    // behaviour on fresh installs where range can't be computed.
    const referenceIncome = projectedIncome ?? oceanIncome;
    const net =
      referenceIncome !== null ? Math.round(referenceIncome - spend) : null;

    return {
      dailySpendSat: spend,
      hasDailySpend: hasActive,
      oceanDailyIncomeSat: oceanIncome,
      projectedDailyIncomeSat: projectedIncome,
      dailyNetSat: net,
      dailyNetColor:
        net === null ? '' : net >= 0 ? 'text-emerald-300' : 'text-red-300',
      rangeFallback: !haveRange,
    };
  }, [
    status.bids,
    status.avg_delivered_ph_3h,
    data?.ocean?.daily_estimate_sat,
    rangeData,
  ]);

  if (!data) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Profit &amp; Loss</Trans></div>
        <div className="text-slate-500 text-sm"><Trans>loading…</Trans></div>
      </section>
    );
  }

  const netColor =
    data.net_sat === null
      ? 'text-slate-400'
      : data.net_sat >= 0
        ? 'text-emerald-300'
        : 'text-red-300';

  const hasPerDay =
    oceanDailyIncomeSat !== null ||
    projectedDailyIncomeSat !== null ||
    hasDailySpend ||
    dailyNetSat !== null ||
    data.ocean?.hashprice_sat_per_ph_day != null ||
    data.ocean?.lifetime_sat != null ||
    !!data.ocean?.time_to_payout_text;

  // Range label shown next to the headline numbers so the operator
  // can glance-check what window the avg is over. Matches the chart
  // range dropdown labels from CHART_RANGE_SPECS.
  const rangeLabel = localizedRangeLabel(chartRange, i18n.locale);

  // P&L refreshes hourly server-side. Dashboard countdown is derived
  // from checked_at_ms + 1h so the operator sees how long until fresh
  // numbers without guessing the cadence.
  const nextRefreshAtMs = data.checked_at_ms + 3_600_000;

  const headerControls = (
    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
      <RefreshCountdown nextAtMs={nextRefreshAtMs} />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
        title={t`Refresh the money panel now (normally updates hourly).`}
      >
        {refreshing ? '…' : '↻'}
      </button>
      {data.spent_scope === 'account' && (
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
          title={t`Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh. Use if the 'spent (whole account)' figure looks wrong.`}
        >
          {rebuilding ? '…' : <Trans>rebuild</Trans>}
        </button>
      )}
    </div>
  );

  // Two separate cards: per-day run-rate and lifetime totals. Same
  // data source, but visually distinct so the operator reads them as
  // two different questions — "am I burning money per day right now?"
  // vs "did I end up ahead over the whole run?".
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Left card — per-day run-rate */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Profit &amp; Loss · per day</Trans>
          </div>
          {headerControls}
        </div>
        {hasPerDay ? (
          // Per-day values are all projections / estimates (Ocean's
          // 3h-hashrate extrapolation for income, live bid price ×
          // delivered for spend). Label them "projected" so the
          // operator reads them as forecasts rather than facts. The
          // exceptions — hashprice (current market break-even) and
          // ocean lifetime (actual earnings) — keep their existing
          // plain labels.
          //
          // Rows always render once we're past the initial loading
          // gate — hiding them on transient nulls (Ocean hasn't
          // reported yet, bid stopped filling this tick, etc.) made
          // the panel look broken whenever one piece was missing.
          // "calculating…" makes the loading state explicit instead
          // of a silent empty panel.
          <div className="space-y-1.5 text-sm font-mono">
            {/* Inputs — the averages that the projections below
                multiply. Surfaced explicitly so projected income /
                spend / net read as derivations, not magic numbers.
                Hidden when rangeFallback is active because the
                fallback path uses current bid × 3h hashrate instead,
                not the range averages. */}
            {!rangeFallback && rangeData && (
              <>
                <FinanceFootnote
                  label={t`avg delivered (${rangeLabel})`}
                  value={
                    rangeData.avg_delivered_ph !== null
                      ? formatHashratePH(rangeData.avg_delivered_ph, intlLocale)
                      : t`calculating…`
                  }
                  tooltip={t`Average delivered hashrate over the selected chart range. Multiplied by avg hashprice to get projected income. Spend is measured directly (primary_bid_consumed_sat deltas), so this is not a factor on the spend side.`}
                />
                <FinanceFootnote
                  label={t`avg hashprice (${rangeLabel})`}
                  value={
                    rangeData.avg_hashprice_sat_per_ph_day !== null
                      ? denomination.formatSatPerPhDay(
                          rangeData.avg_hashprice_sat_per_ph_day,
                          intlLocale,
                        )
                      : t`calculating…`
                  }
                  tooltip={t`Average break-even unit price over the selected range. Multiplied by avg delivered to get projected income. Different from the spot hashprice row below — this is what the projection actually uses.`}
                />
              </>
            )}
            {/* Derivations — built from the three averages above. */}
            <div
              className={
                !rangeFallback && rangeData
                  ? 'pt-2 mt-2 border-t border-slate-800 space-y-1.5'
                  : 'space-y-1.5'
              }
            >
            <FinanceFootnote
              label={t`projected income/day (${rangeLabel})`}
              value={
                projectedDailyIncomeSat !== null
                  ? denomination.formatSat(Math.round(projectedDailyIncomeSat), intlLocale)
                  : rangeFallback
                    ? t`insufficient history`
                    : t`calculating…`
              }
              tooltip={t`Projection: avg hashprice × avg delivered (rows above), both averaged over the selected chart range. Range-aware counterpart to Ocean's own 3h estimate.`}
            />
            <FinanceFootnote
              label={rangeFallback ? t`spend/day (${localizedRangeLabel('3h', i18n.locale)})` : t`spend/day (${rangeLabel})`}
              value={denomination.formatSat(Math.round(dailySpendSat), intlLocale)}
              tooltip={
                rangeFallback
                  ? t`Actual sat consumed over the last 3 h, scaled to a 24h rate. Uses Braiins\u2019s authoritative primary_bid_consumed_sat counter, not a bid \u00d7 delivered model. Fallback used when the selected range has fewer than ~5 ticks.`
                  : t`Actual sat consumed across the selected range, scaled to a 24h rate. Derived from primary_bid_consumed_sat deltas (what Braiins charged us), not a modelled bid \u00d7 delivered.`
              }
            />
            <FinanceFootnote
              label={rangeFallback ? t`net/day (${localizedRangeLabel('3h', i18n.locale)})` : t`net/day (${rangeLabel})`}
              value={
                dailyNetSat !== null
                  ? denomination.mode === 'usd' && denomination.btcPrice !== null
                    ? `${dailyNetSat >= 0 ? '+' : ''}${denomination.formatSat(dailyNetSat, intlLocale)}`
                    : `${dailyNetSat >= 0 ? '+' : ''}${formatNumber(dailyNetSat, {}, intlLocale)} sat`
                  : t`calculating\u2026`
              }
              tooltip={t`Projected income \u2212 actual spend (rows above). Positive = the autopilot is profitable at current rates; negative = burning money per day. Income is a projection (avg hashprice \u00d7 avg delivered); spend is measured. Don\u2019t confuse with the lifetime net on the other panel.`}
              valueClass={dailyNetColor}
            />
            </div>
            {/* Reference rows — alternate views (pool-side estimate,
                spot hashprice, lifetime) that the projection doesn't
                derive from. */}
            <div className="pt-2 mt-2 border-t border-slate-800 space-y-1.5">
              <FinanceFootnote
                label={t`ocean est. income/day (${localizedRangeLabel('3h', i18n.locale)})`}
                value={
                  oceanDailyIncomeSat !== null
                    ? denomination.formatSat(oceanDailyIncomeSat, intlLocale)
                    : t`calculating…`
                }
                tooltip={t`Ocean's own estimate — the pool extrapolates from the address's last 3-hour hashrate and its share of pool output. Always 3h-based regardless of the chart range you've picked, so it may differ from projected income at other ranges.`}
              />
              {data.ocean?.hashprice_sat_per_ph_day != null && (
                <FinanceFootnote
                  label={t`hashprice (now)`}
                  value={denomination.formatSatPerPhDay(data.ocean.hashprice_sat_per_ph_day, intlLocale)}
                  tooltip={t`Current (spot) market break-even. Revenue per PH/s per day from mining at the current network difficulty + block reward. The avg-hashprice row above is what the projection uses; this one is the spot value right now for quick market-drift comparison.`}
                />
              )}
              {data.ocean?.lifetime_sat != null && (
                <FinanceFootnote
                  label={t`ocean lifetime`}
                  value={denomination.formatSat(data.ocean.lifetime_sat, intlLocale)}
                  tooltip={t`Total earned at this address since first share, per Ocean.`}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-600"><Trans>no active bids</Trans></div>
        )}
      </div>

      {/* Right card — lifetime totals (the actual P&L ledger) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Profit &amp; Loss · lifetime</Trans>
          </div>
          {/* refresh/rebuild controls live on the per-day card only —
              they refresh the same data, no point duplicating them */}
        </div>
        {/* The panel reads as the arithmetic of the net line: an
            explicit leading sign tells the operator which side of the
            ledger each row sits on. Spent is the only subtraction;
            Ocean + on-chain are the additions; the bottom line is the
            sum. */}
        <FinanceRow
          sign="minus"
          label={data.spent_scope === 'account' ? t`spent (whole account)` : t`spent (autopilot)`}
          value={data.spent_sat}
          tooltip={
            data.spent_scope === 'account'
              ? t`Sum of counters_committed.amount_consumed_sat across every bid on /v1/spot/bid — covers active + historical bids, including any that existed before the autopilot was switched on. May lag the latest hour of active-bid consumption (Braiins only updates committed counters on each hourly settlement tick). Switch via Config → P&L panel.`
              : t`Lifetime sum of (amount_sat − amount_remaining_sat) across every bid the autopilot has tagged. Excludes any bids placed before the autopilot was switched on. Switch to "whole account" via Config → Money panel.`
          }
        />
        {data.spent_scope === 'account' &&
          data.spent_closed_sat !== null &&
          data.spent_active_sat !== null && (
            <>
              <FinanceSubRow
                label={t`closed bids`}
                value={data.spent_closed_sat}
                tooltip={t`Sum across terminal bids — status CANCELED or FULFILLED (is_current=false). Money that has definitively left the account.`}
              />
              <FinanceSubRow
                label={t`active (in-flight)`}
                value={data.spent_active_sat}
                tooltip={t`Sum across still-running bids — status ACTIVE / PAUSED / etc. (is_current=true). Live in-flight consumption; not yet settled in Braiins' hourly ledger.`}
              />
            </>
          )}
        <FinanceRow
          sign="plus"
          label={t`unpaid earnings (Ocean)`}
          value={data.expected_sat}
          tooltip={
            data.ocean
              ? t`Ocean's Unpaid Earnings — what will land on-chain at the next payout. Threshold: ${formatSats(data.ocean.payout_threshold_sat)} sat (~0.01 BTC).`
              : t`Ocean stats unavailable.`
          }
        />
        <FinanceRow
          sign="plus"
          label={t`collected (on-chain)`}
          value={data.collected_sat}
          tooltip={
            data.collected_sat !== null
              ? t`UTXOs at the configured payout address. Read via Electrs (preferred, instant) or bitcoind RPC (slower).`
              : t`Not configured. Go to Config → On-chain payouts and select Electrs or Bitcoin Core RPC to track your on-chain balance. The net line treats missing collected as 0 so the arithmetic still reads — a blank row here is the hint that a piece of the income side isn't wired up.`
          }
        />

        <div className="mt-3 pt-3 border-t border-slate-800">
          <FinanceRow
            sign="equals"
            label={t`net`}
            value={data.net_sat}
            // Only the bottom-line gets a sentiment color — green when
            // the autopilot has paid for itself, red when it's still
            // digging out of the initial deposit. Keeps the rest of
            // the panel calm so the eye lands on the conclusion.
            valueClass={netColor}
            tooltip={t`Collected on-chain + Ocean's unpaid earnings − spent on bids. Missing collected is treated as 0 (the on-chain row still shows — so the operator sees the gap). Negative = still recouping the initial deposit.`}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * One row in the vertical money stack: label on the left, value on
 * the right (right-aligned, monospace, tabular-nums so the digits
 * line up across rows). `value=null` renders as "—".
 */
function FinanceRow({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-100',
  sign,
}: {
  label: string;
  value: number | null;
  tooltip: string;
  valueClass?: string;
  /** Leading arithmetic sign. Turns the panel into a readable sum
   *  rather than a dictionary of unrelated figures. */
  sign?: 'plus' | 'minus' | 'equals';
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  // Match the size + label-color of the standard <Row> used by the
  // sibling Hashrate-and-market and Braiins-balance cards so the three
  // panels read as a set. Only the value's *color* varies (caller can
  // override via valueClass — used for the green/red net bottom line).
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  const signChar = sign === 'plus' ? '+' : sign === 'minus' ? '−' : sign === 'equals' ? '=' : '';
  const signColor =
    sign === 'plus'
      ? 'text-emerald-400'
      : sign === 'minus'
        ? 'text-red-400'
        : 'text-slate-500';
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-sm py-0.5 gap-2">
        {sign && (
          <span
            className={`font-mono tabular-nums w-3 text-center ${signColor}`}
            aria-hidden="true"
          >
            {signChar}
          </span>
        )}
        <span className="text-slate-400 flex-1">{label}</span>
        <span className={`font-mono ${valueClass}`}>
          {value === null ? (
            '\u2014'
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Indented sub-line under a main FinanceRow. Used to break "spent
 * (whole account)" into its closed vs active halves without competing
 * for visual weight with the top-level additions and subtraction.
 * No arithmetic sign — it's a breakdown, not another operand.
 */
function FinanceSubRow({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: number | null;
  tooltip: string;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-[11px] py-0 pl-7 gap-2 text-slate-500">
        <span className="flex-1">{label}</span>
        <span className="font-mono">
          {value === null ? (
            '\u2014'
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-600 text-[10px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

function FinanceFootnote({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-300',
}: {
  label: string;
  value: string;
  tooltip: string;
  valueClass?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className={`text-right ${valueClass}`}>
          {split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            value
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Turn Ocean's "Estimated Time Until Minimum Payout" string ("11 days",
 * "5 hours", "Below threshold", etc.) into a footnote value that
 * includes both the raw text and a concrete date — easier to plan
 * around than counting days mentally.
 *
 * Falls back to the raw text if it can't be parsed (e.g. "Below
 * threshold" when the rate is so low Ocean refuses to estimate, or
 * any future format we haven't seen yet).
 */
function formatNextPayout(raw: string, intlLocale: string | undefined): string {
  const ms = parseDurationMs(raw);
  if (ms === null || ms <= 0) return localizeDurationRaw(raw);
  const eta = new Date(Date.now() + ms);
  const date = new Intl.DateTimeFormat(intlLocale, {
    day: '2-digit',
    month: 'short',
  }).format(eta);
  return `${localizeDurationRaw(raw)} · ~${date}`;
}

// Ocean's API hands us short English duration strings like "11 days",
// "5 hours", "30 minutes". Translate each unit while preserving the
// number; preserves any unrecognised raw form unchanged so a future
// API surprise doesn't render blank.
function localizeDurationRaw(raw: string): string {
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return raw;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const plural = n !== 1;
  switch (unit) {
    case 'minute':
      return plural ? t`${n} minutes` : t`${n} minute`;
    case 'hour':
      return plural ? t`${n} hours` : t`${n} hour`;
    case 'day':
      return plural ? t`${n} days` : t`${n} day`;
    case 'week':
      return plural ? t`${n} weeks` : t`${n} week`;
    case 'month':
      return plural ? t`${n} months` : t`${n} month`;
  }
  return raw;
}

const DURATION_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

function parseDurationMs(raw: string): number | null {
  // Ocean uses friendly units: "11 days", "5 hours", "30 minutes",
  // "2 weeks". Single + plural; case-insensitive on the unit.
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const u = DURATION_UNIT_MS[m[2].toLowerCase()];
  return u ? n * u : null;
}

function DatumPanel({
  url,
  reachable,
  consecutiveFailures,
  datum,
  nextTickAt,
}: {
  url: string;
  reachable: boolean;
  consecutiveFailures: number;
  datum: StatusResponse['datum'];
  nextTickAt: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const { i18n } = useLingui();
  void i18n;

  // Split the pool URL into scheme / host / port so the card doesn't
  // wrap an unreadable 60-character string. Pool URLs on Ocean look
  // like stratum+tcp://alkimia.mynetgear.com:23334 — we care about
  // the host most, the scheme rarely, the port sometimes. Rendering
  // three aligned rows beats a wrapped monofont URL every time.
  const urlParts = splitPoolUrl(url);
  const copy = async () => {
    try {
      await copyToClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard fell back to execCommand and still failed; no-op */
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">Datum Gateway</div>
        <div className="text-[11px] text-slate-500 font-mono">
          <RefreshCountdown nextAtMs={nextTickAt} refetchQueryKey={STATUS_QUERY_KEY} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ReachabilityBadge
          label={t`stratum reachable`}
          reachable={reachable}
          downLabel={t`stratum DOWN (${consecutiveFailures} consecutive)`}
          title={t`TCP probe of the Datum gateway's stratum port.`}
        />
        {datum && (
          <ReachabilityBadge
            label={t`API reachable`}
            reachable={datum.reachable}
            downLabel={t`API unreachable (${datum.consecutive_failures})`}
            title={t`Datum /umbrel-api HTTP poll.`}
          />
        )}
      </div>
      {datum ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400"><Trans>datum hashrate</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {datum.hashrate_ph !== null ? formatHashratePH(datum.hashrate_ph) : '—'}
          </div>
          <div className="text-slate-400"><Trans>workers connected</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {datum.connections ?? '—'}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          <Trans>
            Datum stats not configured — set <span className="font-mono text-slate-400">datum_api_url</span>{' '}
            in Config to display connected workers and reported hashrate. See{' '}
            <span className="font-mono text-slate-400">docs/setup-datum-api.md</span>.
          </Trans>
        </div>
      )}
      {/* Pool info lives at the bottom — stratum URL rarely changes
          after initial setup, so it deserves less visual weight than
          the live numbers above. Icon-only copy button keeps the
          footprint small. */}
      <div className="mt-3 pt-2 border-t border-slate-800">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>pool</Trans></div>
          <button
            onClick={copy}
            aria-label={copied ? t`copied URL` : t`copy URL`}
            title={copied ? t`copied URL` : t`copy URL`}
            className={
              'shrink-0 p-1 rounded border border-slate-700 hover:bg-slate-800 ' +
              (copied ? 'text-emerald-300' : 'text-slate-400')
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400"><Trans>protocol</Trans></div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.scheme ?? '\u2014'}
          </div>
          <div className="text-slate-400"><Trans>host</Trans></div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.host ?? '\u2014'}
          </div>
          <div className="text-slate-400"><Trans>port</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {urlParts.port ?? '\u2014'}
          </div>
        </div>
      </div>
    </div>
  );
}

function BidProgress({ pct }: { pct: number | null }) {
  if (pct === null || pct === undefined) return <span className="text-slate-600 text-xs">—</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs text-slate-400 font-mono tabular-nums w-9 text-right">
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

/**
 * Parse a pool URL like `stratum+tcp://alkimia.example.com:23334`
 * into its three human-readable pieces. Any part that can't be
 * extracted comes back null (the component renders "—" for missing
 * pieces). This is cosmetic-only — the copy button still copies the
 * original unparsed string.
 */
function splitPoolUrl(url: string): {
  scheme: string | null;
  host: string | null;
  port: string | null;
} {
  if (!url) return { scheme: null, host: null, port: null };
  const schemeMatch = /^([a-zA-Z][\w+.-]*):\/\//.exec(url);
  const scheme = schemeMatch ? schemeMatch[1] : null;
  const rest = schemeMatch ? url.slice(schemeMatch[0].length) : url;
  const [hostPart, portPart] = rest.split(':', 2);
  return {
    scheme: scheme ?? null,
    host: hostPart || null,
    port: portPart ? portPart.split('/')[0] || null : null,
  };
}

function Card({
  title,
  nextRefreshAtMs,
  refetchQueryKey,
  badges,
  children,
}: {
  title: string;
  /** When set, renders a "refreshes in X" countdown in the header. */
  nextRefreshAtMs?: number | null;
  /** Query key to invalidate when the countdown hits zero. */
  refetchQueryKey?: readonly unknown[];
  /** Optional reachability pills rendered under the title. */
  badges?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">{title}</div>
        {nextRefreshAtMs != null && (
          <div className="text-[11px] text-slate-500 font-mono">
            <RefreshCountdown nextAtMs={nextRefreshAtMs} refetchQueryKey={refetchQueryKey} />
          </div>
        )}
      </div>
      {badges && <div className="flex items-center gap-2 mb-2 flex-wrap">{badges}</div>}
      {children}
    </div>
  );
}

/**
 * Renders a pre-formatted value string (e.g. "45,662 sat/PH/day")
 * with the unit muted and the "sat" word replaced by the icon.
 * Use this anywhere a denomination-formatted string is rendered
 * outside of Row/FinanceRow/StatCard (which do their own splitting).
 */
function FormattedValue({ v, className = '' }: { v: string; className?: string }) {
  const split = splitUnit(v);
  if (!split) return <span className={className}>{v}</span>;
  return (
    <span className={className}>
      {split.num}
      <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
    </span>
  );
}

/**
 * Renders a unit string with "sat" replaced by the ₿-style sat
 * symbol icon. Handles "sat", "sat/PH/day", "PH/s" (no replacement
 * for non-sat units). Only applies in sats mode — USD values like
 * "$4.75/PH/day" don't match splitUnit so they render as plain text.
 */
function SatUnit({ unit }: { unit: string }) {
  const { i18n } = useLingui();
  void i18n;
  // Replace the `/PH/day` slug with the localized form before
  // rendering. Done as a string substitution rather than a wholesale
  // <Trans> because `unit` may also carry trailing parenthetical hints
  // (e.g. "(in this range)") that we don't want to lose.
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

/**
 * Key-value row used across all info cards. Detects trailing unit
 * suffixes (sat, PH/s, sat/PH/day) and renders them in a muted
 * smaller style so the number pops and the unit recedes — matching
 * the aesthetic the Money panel's FinanceRow already uses.
 */
function Row({ k, v }: { k: string; v: string }) {
  const split = splitUnit(v);
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-slate-400">{k}</span>
      <span className="text-slate-100 font-mono">
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
          </>
        ) : (
          v
        )}
      </span>
    </div>
  );
}

/**
 * Variant of {@link Row} whose value is a link opening in a new tab.
 * Used by the Ocean panel's "last pool block" row to jump into the
 * configured block explorer (issue #22).
 */
function LinkRow({ k, v, href }: { k: string; v: string; href: string }) {
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-slate-400">{k}</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 hover:text-sky-300 font-mono"
      >
        {v}
      </a>
    </div>
  );
}

/**
 * Split a pre-formatted display value like "45,662 sat/PH/day" into
 * `{ num: "45,662", unit: "sat/PH/day" }` so the caller can render
 * the unit in a muted style. Also handles USD-denominated strings
 * like "$4.75/PH/day" (splits at the /PH/day suffix) and "$1.28 sat"
 * equivalents. Returns null for values without a recognised unit suffix.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  // Order matters: longest match first so "sat/PH/day" isn't
  // partially matched as "sat".
  // Also match USD-denominated /PH/day suffix (e.g. "$4.75/PH/day").
  const m = v.match(/^(.+?)\s+(sat\/PH\/day|PH\/s|PH·h|sat)(\s*(?:\(.*\))?)$/);
  if (m?.[1] && m[2]) return { num: m[1], unit: m[2] + (m[3] ?? '') };
  // USD with /PH/day suffix: "$4.75/PH/day" → { num: "$4.75", unit: "/PH/day" }
  const usdPhDay = v.match(/^(.+?)(\/PH\/day)$/);
  if (usdPhDay?.[1] && usdPhDay[2]) return { num: usdPhDay[1], unit: usdPhDay[2] };
  return null;
}

function ProposalLine({ p }: { p: ProposalView }) {
  const badge =
    p.executed === 'EXECUTED'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
      : p.executed === 'DRY_RUN'
        ? 'bg-sky-900/40 text-sky-300 border-sky-800'
        : p.executed === 'BLOCKED'
          ? 'bg-red-900/40 text-red-300 border-red-800'
          : 'bg-amber-900/40 text-amber-300 border-amber-800';
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <span className={`inline-block font-mono text-xs uppercase mr-2 border rounded px-1.5 ${badge}`}>
        {p.executed.toLowerCase().replace('_', ' ')}
      </span>
      <span className="text-slate-100">{p.summary}</span>
      {p.gate_reason && <span className="text-xs text-red-400 ml-2">({p.gate_reason})</span>}
    </div>
  );
}

function RunModeToggle({
  current,
  onChange,
  disabled,
}: {
  current: StatusResponse['run_mode'];
  onChange: (m: (typeof RUN_MODES)[number]) => void;
  disabled: boolean;
}) {
  const { i18n } = useLingui();
  void i18n;
  const labelFor = (m: (typeof RUN_MODES)[number]) => {
    switch (m) {
      case 'DRY_RUN':
        return t`DRY RUN`;
      case 'LIVE':
        return t`LIVE`;
      case 'PAUSED':
        return t`PAUSED`;
    }
  };
  return (
    <div className="inline-flex gap-1.5 bg-slate-950/70 border border-slate-800 rounded-xl p-1.5 mt-5">
      {RUN_MODES.map((m) => {
        const active = m === current;
        return (
          <button
            key={m}
            disabled={disabled || active}
            onClick={() => onChange(m)}
            className={
              'px-5 py-2.5 text-sm rounded-lg transition font-medium tracking-wide ' +
              (active
                ? 'bg-amber-400 text-slate-900'
                : 'text-slate-300 hover:bg-slate-800 disabled:opacity-50')
            }
          >
            {labelFor(m)}
          </button>
        );
      })}
    </div>
  );
}

// Silence linter — ModeBadge is imported for consistency elsewhere in the app.
void ModeBadge;