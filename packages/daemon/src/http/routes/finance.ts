/**
 * GET /api/finance — top-level money panel for the dashboard.
 *
 * Combines three sources into a single profit/loss view:
 *   - spent      = lifetime sum of `amount_consumed_sat` across every
 *                  bid the autopilot has ever owned (operator can also
 *                  bump a bid manually; that path also goes through
 *                  the autopilot's owned-bids ledger so it's counted).
 *   - collected  = on-chain UTXOs at the configured payout address
 *                  (electrs preferred, bitcoind fallback).
 *   - expected   = Ocean's "Unpaid Earnings" — the BTC amount that
 *                  will land at the next payout (when above threshold)
 *                  or has already been earned but is below threshold.
 *
 * net = collected + expected − spent.  Positive = autopilot is in the
 * black, negative = still digging out of the initial deposit.
 *
 * Each source can independently be `null` when its data isn't
 * available yet (Ocean down, electrs/bitcoind unconfigured, fresh
 * install with no bids). The dashboard renders "—" for nulls and
 * skips them in the net calculation (so `net` is null until both
 * collected and expected have at least one observation).
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { AccountSpendService } from '../../services/account-spend.js';
import type { HashpriceCache } from '../../services/hashprice-cache.js';
import type { OceanClient } from '../../services/ocean.js';
import type { PayoutObserver } from '../../services/payout-observer.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { TickMetricsRepo } from '../../state/repos/tick_metrics.js';

const EH_PER_PH = 1000;

/**
 * Minimum tick count within the selected window before the
 * dashboard trusts the avg-based P&L values. Below this, the UI
 * badges the card `insufficient history` and surfaces the
 * instantaneous fallback. Five ticks ≈ 5 minutes of real-time
 * data; fresh installs, heavily-pruned DBs, and post-restart
 * states all hit this.
 */
const MIN_TICKS_FOR_AVG = 5;

export interface FinanceResponse {
  readonly spent_sat: number;
  /** Which scope produced `spent_sat`. Mirrors the config field. */
  readonly spent_scope: 'autopilot' | 'account';
  /**
   * Breakdown of `spent_sat` into closed (terminal) vs active
   * (is_current) bids. Only populated under `spent_scope = 'account'`;
   * null under autopilot scope (we'd need to walk each owned bid's
   * status to split it, and it's not needed for that view). The
   * dashboard surfaces these as sub-rows under the spent line.
   */
  readonly spent_closed_sat: number | null;
  readonly spent_active_sat: number | null;
  readonly collected_sat: number | null;
  readonly expected_sat: number | null;
  readonly net_sat: number | null;
  readonly ocean: {
    readonly lifetime_sat: number | null;
    readonly daily_estimate_sat: number | null;
    readonly hashprice_sat_per_ph_day: number | null;
    readonly rewards_in_window_sat: number | null;
    readonly time_to_payout_text: string | null;
    readonly payout_threshold_sat: number;
    readonly fetched_at_ms: number | null;
  } | null;
  readonly checked_at_ms: number;
}

export interface FinanceDeps {
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly configRepo: ConfigRepo;
  readonly payoutObserver: PayoutObserver | null;
  readonly oceanClient: OceanClient | null;
  readonly accountSpend: AccountSpendService | null;
  readonly hashpriceCache: HashpriceCache | null;
  readonly tickMetricsRepo: TickMetricsRepo;
}

/**
 * Response from `/api/finance/range?range=<ChartRange>`. Feeds the
 * range-aware P&L per-day card (issue #43). Separate from `/api/finance`
 * because the two have different update cadences: lifetime values
 * come from Ocean + on-chain (hourly refresh); range values come from
 * tick_metrics (every tick). Also, this endpoint is parameterised on
 * the chart-range dropdown, which `/api/finance` is not.
 */
export interface FinanceRangeResponse {
  readonly range: ChartRange;
  readonly window_ms: number | null;
  readonly tick_count: number;
  readonly first_tick_at: number | null;
  readonly last_tick_at: number | null;
  readonly avg_hashprice_sat_per_ph_day: number | null;
  readonly avg_delivered_ph: number | null;
  /**
   * Actual sat consumed across the range, summed from per-tick
   * `primary_bid_consumed_sat` deltas. Authoritative spend — what
   * Braiins actually charged. Null when no usable deltas in range.
   */
  readonly actual_spend_sat: number | null;
  /**
   * `actual_spend_sat` scaled to a 24h rate using the covered span
   * (last_tick_at − first_tick_at). Null when span is too short to
   * trust (< MIN_TICKS_FOR_AVG ticks) or no usable spend.
   */
  readonly actual_spend_per_day_sat: number | null;
  /**
   * Derived: `avg_hashprice × avg_delivered`, in sat/day. The income
   * side is still a projection (Ocean's 3h hashrate × market
   * break-even), not a measurement — kept symmetric with the
   * previous version. Null equivalently.
   */
  readonly projected_income_per_day_sat: number | null;
  /**
   * `projected_income_per_day_sat − actual_spend_per_day_sat`. The
   * "net" the operator actually sees; positive = profitable.
   */
  readonly net_per_day_sat: number | null;
  /**
   * True when tick_count < MIN_TICKS_FOR_AVG. Dashboard badges the
   * card so the operator knows to discount these numbers; derived
   * fields above are null in that case.
   */
  readonly insufficient_history: boolean;
}

export async function registerFinanceRoute(
  app: FastifyInstance,
  deps: FinanceDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string } }>(
    '/api/finance/range',
    async (req): Promise<FinanceRangeResponse> => {
      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];
      const nowMs = Date.now();
      const sinceMs = spec.windowMs === null ? null : nowMs - spec.windowMs;

      const agg = await deps.tickMetricsRepo.rangeFinanceAggregates(sinceMs);
      const insufficient = agg.tick_count < MIN_TICKS_FOR_AVG;

      const avgHashpricePh =
        agg.avg_hashprice_sat_per_eh_day !== null
          ? agg.avg_hashprice_sat_per_eh_day / EH_PER_PH
          : null;

      // Actual spend/day = (sat spent in covered window) × 86.4M / (span ms).
      // Span comes from the actual first/last tick in range, not the
      // requested window, so a partially-populated range still reads
      // a correct daily rate.
      const spanMs =
        agg.first_tick_at !== null && agg.last_tick_at !== null
          ? agg.last_tick_at - agg.first_tick_at
          : 0;
      const actualSpendPerDay =
        !insufficient && agg.actual_spend_sat !== null && spanMs > 0
          ? (agg.actual_spend_sat * 86_400_000) / spanMs
          : null;
      const incomePerDay =
        !insufficient && avgHashpricePh !== null && agg.avg_delivered_ph !== null
          ? avgHashpricePh * agg.avg_delivered_ph
          : null;
      const netPerDay =
        actualSpendPerDay !== null && incomePerDay !== null
          ? incomePerDay - actualSpendPerDay
          : null;

      return {
        range,
        window_ms: spec.windowMs,
        tick_count: agg.tick_count,
        first_tick_at: agg.first_tick_at,
        last_tick_at: agg.last_tick_at,
        avg_hashprice_sat_per_ph_day: avgHashpricePh,
        avg_delivered_ph: agg.avg_delivered_ph,
        actual_spend_sat: agg.actual_spend_sat,
        actual_spend_per_day_sat: actualSpendPerDay,
        projected_income_per_day_sat: incomePerDay,
        net_per_day_sat: netPerDay,
        insufficient_history: insufficient,
      };
    },
  );

  app.post('/api/finance/spend/rebuild', async () => {
    // Force the closed-bids cache to repaginate from scratch on the
    // next /api/finance hit. Operator-triggered safety net when the
    // cached sum is ever suspected stale.
    if (!deps.accountSpend) {
      return { ok: false, error: 'account-spend service not configured' };
    }
    await deps.accountSpend.rebuild();
    return { ok: true };
  });

  app.get('/api/finance', async (): Promise<FinanceResponse> => {
    const config = await deps.configRepo.get();
    const scope = config?.spent_scope ?? 'autopilot';

    let spent_sat: number;
    let spent_closed_sat: number | null = null;
    let spent_active_sat: number | null = null;
    if (scope === 'account' && deps.accountSpend) {
      const snap = await deps.accountSpend.getLifetimeSpend();
      if (snap) {
        spent_sat = snap.total_settlement_sat;
        spent_closed_sat = snap.closed_sat;
        spent_active_sat = snap.active_sat;
      } else {
        // Fall back to autopilot-scope if the bid list fetch is
        // unavailable rather than falsely reporting 0 spent.
        spent_sat = await deps.ownedBidsRepo.sumLifetimeConsumedSat();
      }
    } else {
      spent_sat = await deps.ownedBidsRepo.sumLifetimeConsumedSat();
    }

    const collected_sat = deps.payoutObserver?.getLastSnapshot()?.total_unspent_sat ?? null;

    let oceanStats: Awaited<ReturnType<OceanClient['fetchStats']>> | null = null;
    if (deps.oceanClient && config?.btc_payout_address) {
      oceanStats = await deps.oceanClient.fetchStats(config.btc_payout_address);
    }

    // Feed the hashprice cache so the controller can use it for
    // cheap-hashrate scaling decisions (issue #13).
    if (oceanStats?.hashprice_sat_per_ph_day != null && deps.hashpriceCache) {
      deps.hashpriceCache.set(oceanStats.hashprice_sat_per_ph_day);
    }

    const expected_sat = oceanStats?.unpaid_sat ?? null;

    // Net = (collected + expected) − spent. `collected_sat` null means
    // on-chain tracking isn't configured (payout_source=none) or the
    // observer hasn't fetched yet; we treat it as 0 for the arithmetic
    // so the net line still makes sense — the "collected: —" row on
    // the panel already tells the operator that piece is missing.
    // Only surface net=null when the *income* side is unavailable
    // (Ocean unreachable): without unpaid earnings we genuinely can't
    // reason about whether we're in the black.
    const net_sat =
      expected_sat !== null ? (collected_sat ?? 0) + expected_sat - spent_sat : null;

    return {
      spent_sat,
      spent_scope: scope,
      spent_closed_sat,
      spent_active_sat,
      collected_sat,
      expected_sat,
      net_sat,
      ocean: oceanStats
        ? {
            lifetime_sat: oceanStats.lifetime_sat,
            daily_estimate_sat: oceanStats.daily_estimate_sat,
            hashprice_sat_per_ph_day: oceanStats.hashprice_sat_per_ph_day,
            rewards_in_window_sat: oceanStats.rewards_in_window_sat,
            time_to_payout_text: oceanStats.time_to_payout_text,
            payout_threshold_sat: oceanStats.payout_threshold_sat,
            fetched_at_ms: oceanStats.fetched_at_ms,
          }
        : null,
      // Use the oldest data-source timestamp, not Date.now(). The
      // operator wants to see how stale the *data* is, not when the
      // endpoint responded. Date.now() was always "0s ago" — useless.
      checked_at_ms: oldestSourceTimestamp(
        oceanStats?.fetched_at_ms ?? null,
        deps.payoutObserver?.getLastSnapshot()?.checked_at ?? null,
        scope === 'account' ? (await deps.accountSpend?.getLifetimeSpend())?.fetched_at_ms ?? null : null,
      ),
    };
  });
}

function oldestSourceTimestamp(...sources: (number | null)[]): number {
  const valid = sources.filter((s): s is number => s !== null && s > 0);
  return valid.length > 0 ? Math.min(...valid) : Date.now();
}
