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

import { sql, type Kysely } from 'kysely';

import type { Database } from '../state/types.js';

// Threshold above which we treat the value as definitively
// reconstructed (not a real Ocean reading). Sized for the project's
// deployment shape: 1 PH/s hobbyist target -> ~50k sat/day income ->
// Ocean's 1,048,576-sat payout threshold typically clears well
// before unpaid hits 1.5M.
const BOGUS_THRESHOLD_SAT = 1_500_000;

// #369: the bogus reconstruction this cleanup reverts was itself
// reverted on 2026-05-08 - no tick recorded after that date can
// possibly carry a reconstructed value, so the heuristic must never
// look past it. Without this bound, a LEGITIMATELY high balance
// (bigger targets than the 1 PH/s the threshold was sized for, or an
// Ocean payout batch running long) tripped the cutoff and nulled the
// operator's entire real unpaid history on the next boot. Empirical
// incident: 2026-08-20, ~3.4 PH/s install, unpaid crossed 1.5M
// before the Aug 18 payout; the v1.18.0 upgrade restart wiped
// everything before it.
const CONTAMINATION_ERA_END_MS = Date.UTC(2026, 4, 9); // 2026-05-09T00:00Z

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
  // #369: bounded to the contamination era - later rows are genuine
  // Ocean readings by definition, however high the balance runs.
  const cutoffRow = await deps.db
    .selectFrom('tick_metrics')
    .select(({ fn }) => fn.max<number>('tick_at').as('cutoff'))
    .where('ocean_unpaid_sat', '>', BOGUS_THRESHOLD_SAT)
    .where('tick_at', '<', CONTAMINATION_ERA_END_MS)
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

/**
 * #369: boot-time self-heal for the data this cleanup wrongly wiped.
 *
 * Every tick's observed state - `ocean_unpaid_sat` included - is also
 * stored as JSON in `decisions.observed_json`, which the unbounded
 * cleanup never touched. Copy the value back into every tick_metrics
 * row where it is NULL and a same-tick decisions row still carries it.
 * On the incident install this recovers the recent window completely
 * (uneventful-decisions retention) and older history at every
 * eventful tick.
 *
 * Safe by construction: rows that are NULL for a legitimate reason
 * (Ocean unreachable that tick, BIP110-chain ticks, synthetic
 * gap-backfill rows) either have no decisions row or a NULL value in
 * observed_json, so the EXISTS guard skips them. Idempotent - restored
 * rows become non-null and drop out of the WHERE on the next boot.
 */
export async function runOceanUnpaidRestore(
  deps: OceanUnpaidCleanupDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);

  const result = await sql`
    UPDATE tick_metrics
    SET ocean_unpaid_sat = (
      SELECT CAST(json_extract(d.observed_json, '$.ocean_unpaid_sat') AS INTEGER)
      FROM decisions d
      WHERE d.tick_at = tick_metrics.tick_at
        AND json_extract(d.observed_json, '$.ocean_unpaid_sat') IS NOT NULL
      ORDER BY d.id DESC
      LIMIT 1
    )
    WHERE ocean_unpaid_sat IS NULL
      AND EXISTS (
        SELECT 1
        FROM decisions d
        WHERE d.tick_at = tick_metrics.tick_at
          AND json_extract(d.observed_json, '$.ocean_unpaid_sat') IS NOT NULL
      )
  `.execute(deps.db);

  const affected = Number(result.numAffectedRows ?? 0);
  if (affected > 0) {
    log(
      `ocean-unpaid-restore: recovered ocean_unpaid_sat on ${affected} tick_metrics row(s) from decisions.observed_json (#369)`,
    );
  }
}
