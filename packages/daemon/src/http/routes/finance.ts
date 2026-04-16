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
import type { OceanClient } from '../../services/ocean.js';
import type { PayoutObserver } from '../../services/payout-observer.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { ConfigRepo } from '../../state/repos/config.js';

export interface FinanceResponse {
  readonly spent_sat: number;
  /** Which scope produced `spent_sat`. Mirrors the config field. */
  readonly spent_scope: 'autopilot' | 'account';
  readonly collected_sat: number | null;
  readonly expected_sat: number | null;
  readonly net_sat: number | null;
  readonly ocean: {
    readonly lifetime_sat: number | null;
    readonly daily_estimate_sat: number | null;
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
}

export async function registerFinanceRoute(
  app: FastifyInstance,
  deps: FinanceDeps,
): Promise<void> {
  app.get('/api/finance', async (): Promise<FinanceResponse> => {
    const config = await deps.configRepo.get();
    const scope = config?.spent_scope ?? 'autopilot';

    let spent_sat: number;
    if (scope === 'account' && deps.accountSpend) {
      const snap = await deps.accountSpend.getLifetimeSpend();
      // Fall back to autopilot-scope if Braiins's transaction ledger
      // is unavailable rather than falsely reporting 0 spent.
      spent_sat =
        snap?.total_settlement_sat ??
        (await deps.ownedBidsRepo.sumLifetimeConsumedSat());
    } else {
      spent_sat = await deps.ownedBidsRepo.sumLifetimeConsumedSat();
    }

    const collected_sat = deps.payoutObserver?.getLastSnapshot()?.total_unspent_sat ?? null;

    let oceanStats: Awaited<ReturnType<OceanClient['fetchStats']>> | null = null;
    if (deps.oceanClient && config?.btc_payout_address) {
      oceanStats = await deps.oceanClient.fetchStats(config.btc_payout_address);
    }

    const expected_sat = oceanStats?.unpaid_sat ?? null;

    // Net only makes sense when we have *both* halves of the income
    // side. Showing "(spent) − null" as "(spent) more in the red" is
    // misleading — defer the verdict until the dashboards have real
    // numbers to add up.
    const net_sat =
      collected_sat !== null && expected_sat !== null
        ? collected_sat + expected_sat - spent_sat
        : null;

    return {
      spent_sat,
      spent_scope: scope,
      collected_sat,
      expected_sat,
      net_sat,
      ocean: oceanStats
        ? {
            lifetime_sat: oceanStats.lifetime_sat,
            daily_estimate_sat: oceanStats.daily_estimate_sat,
            rewards_in_window_sat: oceanStats.rewards_in_window_sat,
            time_to_payout_text: oceanStats.time_to_payout_text,
            payout_threshold_sat: oceanStats.payout_threshold_sat,
            fetched_at_ms: oceanStats.fetched_at_ms,
          }
        : null,
      checked_at_ms: Date.now(),
    };
  });
}
