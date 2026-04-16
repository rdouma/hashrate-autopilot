import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@braiins-hashrate/shared';

import { HashrateChart } from '../components/HashrateChart';
import { PriceChart } from '../components/PriceChart';
import { ModeBadge } from '../components/ModeBadge';
import {
  api,
  UnauthorizedError,
  type BidEventView,
  type FinanceResponse,
  type MetricPoint,
  type NextActionView,
  type ProposalView,
  type StatusResponse,
} from '../lib/api';
import {
  formatAge,
  formatHashratePH,
  formatNumber,
  formatSatPerPH,
  formatSats,
  formatTimestamp,
  formatTimestampUtc,
} from '../lib/format';
import { actionModeLabel, bidStatusClass, bidStatusLabel } from '../lib/labels';
import { useLocale } from '../lib/locale';

const RUN_MODES = ['DRY_RUN', 'LIVE', 'PAUSED'] as const;
const CHART_RANGE_STORAGE_KEY = 'hashrate-chart-range';

function readStoredChartRange(): ChartRange {
  if (typeof window === 'undefined') return DEFAULT_CHART_RANGE;
  return parseChartRange(window.localStorage.getItem(CHART_RANGE_STORAGE_KEY)) ?? DEFAULT_CHART_RANGE;
}

export function Status() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();

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

  const bumpMutation = useMutation({
    mutationFn: () => api.bumpPrice(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['status'] });
      qc.invalidateQueries({ queryKey: ['decisions'] });
    },
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

  const financeQuery = useQuery({
    queryKey: ['finance'],
    queryFn: api.finance,
    // Money is a slow-moving summary — earnings per day, lifetime
    // figures, ocean stats. Hourly refresh is plenty; the operator can
    // hit the refresh button on the panel for an immediate pull.
    refetchInterval: 3_600_000,
  });

  // Operator availability removed from the UI (API bids bypass 2FA;
  // see research.md §0.9). Backend field remains in case Braiins
  // changes policy. The endpoint still exists for future use.

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (query.isLoading) return <div className="text-slate-400">loading…</div>;
  if (!query.data) {
    return <div className="text-red-400">failed to load: {(query.error as Error)?.message}</div>;
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
            onBump={() => bumpMutation.mutate()}
            bumpPending={bumpMutation.isPending}
            bumpResult={bumpMutation.data}
            escalationStepSatPerPh={s.config_summary.fill_escalation_step_sat_per_ph_day}
          />
        </div>
      </section>

      <HashrateChart
        points={metricsQuery.data?.points ?? []}
        range={chartRange}
        onRangeChange={setChartRange}
      />
      <PriceChart
        points={metricsQuery.data?.points ?? []}
        events={bidEventsQuery.data?.events ?? []}
        showEvents={CHART_RANGE_SPECS[chartRange].showEvents}
      />

      <StatsBar
        points={metricsQuery.data?.points ?? []}
        events={bidEventsQuery.data?.events ?? []}
      />

      {/* Three-column row: market context | Braiins wallet | financial
          P&L. Money panel reads top-to-bottom (cost → incomes → net).
          On narrow screens the columns stack. */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card title="Hashrate & market">
          <Row k="delivered" v={formatHashratePH(s.actual_hashrate_ph)} />
          <Row k="target" v={formatHashratePH(s.config_summary.target_hashrate_ph)} />
          <Row k="floor" v={formatHashratePH(s.config_summary.minimum_floor_hashrate_ph)} />
          {s.below_floor_since && (
            <div className="text-xs text-amber-400 mt-1">
              below floor since {formatAge(s.below_floor_since)}
            </div>
          )}
          <div className="border-t border-slate-800 mt-2 pt-2">
            <Row k="best bid" v={formatSatPerPH(s.market?.best_bid_sat_per_ph_day ?? null)} />
            <Row k="best ask" v={formatSatPerPH(s.market?.best_ask_sat_per_ph_day ?? null)} />
            <Row
              k={`fillable @ ${formatHashratePH(s.config_summary.target_hashrate_ph)}`}
              v={
                s.market?.fillable_ask_sat_per_ph_day != null
                  ? formatSatPerPH(s.market.fillable_ask_sat_per_ph_day) +
                    (s.market.fillable_thin ? ' (thin)' : '')
                  : '—'
              }
            />
          </div>
        </Card>
        <Card title="Braiins balance">
          {s.balances.length === 0 ? (
            <div className="text-slate-500 text-sm">—</div>
          ) : (
            s.balances.map((b) => (
              <div key={b.subaccount}>
                <Row k="available" v={formatSats(b.available_balance_sat)} />
                <Row k="blocked" v={formatSats(b.blocked_balance_sat)} />
                <Row k="total" v={formatSats(b.total_balance_sat)} />
              </div>
            ))
          )}
        </Card>
        <FinancePanel
          data={financeQuery.data}
          status={s}
          onRefresh={() => qc.invalidateQueries({ queryKey: ['finance'] })}
          refreshing={financeQuery.isFetching}
        />
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">Bids</h3>
        {s.bids.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-slate-500 text-sm">
            no bids on this account
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 bg-slate-900/50">
                <tr>
                  <th className="text-left py-2 px-3">id</th>
                  <th className="text-left py-2 px-3">owner</th>
                  <th className="text-left py-2 px-3">created</th>
                  <th className="text-right py-2 px-3">price</th>
                  <th className="text-right py-2 px-3">delivered / cap</th>
                  <th className="text-right py-2 px-3">budget</th>
                  <th className="text-left py-2 px-3 w-32">progress</th>
                  <th className="text-left py-2 px-3">status</th>
                </tr>
              </thead>
              <tbody>
                {s.bids.map((b) => (
                  <tr key={b.braiins_order_id} className="border-t border-slate-800">
                    <td className="py-2 px-3 font-mono text-xs">
                      {b.braiins_order_id.slice(0, 10)}…
                    </td>
                    <td className="py-2 px-3">
                      {b.is_owned ? (
                        <span className="text-emerald-400">autopilot</span>
                      ) : (
                        <span className="text-amber-400">unknown</span>
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
                    <td className="py-2 px-3 text-right">
                      {formatSatPerPH(b.price_sat_per_ph_day)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatHashratePH(b.avg_speed_ph)}
                      <span className="text-xs text-slate-500">
                        {' '}
                        / {b.speed_limit_ph ? formatHashratePH(b.speed_limit_ph) : '∞'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatNumber(b.amount_sat, {}, intlLocale)}
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

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <PoolCard
          url={s.config_summary.pool_url}
          reachable={s.pool.reachable}
          consecutiveFailures={s.pool.consecutive_failures}
          lastOkAt={s.pool.last_ok_at}
        />
        <Card title="Caps">
          <Row k="max bid" v={formatSatPerPH(s.config_summary.max_bid_sat_per_ph_day)} />
          <Row k="budget" v={formatSats(s.config_summary.bid_budget_sat)} />
        </Card>
      </section>

      {s.last_proposals.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">Last tick proposals</h3>
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

function OperationsCard({
  s,
  onRunMode,
  runModePending,
}: {
  s: StatusResponse;
  onRunMode: (m: (typeof RUN_MODES)[number]) => void;
  runModePending: boolean;
}) {
  const { intlLocale } = useLocale();

  const heroColors: Record<StatusResponse['run_mode'], string> = {
    DRY_RUN: 'from-sky-900/60 to-sky-950/40 border-sky-700/40',
    LIVE: 'from-emerald-900/60 to-emerald-950/40 border-emerald-700/40',
    PAUSED: 'from-amber-900/60 to-amber-950/40 border-amber-700/40',
  };

  const actionVisible = s.action_mode !== 'NORMAL';

  // Effective rate across all owned active bids, weighted by delivered
  // hashrate (avg_speed_ph). That's the true "what am I paying right now"
  // number when more than one bid is open. Falls back to a simple price
  // average if nothing is being delivered yet (all bids freshly created).
  const activeOwned = s.bids.filter(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const totalDelivered = activeOwned.reduce((sum, b) => sum + b.avg_speed_ph, 0);
  let currentPricePH: number | null = null;
  if (activeOwned.length > 0) {
    if (totalDelivered > 0) {
      currentPricePH =
        activeOwned.reduce((sum, b) => sum + b.price_sat_per_ph_day * b.avg_speed_ph, 0) /
        totalDelivered;
    } else {
      currentPricePH =
        activeOwned.reduce((sum, b) => sum + b.price_sat_per_ph_day, 0) / activeOwned.length;
    }
  }

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
          <div className="flex flex-col items-center">
            <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1">price</div>
            {/* relative wrapper so the ±delta can be position:absolute
                outside the flow — that way the big number stays centered
                regardless of how wide the badge gets (e.g. "+9" vs "+126"). */}
            <div className="relative leading-none">
              <span className="text-4xl font-mono font-semibold text-slate-100 tabular-nums">
                {formatNumber(Math.round(currentPricePH), {}, intlLocale)}
              </span>
              <span className="absolute left-full top-1/2 -translate-y-1/2 ml-1.5 whitespace-nowrap">
                <PriceDeltaVsFillable
                  currentPH={currentPricePH}
                  fillablePH={s.market?.fillable_ask_sat_per_ph_day ?? null}
                  intlLocale={intlLocale}
                />
              </span>
            </div>
            <div className="text-xs text-slate-400 mt-1">
              sat/PH/day
              {activeOwned.length > 1 ? ` · avg/${activeOwned.length}` : ''}
            </div>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1">delivered</div>
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
          <div className="text-xs text-slate-400 mt-0.5">no active bid</div>
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

function NextActionCard({
  s,
  onTickNow,
  tickPending,
  tickResult,
  onBump,
  bumpPending,
  bumpResult,
  escalationStepSatPerPh,
}: {
  s: StatusResponse;
  onTickNow: () => void;
  tickPending: boolean;
  tickResult: { ok: boolean; error?: string; proposals?: number } | undefined;
  onBump: () => void;
  bumpPending: boolean;
  bumpResult:
    | { ok: boolean; error?: string; new_price_sat_per_eh_day?: number }
    | undefined;
  escalationStepSatPerPh: number;
}) {
  const { intlLocale } = useLocale();
  const canBump = s.run_mode === 'LIVE' && s.bids.some((b) => b.is_owned);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-full flex flex-col">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-1">Next action</h3>
        <JustExecutedBanner last={s.next_action.last_executed} />
        <div className="text-slate-100">{s.next_action.summary}</div>
        {s.next_action.detail && (
          <div className="text-xs text-slate-400 mt-1">{s.next_action.detail}</div>
        )}
        <NextActionProgress next={s.next_action} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onTickNow}
          disabled={tickPending}
          title="Run a full observe-decide-execute tick now, instead of waiting for the next interval blip."
          className="px-3 py-1.5 text-xs rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {tickPending ? 'ticking…' : 'Run decision now'}
        </button>
        <button
          onClick={onBump}
          disabled={bumpPending || !canBump}
          title={
            canBump
              ? 'Manually raise the current bid by one escalation step (overrides the auto-edit lock for one tick).'
              : 'Requires LIVE mode with an owned bid.'
          }
          className="px-3 py-1.5 text-xs rounded border border-amber-800 text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
        >
          {bumpPending
            ? 'bumping…'
            : `Bump price +${formatNumber(escalationStepSatPerPh)} sat/PH/day`}
        </button>
      </div>

      {tickResult && (
        <div
          className={
            'mt-2 text-xs ' + (tickResult.ok ? 'text-emerald-300' : 'text-red-400')
          }
        >
          {tickResult.ok
            ? `tick ok — ${tickResult.proposals ?? 0} proposals`
            : `tick failed: ${tickResult.error}`}
        </div>
      )}
      {bumpResult && (
        <div
          className={
            'mt-2 text-xs ' + (bumpResult.ok ? 'text-emerald-300' : 'text-red-400')
          }
        >
          {bumpResult.ok
            ? `price bumped to ${formatNumber(
                Math.round((bumpResult.new_price_sat_per_eh_day ?? 0) / 1000),
                {},
                intlLocale,
              )} sat/PH/day`
            : `bump failed: ${bumpResult.error}`}
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
        last tick:{' '}
        <span className="text-slate-400">
          {tickAt !== null ? formatTimestamp(tickAt) : '—'}
        </span>
        {tickAt !== null && (
          <span className="ml-1 text-slate-600">({formatAge(tickAt)})</span>
        )}
      </span>
      <span>
        next in{' '}
        <span className="text-slate-300 tabular-nums">
          {remainingSec !== null ? `${remainingSec}s` : '—'}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Price-vs-fillable delta indicator (hero card)
// ---------------------------------------------------------------------------

/**
 * Stock-ticker style ±delta vs the depth-aware fillable ask, rendered
 * inline next to the big price number. Hover for the full explanation.
 */
function PriceDeltaVsFillable({
  currentPH,
  fillablePH,
  intlLocale,
}: {
  currentPH: number;
  fillablePH: number | null;
  intlLocale: string | undefined;
}) {
  if (fillablePH === null) return null;
  const delta = Math.round(currentPH - fillablePH);
  const fillablePretty = formatNumber(Math.round(fillablePH), {}, intlLocale);

  if (delta === 0) {
    return (
      <span
        className="text-xs font-mono text-slate-400 cursor-help"
        title={`Paying exactly the fillable ask (${fillablePretty} sat/PH/day) — the cheapest price at which the full target hashrate is available.`}
      >
        ±0
      </span>
    );
  }

  const sign = delta > 0 ? '+' : '−';
  // Overpaying = red; underpaying (rare, mid-market move) = emerald.
  const color = delta > 0 ? 'text-red-300' : 'text-emerald-300';
  const verb = delta > 0 ? 'over' : 'under';
  const tooltip =
    `Currently paying ${sign}${formatNumber(Math.abs(delta), {}, intlLocale)} sat/PH/day ` +
    `${verb} the fillable ask (${fillablePretty}) (the cheapest price at which ` +
    `your full target hashrate is available in the orderbook).`;

  return (
    <span className={`text-xs font-mono ${color} cursor-help`} title={tooltip}>
      {sign}
      {formatNumber(Math.abs(delta), {}, intlLocale)}
    </span>
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

const EVENT_LABELS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'Escalation in',
  lower_after_override: 'Override lock clears in',
  lower_after_cooldown: 'Cooldown clears in',
};

const EVENT_COLORS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'bg-amber-400',
  lower_after_override: 'bg-sky-400',
  lower_after_cooldown: 'bg-sky-400',
};

function NextActionProgress({ next }: { next: NextActionView }) {
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
  const label = EVENT_LABELS[next.event_kind!];
  const fillColor = overdue ? 'bg-red-400' : EVENT_COLORS[next.event_kind!];

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-[11px] text-slate-400 mb-1 font-mono">
        <span>{label}</span>
        <span className={overdue ? 'text-red-300' : ''}>
          {overdue ? `overdue ${formatRemaining(now - end)}` : formatRemaining(remainingMs)}
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

/**
 * Four KPIs computed client-side from the same tick_metrics +
 * bid_events the charts already consume. Responds to the chart range
 * filter so the operator can compare stats across 6h/24h/1w etc.
 * when tuning escalation window, overpay, and lowering parameters.
 */
function StatsBar({
  points,
  events,
}: {
  points: readonly MetricPoint[];
  events: readonly BidEventView[];
}) {
  const { intlLocale } = useLocale();
  if (points.length < 2) return null;

  // 1. Uptime % — fraction of ticks with delivered hashrate > 0
  const hashingTicks = points.filter((p) => p.delivered_ph > 0).length;
  const uptimePct = (hashingTicks / points.length) * 100;

  // 2. Avg overpay vs fillable — how much more we paid than the depth-aware market price
  const overpayPairs = points.filter(
    (p) =>
      Number.isFinite(p.our_primary_price_sat_per_ph_day) &&
      Number.isFinite(p.fillable_ask_sat_per_ph_day),
  );
  const avgOverpay =
    overpayPairs.length > 0
      ? overpayPairs.reduce(
          (s, p) => s + (p.our_primary_price_sat_per_ph_day! - p.fillable_ask_sat_per_ph_day!),
          0,
        ) / overpayPairs.length
      : null;

  // 3. Avg cost per PH delivered — weighted average price across all delivering ticks
  const delivering = points.filter(
    (p) => p.delivered_ph > 0 && Number.isFinite(p.our_primary_price_sat_per_ph_day),
  );
  const totalWeighted = delivering.reduce(
    (s, p) => s + p.our_primary_price_sat_per_ph_day! * p.delivered_ph,
    0,
  );
  const totalPh = delivering.reduce((s, p) => s + p.delivered_ph, 0);
  const avgCostPerPh = totalPh > 0 ? totalWeighted / totalPh : null;

  // 4. Avg time-to-fill after CREATE/EDIT events — how long from an
  //    event until the next tick with delivered_ph > 0. Measures how
  //    quickly the market fills our bids at current settings.
  const fillable = events.filter(
    (e) => e.kind === 'CREATE_BID' || e.kind === 'EDIT_PRICE',
  );
  const fillTimes: number[] = [];
  for (const ev of fillable) {
    const firstFill = points.find(
      (p) => p.tick_at > ev.occurred_at && p.delivered_ph > 0,
    );
    if (firstFill) {
      fillTimes.push(firstFill.tick_at - ev.occurred_at);
    }
  }
  const avgFillMs =
    fillTimes.length > 0
      ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
      : null;

  const fmt = (n: number) => formatNumber(Math.round(n), {}, intlLocale);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3">
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <StatChip
          label="uptime"
          value={`${uptimePct.toFixed(1)}%`}
          tooltip="% of ticks in this range with delivered hashrate > 0. Low = bids not filling or escalation too slow."
          color={uptimePct >= 90 ? 'text-emerald-300' : uptimePct >= 50 ? 'text-amber-300' : 'text-red-300'}
        />
        <StatChip
          label="avg overpay vs fillable"
          value={avgOverpay !== null ? `${fmt(avgOverpay)} sat/PH/day` : '—'}
          tooltip="Average of (our price − fillable ask) across ticks where both are known. High = overpay too generous or lowering too slow."
        />
        <StatChip
          label="avg cost / PH delivered"
          value={avgCostPerPh !== null ? `${fmt(avgCostPerPh)} sat/PH/day` : '—'}
          tooltip="Weighted average price across all delivering ticks: sum(price × delivered) / sum(delivered). The efficiency metric."
        />
        <StatChip
          label="avg time to fill"
          value={avgFillMs !== null ? formatFillTime(avgFillMs) : '—'}
          tooltip="Average time from a CREATE/EDIT event to the first tick with delivered hashrate > 0. Measures how quickly the market fills at your current settings."
        />
      </div>
    </section>
  );
}

function StatChip({
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
    <div className="cursor-help" title={tooltip}>
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono ${color}`}>
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1">{split.unit}</span>
          </>
        ) : (
          value
        )}
      </div>
    </div>
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
function TickingAge({ epochMs }: { epochMs: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return <span>updated {formatAge(epochMs)}</span>;
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
function FinancePanel({
  data,
  status,
  onRefresh,
  refreshing,
}: {
  data: FinanceResponse | undefined;
  status: StatusResponse;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { intlLocale } = useLocale();

  if (!data) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2">Money</div>
        <div className="text-slate-500 text-sm">loading…</div>
      </section>
    );
  }

  const netColor =
    data.net_sat === null
      ? 'text-slate-400'
      : data.net_sat >= 0
        ? 'text-emerald-300'
        : 'text-red-300';

  // Run-rate view: what's this autopilot costing/earning *right now*,
  // per day? Distinct from the lifetime P&L above. Sum across active
  // owned bids of (price × delivered_hashrate) — Braiins only debits
  // for hashrate actually delivered, so avg_speed_ph (not speed_limit)
  // is the truthful "what am I being charged for" multiplier.
  const ownedActive = status.bids.filter(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const dailySpendSat = ownedActive.reduce(
    (sum, b) => sum + b.price_sat_per_ph_day * b.avg_speed_ph,
    0,
  );
  const hasDailySpend = ownedActive.length > 0 && dailySpendSat > 0;
  const dailyIncomeSat = data.ocean?.daily_estimate_sat ?? null;
  const dailyNetSat =
    hasDailySpend && dailyIncomeSat !== null
      ? Math.round(dailyIncomeSat - dailySpendSat)
      : null;
  const dailyNetColor =
    dailyNetSat === null
      ? ''
      : dailyNetSat >= 0
        ? 'text-emerald-300'
        : 'text-red-300';

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs uppercase tracking-wider text-slate-100">Money</div>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <TickingAge epochMs={data.checked_at_ms} />
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
            title="Refresh the money panel now (normally updates hourly)."
          >
            {refreshing ? '…' : '↻'}
          </button>
        </div>
      </div>

      <FinanceRow
        label={data.spent_scope === 'account' ? 'spent (whole account)' : 'spent (autopilot)'}
        value={data.spent_sat}
        tooltip={
          data.spent_scope === 'account'
            ? 'Sum of every "(Partial) order settlement (brutto price)" on /v1/account/transaction — covers all bids the Braiins account has ever settled, including any that existed before the autopilot was switched on. Switch via Config → Money panel.'
            : 'Lifetime sum of (amount_sat − amount_remaining_sat) across every bid the autopilot has tagged. Excludes any bids placed before the autopilot was switched on. Switch to "whole account" via Config → Money panel.'
        }
      />
      <FinanceRow
        label="expected (Ocean)"
        value={data.expected_sat}
        tooltip={
          data.ocean
            ? `Ocean's Unpaid Earnings — what will land on-chain at the next payout. Threshold: ${formatSats(data.ocean.payout_threshold_sat)} sat (~0.01 BTC).`
            : 'Ocean stats unavailable.'
        }
      />
      <FinanceRow
        label="collected (on-chain)"
        value={data.collected_sat}
        tooltip="UTXOs at the configured payout address. Read via Electrs (preferred, instant) or bitcoind RPC (slower)."
      />

      <div className="mt-3 pt-3 border-t border-slate-800">
        <FinanceRow
          label="net"
          value={data.net_sat}
          // Only the bottom-line gets a sentiment color — green when
          // the autopilot has paid for itself, red when it's still
          // digging out of the initial deposit. Keeps the rest of the
          // panel calm so the eye lands on the conclusion.
          valueClass={netColor}
          tooltip="Collected on-chain + Ocean's unpaid earnings − spent on bids. Negative = still recouping the initial deposit."
        />
      </div>

      {(data.ocean || hasDailySpend) && (
        <div className="mt-3 pt-3 border-t border-slate-800 space-y-1 text-[11px] text-slate-500 font-mono">
          {/* Run-rate: what the autopilot costs / earns *right now*
              at current bid price + delivered hashrate, vs Ocean's
              estimated daily earnings at the same hashrate. The net
              tells the operator if the autopilot is profitable per day
              under present conditions — distinct from the lifetime
              P&L above. */}
          {dailyIncomeSat !== null && (
            <FinanceFootnote
              label="income/day"
              value={`${formatNumber(dailyIncomeSat, {}, intlLocale)} sat`}
              tooltip="Ocean's estimated earnings per day at the address's 3-hour hashrate."
            />
          )}
          {hasDailySpend && (
            <FinanceFootnote
              label="spend/day"
              value={`${formatNumber(Math.round(dailySpendSat), {}, intlLocale)} sat`}
              tooltip="Cost per day at current bid price × delivered hashrate, summed across active owned bids. Braiins only debits for hashrate actually delivered, so this tracks reality (not the speed-limit cap)."
            />
          )}
          {dailyNetSat !== null && (
            <FinanceFootnote
              label="net/day"
              value={`${dailyNetSat >= 0 ? '+' : ''}${formatNumber(dailyNetSat, {}, intlLocale)} sat`}
              tooltip="Income/day − spend/day. Positive = the autopilot is profitable at current rates; negative = burning money per day. Don't confuse with the lifetime net above."
              valueClass={dailyNetColor}
            />
          )}
          {data.ocean?.lifetime_sat != null && (
            <FinanceFootnote
              label="ocean lifetime"
              value={`${formatNumber(data.ocean.lifetime_sat, {}, intlLocale)} sat`}
              tooltip="Total earned at this address since first share, per Ocean."
            />
          )}
          {data.ocean?.time_to_payout_text && (
            <FinanceFootnote
              label="next payout"
              value={formatNextPayout(data.ocean.time_to_payout_text)}
              tooltip="Ocean's estimate at the address's 3-hour hashrate until earnings cross the payout threshold (0.01048576 BTC). The timestamp is computed from this duration plus the current time — slides earlier as hashrate climbs, later as it drops."
            />
          )}
        </div>
      )}
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
}: {
  label: string;
  value: number | null;
  tooltip: string;
  valueClass?: string;
}) {
  const { intlLocale } = useLocale();
  // Match the size + label-color of the standard <Row> used by the
  // sibling Hashrate-and-market and Braiins-balance cards so the three
  // panels read as a set. Only the value's *color* varies (caller can
  // override via valueClass — used for the green/red net bottom line).
  return (
    <div
      className="cursor-help flex justify-between text-sm py-0.5"
      title={tooltip}
    >
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${valueClass}`}>
        {value === null ? (
          '—'
        ) : (
          <>
            {formatNumber(value, {}, intlLocale)}
            {/* Single muted "sat" suffix — formatSats() already appends
                one, so we use raw formatNumber here. */}
            <span className="text-slate-500 text-[11px] ml-1">sat</span>
          </>
        )}
      </span>
    </div>
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
    <div className="cursor-help flex items-baseline justify-between gap-2" title={tooltip}>
      <span>{label}</span>
      <span className={`text-right ${valueClass}`}>
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1">{split.unit}</span>
          </>
        ) : (
          value
        )}
      </span>
    </div>
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
function formatNextPayout(raw: string): string {
  const ms = parseDurationMs(raw);
  if (ms === null || ms <= 0) return raw;
  const eta = new Date(Date.now() + ms);
  const date = new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
  }).format(eta);
  return `${raw} · ~${date}`;
}

function parseDurationMs(raw: string): number | null {
  // Ocean uses friendly units: "11 days", "5 hours", "30 minutes",
  // "2 weeks". Single + plural; case-insensitive on the unit.
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const unitMs: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
  };
  const u = unitMs[m[2].toLowerCase()];
  return u ? n * u : null;
}

function PoolCard({
  url,
  reachable,
  consecutiveFailures,
  lastOkAt,
}: {
  url: string;
  reachable: boolean;
  consecutiveFailures: number;
  lastOkAt: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API may be blocked in non-secure contexts */
    }
  };

  return (
    <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-100 mb-2">Pool</div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className={
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ' +
            (reachable
              ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
              : 'border-red-700 bg-red-900/30 text-red-300')
          }
        >
          <span
            className={
              'w-1.5 h-1.5 rounded-full ' + (reachable ? 'bg-emerald-400' : 'bg-red-400')
            }
          />
          {reachable ? 'reachable' : `DOWN (${consecutiveFailures} consecutive)`}
        </span>
        <span className="text-xs text-slate-500">last ok: {formatAge(lastOkAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-sm text-slate-300 font-mono break-all flex-1">{url}</div>
        <button
          onClick={copy}
          title="Copy pool URL to clipboard"
          className="shrink-0 px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-100 mb-2">{title}</div>
      {children}
    </div>
  );
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
            <span className="text-slate-500 text-[11px] ml-1">{split.unit}</span>
          </>
        ) : (
          v
        )}
      </span>
    </div>
  );
}

/**
 * Split a pre-formatted display value like "45,662 sat/PH/day" into
 * `{ num: "45,662", unit: "sat/PH/day" }` so the caller can render
 * the unit in a muted style. Returns null for values without a
 * recognised unit suffix.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  // Order matters: longest match first so "sat/PH/day" isn't
  // partially matched as "sat".
  const m = v.match(/^(.+?)\s+(sat\/PH\/day|PH\/s|sat)(\s*(?:\(.*\))?)$/);
  if (!m || !m[1]) return null;
  return { num: m[1], unit: m[2] + (m[3] ?? '') };
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
            {m.replace('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}

// Silence linter — ModeBadge is imported for consistency elsewhere in the app.
void ModeBadge;