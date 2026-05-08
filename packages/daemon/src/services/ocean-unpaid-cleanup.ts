/**
 * One-shot revert for #108 follow-up: a previous recompute pass
 * incorrectly back-filled `tick_metrics.ocean_unpaid_sat` for
 * historical rows using a `pool_block.reward × share_log_pct`
 * reconstruction. The reconstruction is wrong because share_log_pct
 * is the operator's TIDES window share at a moment in time, which
 * varies as the operator's mining activity varies; using a nearest-
 * known reading as a fallback for past blocks wildly over-credits
 * the operator on blocks before they were mining at full hashrate.
 *
 * Identification heuristic (time-based per operator's request):
 * find the LATEST tick where ocean_unpaid_sat > BOGUS_THRESHOLD_SAT
 * - a value implausibly high for any operator running in this
 * project's deployment shape (1 PH/s hobbyist target, Ocean's
 * 1,048,576-sat payout threshold means natural balances oscillate
 * well below 1.5M between payouts). Treat that tick and everything
 * before it as contaminated and null the column. After the cutoff,
 * leave values alone - they may be a mix of real Ocean readings and
 * scattered reconstructed-during-Ocean-blips values, but the user-
 * visible chart line stops being garbage.
 *
 * Idempotent: a re-boot finds no rows above the threshold (because
 * we just nulled them), so the cutoff query returns null and the
 * function no-ops.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../state/types.js';

// Threshold above which we treat the value as definitively
// reconstructed (not a real Ocean reading). Sized for the project's
// deployment shape: 1 PH/s hobbyist target -> ~50k sat/day income ->
// Ocean's 1,048,576-sat payout threshold typically clears well
// before unpaid hits 1.5M.
const BOGUS_THRESHOLD_SAT = 1_500_000;

export interface OceanUnpaidCleanupDeps {
  readonly db: Kysely<Database>;
  readonly log?: (msg: string) => void;
}

export async function runOceanUnpaidCleanup(
  deps: OceanUnpaidCleanupDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);

  // Find the latest tick where unpaid is implausibly high. That
  // tick (and everything before it) is the contaminated region.
  const cutoffRow = await deps.db
    .selectFrom('tick_metrics')
    .select(({ fn }) => fn.max<number>('tick_at').as('cutoff'))
    .where('ocean_unpaid_sat', '>', BOGUS_THRESHOLD_SAT)
    .executeTakeFirst();

  const cutoffMs = cutoffRow?.cutoff;
  if (cutoffMs === null || cutoffMs === undefined) {
    return;
  }

  const result = await deps.db
    .updateTable('tick_metrics')
    .set({ ocean_unpaid_sat: null })
    .where('tick_at', '<=', cutoffMs)
    .where('ocean_unpaid_sat', 'is not', null)
    .executeTakeFirst();

  const affected = Number(result.numUpdatedRows ?? 0);
  if (affected > 0) {
    log(
      `ocean-unpaid-cleanup: nulled ${affected} contaminated tick_metrics rows at or before ${new Date(cutoffMs).toISOString()} (cutoff = latest tick with ocean_unpaid_sat > ${BOGUS_THRESHOLD_SAT})`,
    );
  }
}
