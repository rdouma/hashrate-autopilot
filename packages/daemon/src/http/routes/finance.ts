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

import type { AccountSpendService } from '../../services/account-spend.js';
import type { HashpriceCache } from '../../services/hashprice-cache.js';
import type { OceanClient } from '../../services/ocean.js';
import type { PayoutObserver } from '../../services/payout-observer.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { ConfigRepo } from '../../state/repos/config.js';

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
}

export async function registerFinanceRoute(
  app: FastifyInstance,
  deps: FinanceDeps,
): Promise<void> {
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
