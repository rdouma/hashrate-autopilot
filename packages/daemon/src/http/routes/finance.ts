/**
 * GET /api/finance - top-level money panel for the dashboard.
 *
 * Combines three sources into a single profit/loss view:
 *   - spent      = lifetime sum of `amount_consumed_sat` across every
 *                  bid the autopilot has ever owned (operator can also
 *                  bump a bid manually; that path also goes through
 *                  the autopilot's owned-bids ledger so it's counted).
 *   - collected  = lifetime sat received at the configured payout
 *                  address (sum of reward_events.value_sat where
 *                  reorged=0). We count "what they put in," not the
 *                  current balance - so a payout that's been spent
 *                  still counts. Until #240 follow-up (this commit)
 *                  this was `total_unspent_sat` from the observer's
 *                  in-memory UTXO snapshot; operator caught that
 *                  semantic when a new-address payout-then-spend
 *                  cycle made the tile read 0 despite the address
 *                  having received the payout.
 *   - expected   = Ocean's "Unpaid Earnings" - the BTC amount that
 *                  will land at the next payout (when above threshold)
 *                  or has already been earned but is below threshold.
 *
 * net = collected + expected − spent.  Positive = autopilot is in the
 * black, negative = still digging out of the initial deposit.
 *
 * Each source can independently be `null` when its data isn't
 * available yet (Ocean down, electrs/bitcoind unconfigured, fresh
 * install with no bids). The dashboard renders "-" for nulls and
 * skips them in the net calculation (so `net` is null until both
 * collected and expected have at least one observation).
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@hashrate-autopilot/shared';

import type { AccountSpendService } from '../../services/account-spend.js';
import type { HashpriceCache } from '../../services/hashprice-cache.js';
import type { OceanClient } from '../../services/ocean.js';
import type { PayoutObserver } from '../../services/payout-observer.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { RewardEventsRepo } from '../../state/repos/reward_events.js';
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
  /**
   * #97 - disambiguates the three states `collected_sat: null` collapses
   * into for the dashboard:
   * - 'computing' - payout observer is enabled but the first scan has
   *   not yet produced a snapshot. Dashboard renders a spinner so the
   *   operator does not see a blank em-dash mid-startup.
   * - 'ready'     - observer has produced a snapshot; `collected_sat`
   *   reflects it.
   * - 'idle'      - observer is disabled (`payout_source = 'none'` or
   *   missing creds). Dashboard renders the existing "not configured"
   *   tooltip on the em-dash.
   */
  readonly collected_status: 'computing' | 'ready' | 'idle';
  readonly expected_sat: number | null;
  /**
   * #170 follow-up: operator-entered offset for pre-installation /
   * off-chain earnings (Lightning payouts, pre-autopilot Ocean
   * history that's been swept, etc.). Always >= 0; mirrors the
   * config knob `historical_payouts_offset_sat`. Added into
   * `net_sat` server-side so the panel's net line is coherent
   * without the dashboard having to do the arithmetic. Surfaced as
   * a separate field so the dashboard can render a dedicated row.
   */
  readonly historical_offset_sat: number;
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
  /** #240 follow-up: source of truth for lifetime collected. */
  readonly rewardEventsRepo: RewardEventsRepo;
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
   * `primary_bid_consumed_sat` deltas. Authoritative spend - what
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
   * break-even), not a measurement - kept symmetric with the
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
  /**
   * #243: Braiins primary-bid share rejection rate across the
   * range, computed server-side from raw `tick_metrics` rows (NOT
   * the bucketed chart data). Bypasses the bucket-MAX information
   * loss that made the chart-derived rate inconsistent across
   * range presets. Formula: `(last_rejected - first_rejected) /
   * (last_purchased - first_purchased) * 100` against the
   * cumulative-since-bid-creation counters. Null when no usable
   * counter samples in range, no shares cleared, or a single bid
   * rotation made the deltas non-sensical.
   */
  readonly braiins_rejection_pct: number | null;
}

export async function registerFinanceRoute(
  app: FastifyInstance,
  deps: FinanceDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string; since?: string; until?: string } }>(
    '/api/finance/range',
    async (req): Promise<FinanceRangeResponse> => {
      // #169: arbitrary viewport path
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);
      let range: ChartRange;
      let sinceMs: number | null;
      let untilMs: number | undefined;
      let windowMs: number | null;
      if (
        !req.query.range &&
        Number.isFinite(parsedSince) && parsedSince > 0 &&
        Number.isFinite(parsedUntil) && parsedUntil > parsedSince
      ) {
        range = '24h';
        sinceMs = parsedSince;
        untilMs = parsedUntil;
        windowMs = parsedUntil - parsedSince;
      } else {
        range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
        const spec = CHART_RANGE_SPECS[range];
        windowMs = spec.windowMs;
        sinceMs = spec.windowMs === null ? null : Date.now() - spec.windowMs;
      }

      const [agg, braiinsRejectionPct] = await Promise.all([
        deps.tickMetricsRepo.rangeFinanceAggregates(sinceMs, untilMs),
        deps.tickMetricsRepo.braiinsRejectionPctSince(sinceMs, untilMs),
      ]);
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
        window_ms: windowMs,
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
        braiins_rejection_pct: braiinsRejectionPct,
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

    // #240 follow-up: collected = LIFETIME RECEIVED, not current UTXO
    // balance. Operator on Taliesin received a payout to the new
    // configured address, then spent it; the previous
    // `total_unspent_sat` source showed 0 because the UTXOs were gone,
    // even though the address received N sat in its lifetime. We
    // count "what they put in," not the current balance.
    // sum is over reward_events.value_sat for non-reorged events. The
    // observer populates that table both from current-UTXO scans
    // (steady state) and from historical electrs scans of the
    // address's tx history (boot + every 30 min), so spent payouts
    // are captured too.
    const collected_sat = deps.payoutObserver
      ? await deps.rewardEventsRepo.sumPaidUpTo(Date.now())
      : null;
    const collected_status: 'computing' | 'ready' | 'idle' = !deps.payoutObserver
      ? 'idle'
      : deps.payoutObserver.getCollectedStatus();

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

    // #170 follow-up: pre-installation / off-chain earnings the
    // operator entered manually. Folded into net so the user whose
    // Ocean history pre-dates the autopilot doesn't see a permanent
    // "massive loss" on the P&L line.
    const historical_offset_sat = config?.historical_payouts_offset_sat ?? 0;

    // Net = (collected + historical_offset + expected) − spent.
    // `collected_sat` null means on-chain tracking isn't configured
    // (payout_source=none) or the observer hasn't fetched yet; treat
    // it as 0 for the arithmetic so the net line still makes sense -
    // the "collected: -" row on the panel already tells the operator
    // that piece is missing. Only surface net=null when the *income*
    // side is unavailable (Ocean unreachable): without unpaid earnings
    // we genuinely can't reason about whether we're in the black.
    const net_sat =
      expected_sat !== null
        ? (collected_sat ?? 0) + historical_offset_sat + expected_sat - spent_sat
        : null;

    return {
      spent_sat,
      spent_scope: scope,
      spent_closed_sat,
      spent_active_sat,
      collected_sat,
      collected_status,
      expected_sat,
      historical_offset_sat,
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
      // endpoint responded. Date.now() was always "0s ago" - useless.
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
