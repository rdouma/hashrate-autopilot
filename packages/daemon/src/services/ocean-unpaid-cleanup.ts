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

import { readFile, rename } from 'node:fs/promises';

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

/**
 * #369: operator-supplied backup import. When an operator has an old
 * copy of state.db (or any export) from before the wipe, they can
 * recover the stretch the decision log no longer covers by dropping a
 * JSON file next to the live database:
 *
 *   <data dir>/ocean-unpaid-import.json
 *   -> [[tick_at_ms, unpaid_sat], ...]
 *
 * On the next boot the daemon merges it - exact tick_at match, and
 * ONLY into rows whose ocean_unpaid_sat is NULL, so live readings are
 * never overwritten and re-running is harmless. The file is renamed
 * to `.imported` afterwards so it applies exactly once. A malformed
 * file is left in place and logged, never deleted.
 */
export async function runOceanUnpaidImport(
  deps: OceanUnpaidCleanupDeps & { readonly importPath: string },
): Promise<void> {
  const log = deps.log ?? (() => undefined);

  let raw: string;
  try {
    raw = await readFile(deps.importPath, 'utf8');
  } catch {
    return; // no import file - the overwhelmingly common case
  }

  let pairs: Array<[number, number]>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('top level is not an array');
    pairs = parsed.filter(
      (p): p is [number, number] =>
        Array.isArray(p) &&
        p.length === 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]),
    );
  } catch (err) {
    log(
      `ocean-unpaid-import: ${deps.importPath} is not a valid [[tick_at_ms, unpaid_sat], ...] JSON array (${(err as Error).message}); leaving it in place`,
    );
    return;
  }

  // Stage the pairs in a temp table (chunked inserts), then merge in
  // one indexed UPDATE. SQLite has no column aliases on a bare VALUES
  // table, and a temp table keeps the statements small for ~100k-pair
  // backups.
  await sql`CREATE TEMP TABLE IF NOT EXISTS unpaid_import (tick_at INTEGER PRIMARY KEY, unpaid INTEGER NOT NULL)`.execute(
    deps.db,
  );
  await sql`DELETE FROM unpaid_import`.execute(deps.db);
  const CHUNK = 5_000;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const valuesSql = sql.join(
      chunk.map(([t, v]) => sql`(${t}, ${v})`),
      sql`, `,
    );
    await sql`INSERT OR REPLACE INTO unpaid_import (tick_at, unpaid) VALUES ${valuesSql}`.execute(
      deps.db,
    );
  }

  const result = await sql`
    UPDATE tick_metrics
    SET ocean_unpaid_sat = (
      SELECT unpaid FROM unpaid_import WHERE unpaid_import.tick_at = tick_metrics.tick_at
    )
    WHERE ocean_unpaid_sat IS NULL
      AND tick_at IN (SELECT tick_at FROM unpaid_import)
  `.execute(deps.db);
  const restored = Number(result.numAffectedRows ?? 0);
  await sql`DROP TABLE IF EXISTS unpaid_import`.execute(deps.db);

  log(
    `ocean-unpaid-import: merged ${restored} value(s) from ${deps.importPath} (${pairs.length} pairs in file)`,
  );
  try {
    await rename(deps.importPath, `${deps.importPath}.imported`);
  } catch (err) {
    log(`ocean-unpaid-import: could not rename import file: ${(err as Error).message}`);
  }
}

/**
 * #375: bounded gap-filling between adjacent REAL unpaid samples.
 *
 * The #369 restore recovered the wiped era only at ticks the decision
 * log still covered, leaving minute-level holes between real samples.
 * Between two adjacent real readings with no payout in between, unpaid
 * is a slow monotonic accrual, so the intermediate values are tightly
 * bounded by the two endpoints - linear interpolation there is
 * display-grade gap-filling, categorically different from the banned
 * model-based reconstruction (#108) that invented values from
 * `reward x share_log` with no bounding measurements at all.
 *
 * Strict safety bounds - a gap is filled ONLY when:
 *   (a) the bracketing real samples are at most 6 h apart,
 *   (b) no payout exists in the payout ledger inside the bracket, and
 *   (c) the right endpoint is >= the left (monotonic accrual - a drop
 *       means a payout/adjustment happened inside the gap, and
 *       interpolating would smear a cliff into a fake slope; those
 *       gaps stay honest holes).
 * BIP110-chain ticks are never filled (their unpaid is unknowable,
 * not missing). Interpolated segments are monotonic non-decreasing
 * between real endpoints, so the deduced-payout drop scanner can
 * never read them as payouts. Idempotent: filled rows are non-null
 * on the next boot and drop out of the scan.
 */
export async function runOceanUnpaidInterpolate(
  deps: OceanUnpaidCleanupDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const MAX_BRACKET_MS = 6 * 60 * 60_000;

  const nullCount = await deps.db
    .selectFrom('tick_metrics')
    .select(({ fn }) => fn.countAll<number>().as('c'))
    .where('ocean_unpaid_sat', 'is', null)
    .where('synthetic', '=', 0)
    .executeTakeFirst();
  if (!nullCount || Number(nullCount.c) === 0) return;

  const rows = await deps.db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'ocean_unpaid_sat', 'ocean_chain'])
    .where('synthetic', '=', 0)
    .orderBy('tick_at', 'asc')
    .execute();
  const payoutTs = (
    await deps.db.selectFrom('ocean_payouts').select('ts').orderBy('ts', 'asc').execute()
  ).map((p) => Number(p.ts));

  const hasPayoutBetween = (t1: number, t2: number): boolean => {
    // payoutTs is sorted; linear scan with early exit is fine at the
    // dozens-of-payouts scale this table has.
    for (const ts of payoutTs) {
      if (ts > t2) break;
      if (ts > t1) return true;
    }
    return false;
  };

  const fills: Array<[number, number]> = [];
  let leftT: number | null = null;
  let leftV: number | null = null;
  let pendingNulls: number[] = [];
  for (const r of rows) {
    if (r.ocean_unpaid_sat === null) {
      if (r.ocean_chain !== 'bip110') pendingNulls.push(r.tick_at);
      continue;
    }
    const t = r.tick_at;
    const v = Number(r.ocean_unpaid_sat);
    if (
      leftT !== null &&
      leftV !== null &&
      pendingNulls.length > 0 &&
      t - leftT <= MAX_BRACKET_MS &&
      v >= leftV &&
      !hasPayoutBetween(leftT, t)
    ) {
      for (const nt of pendingNulls) {
        const frac = (nt - leftT) / (t - leftT);
        fills.push([nt, Math.round(leftV + (v - leftV) * frac)]);
      }
    }
    leftT = t;
    leftV = v;
    pendingNulls = [];
  }

  if (fills.length === 0) return;

  await sql`CREATE TEMP TABLE IF NOT EXISTS unpaid_interp (tick_at INTEGER PRIMARY KEY, unpaid INTEGER NOT NULL)`.execute(
    deps.db,
  );
  await sql`DELETE FROM unpaid_interp`.execute(deps.db);
  const CHUNK = 5_000;
  for (let i = 0; i < fills.length; i += CHUNK) {
    const chunk = fills.slice(i, i + CHUNK);
    const valuesSql = sql.join(
      chunk.map(([t, v]) => sql`(${t}, ${v})`),
      sql`, `,
    );
    await sql`INSERT OR REPLACE INTO unpaid_interp (tick_at, unpaid) VALUES ${valuesSql}`.execute(
      deps.db,
    );
  }
  const result = await sql`
    UPDATE tick_metrics
    SET ocean_unpaid_sat = (
      SELECT unpaid FROM unpaid_interp WHERE unpaid_interp.tick_at = tick_metrics.tick_at
    )
    WHERE ocean_unpaid_sat IS NULL
      AND tick_at IN (SELECT tick_at FROM unpaid_interp)
  `.execute(deps.db);
  await sql`DROP TABLE IF EXISTS unpaid_interp`.execute(deps.db);

  log(
    `ocean-unpaid-interpolate: filled ${Number(result.numAffectedRows ?? 0)} gap row(s) between adjacent real samples (#375)`,
  );
}
