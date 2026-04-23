/**
 * Empirically determine how the Braiins Hashpower marketplace prices
 * matched hashrate: pay-your-bid (actual spend = bid price × delivered)
 * or pay-at-ask / classic CLOB (actual spend ≤ bid price × delivered).
 *
 * The docs do not say. This script reads our own `data/state.db`,
 * walks autopilot-owned bids, reconstructs each bid's price timeline
 * from `bid_events`, sums the theoretical pay-your-bid spend across
 * `tick_metrics` delivery samples during the bid's active window, and
 * compares that against Braiins' authoritative `amount_consumed_sat`
 * from our `owned_bids` snapshot (updated on every observe).
 *
 * Ratio = actual_consumed / expected_at_bid_price
 *   ≈ 1.00            → pay-your-bid (our daemon model is correct).
 *   < 1.00 by some %  → pay-at-ask / CLOB. The discount tells you how
 *                       much our dashboard spend/net figures are
 *                       over-stated relative to reality.
 *   ≫ 1.00            → unexpected (fees, stale events, or a matching
 *                       model we have not characterised).
 *
 * Data source note: we query `owned_bids` (autopilot's local ledger)
 * rather than `closed_bids_cache` (Braiins-side terminal-bid cache for
 * AccountSpendService). Those two tables track different things; bids
 * that appear in the cache but never in owned_bids are for bids the
 * autopilot did not create (or whose local events were wiped by the
 * 2026-04-20 setup-force regression). Going through owned_bids is the
 * path that actually has bid_events + tick_metrics alignment.
 *
 * Caveats:
 * - `amount_consumed_sat` excludes exchange fees (`fee_paid_sat` is a
 *   separate Braiins counter). Small positive ratio bias = probably
 *   fees, not model.
 * - For still-active bids the consumed counter is growing; we still
 *   score them (truncating expected-spend at their most recent tick),
 *   which gives a mid-flight ratio that's usually informative.
 * - Very short bids or bids with trivial delivery get filtered out.
 *
 * Usage:
 *   pnpm tsx scripts/verify-pricing-model.ts
 *   pnpm tsx scripts/verify-pricing-model.ts --min-hours 2
 *   pnpm tsx scripts/verify-pricing-model.ts --db /custom/state.db
 *   pnpm tsx scripts/verify-pricing-model.ts --include-active=false
 */

import { resolve } from 'node:path';

import { openDatabase, closeDatabase } from '@braiins-hashrate/daemon';

const EH_PER_PH = 1000;
const MS_PER_MIN = 60_000;

interface Args {
  dbPath: string;
  minHours: number;
  includeActive: boolean;
}

function parseArgs(argv: string[]): Args {
  const projectRoot = process.cwd();
  let dbPath = resolve(projectRoot, 'data/state.db');
  let minHours = 1;
  let includeActive = true;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--db' && argv[i + 1]) {
      dbPath = resolve(argv[i + 1]!);
      i += 1;
    } else if (a === '--min-hours' && argv[i + 1]) {
      minHours = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--include-active=false' || a === '--terminal-only') {
      includeActive = false;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm tsx scripts/verify-pricing-model.ts [--db <path>] [--min-hours <n>] [--terminal-only]',
      );
      process.exit(0);
    }
  }
  return { dbPath, minHours, includeActive };
}

interface OwnedBidRow {
  braiins_order_id: string;
  created_at: number;
  price_sat: number | null;
  amount_consumed_sat: number;
  last_known_status: string | null;
  abandoned: number;
}

interface BidEvent {
  occurred_at: number;
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'CANCEL_BID';
  old_price_sat: number | null;
  new_price_sat: number | null;
}

interface PriceSegment {
  t_start: number;
  t_end: number;
  price_sat_eh_day: number;
}

interface TickRow {
  tick_at: number;
  delivered_ph: number;
}

interface BidReport {
  id: string;
  terminal: boolean;
  lifetime_h: number;
  avg_delivered_ph: number;
  total_ph_days: number;
  consumed_sat: number;
  avg_bid_price_sat_ph_day: number;
  expected_at_bid_sat: number;
  actual_over_expected_ratio: number;
  note?: string;
}

interface RawSqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

function countRows(raw: RawSqliteDb, sql: string, ...params: unknown[]): number {
  const row = raw.prepare(sql).all(...params)[0] as { n: number } | undefined;
  return row?.n ?? 0;
}

function loadOwnedBids(raw: RawSqliteDb): OwnedBidRow[] {
  return raw
    .prepare(
      `SELECT braiins_order_id, created_at, price_sat, amount_consumed_sat,
              last_known_status, abandoned
       FROM owned_bids
       WHERE amount_consumed_sat > 0
       ORDER BY created_at ASC`,
    )
    .all() as OwnedBidRow[];
}

function loadBidEvents(raw: RawSqliteDb, orderId: string): BidEvent[] {
  return raw
    .prepare(
      `SELECT occurred_at, kind, old_price_sat, new_price_sat
       FROM bid_events
       WHERE braiins_order_id = ?
       ORDER BY occurred_at ASC`,
    )
    .all(orderId) as BidEvent[];
}

function buildPriceSegments(
  events: BidEvent[],
  bid: OwnedBidRow,
  bidEndAt: number,
): PriceSegment[] {
  // Fast path: no events at all — fall back to flat `owned_bids.price_sat`
  // for the full [created_at, bidEndAt] range. Less accurate (misses edits
  // that happened without a bid_events row being inserted, which should be
  // vanishingly rare) but means we still score the bid.
  if (events.length === 0) {
    if (bid.price_sat == null) return [];
    return [
      {
        t_start: bid.created_at,
        t_end: bidEndAt,
        price_sat_eh_day: bid.price_sat,
      },
    ];
  }

  const createIdx = events.findIndex((e) => e.kind === 'CREATE_BID');
  // Some bids may have EDIT_PRICE events but no CREATE captured (schema
  // history, early rows). In that case anchor the timeline at created_at
  // and use the first EDIT's old_price_sat if present, else the bid's
  // current price_sat as the initial price.
  const segments: PriceSegment[] = [];
  let currentPrice: number;
  let segStart: number;
  if (createIdx !== -1 && events[createIdx]!.new_price_sat != null) {
    currentPrice = events[createIdx]!.new_price_sat!;
    segStart = events[createIdx]!.occurred_at;
  } else {
    const firstEdit = events.find(
      (e) => e.kind === 'EDIT_PRICE' && e.old_price_sat != null,
    );
    if (firstEdit && firstEdit.old_price_sat != null) {
      currentPrice = firstEdit.old_price_sat;
    } else if (bid.price_sat != null) {
      currentPrice = bid.price_sat;
    } else {
      return [];
    }
    segStart = bid.created_at;
  }

  for (let i = createIdx === -1 ? 0 : createIdx + 1; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.kind === 'EDIT_PRICE' && e.new_price_sat != null) {
      segments.push({
        t_start: segStart,
        t_end: e.occurred_at,
        price_sat_eh_day: currentPrice,
      });
      currentPrice = e.new_price_sat;
      segStart = e.occurred_at;
    } else if (e.kind === 'CANCEL_BID') {
      segments.push({
        t_start: segStart,
        t_end: e.occurred_at,
        price_sat_eh_day: currentPrice,
      });
      return segments;
    }
  }
  if (bidEndAt > segStart) {
    segments.push({
      t_start: segStart,
      t_end: bidEndAt,
      price_sat_eh_day: currentPrice,
    });
  }
  return segments;
}

function loadTicksInRange(raw: RawSqliteDb, startMs: number, endMs: number): TickRow[] {
  return raw
    .prepare(
      `SELECT tick_at, delivered_ph
       FROM tick_metrics
       WHERE tick_at >= ? AND tick_at <= ?
       ORDER BY tick_at ASC`,
    )
    .all(startMs, endMs) as TickRow[];
}

function latestTickAt(raw: RawSqliteDb): number | null {
  const row = raw
    .prepare('SELECT MAX(tick_at) AS t FROM tick_metrics')
    .all()[0] as { t: number | null } | undefined;
  return row?.t ?? null;
}

function analyzeBid(
  raw: RawSqliteDb,
  bid: OwnedBidRow,
  latestTickAtMs: number,
): BidReport {
  // Determine if the bid is terminal:
  //   - `abandoned = 1`               → controller marked it terminal.
  //   - `last_known_status` contains  → CANCELLED / FULFILLED / etc.
  //   Otherwise treat as "still active" and cap the scoring window at
  //   the most recent tick (so the consumed counter lines up with the
  //   delivered samples we've observed).
  const terminalStatuses = new Set([
    'BID_STATUS_CANCELED',
    'BID_STATUS_CANCELLED',
    'BID_STATUS_FULFILLED',
    'BID_STATUS_EXPIRED',
    'BID_STATUS_FROZEN',
  ]);
  const terminal =
    bid.abandoned === 1 ||
    (bid.last_known_status !== null && terminalStatuses.has(bid.last_known_status));

  // For terminal bids, lifetime ends at the last CANCEL event if any,
  // else the latest tick we have. For still-active bids, we cap at
  // the latest tick — consumed counter tracks up to (approximately) the
  // last observe cycle.
  const events = loadBidEvents(raw, bid.braiins_order_id);
  const cancelEvent = [...events].reverse().find((e) => e.kind === 'CANCEL_BID');
  const bidEndAt = terminal
    ? cancelEvent?.occurred_at ?? latestTickAtMs
    : latestTickAtMs;

  const segments = buildPriceSegments(events, bid, bidEndAt);
  const lifetimeH = (bidEndAt - bid.created_at) / 3_600_000;

  if (segments.length === 0) {
    return {
      id: bid.braiins_order_id,
      terminal,
      lifetime_h: lifetimeH,
      avg_delivered_ph: 0,
      total_ph_days: 0,
      consumed_sat: bid.amount_consumed_sat,
      avg_bid_price_sat_ph_day: 0,
      expected_at_bid_sat: 0,
      actual_over_expected_ratio: NaN,
      note: 'no usable price timeline',
    };
  }

  let totalPhDays = 0;
  let totalExpectedSat = 0;
  let priceWeightedByPhDays = 0;

  for (const seg of segments) {
    const ticks = loadTicksInRange(raw, seg.t_start, seg.t_end);
    for (let i = 0; i < ticks.length; i += 1) {
      const t = ticks[i]!;
      const next = ticks[i + 1];
      const durMs =
        next !== undefined
          ? Math.min(next.tick_at - t.tick_at, seg.t_end - t.tick_at)
          : Math.min(60_000, Math.max(0, seg.t_end - t.tick_at));
      if (durMs <= 0) continue;
      const durMin = durMs / MS_PER_MIN;
      const phDays = (t.delivered_ph * durMin) / 1440;
      totalPhDays += phDays;
      totalExpectedSat += (seg.price_sat_eh_day * t.delivered_ph * durMin) / 1_440_000;
      priceWeightedByPhDays += (seg.price_sat_eh_day / EH_PER_PH) * phDays;
    }
  }

  const avgDeliveredPh = lifetimeH > 0 ? (totalPhDays * 24) / lifetimeH : 0;
  const avgBidPricePhDay =
    totalPhDays > 0 ? priceWeightedByPhDays / totalPhDays : 0;

  return {
    id: bid.braiins_order_id,
    terminal,
    lifetime_h: lifetimeH,
    avg_delivered_ph: avgDeliveredPh,
    total_ph_days: totalPhDays,
    consumed_sat: bid.amount_consumed_sat,
    avg_bid_price_sat_ph_day: avgBidPricePhDay,
    expected_at_bid_sat: totalExpectedSat,
    actual_over_expected_ratio:
      totalExpectedSat > 0 ? bid.amount_consumed_sat / totalExpectedSat : NaN,
  };
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtNum(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

function printDiagnostics(raw: RawSqliteDb): void {
  const ownedTotal = countRows(raw, 'SELECT COUNT(*) AS n FROM owned_bids');
  const ownedWithConsumed = countRows(
    raw,
    'SELECT COUNT(*) AS n FROM owned_bids WHERE amount_consumed_sat > 0',
  );
  const closedTotal = countRows(raw, 'SELECT COUNT(*) AS n FROM closed_bids_cache');
  const eventsCreate = countRows(
    raw,
    "SELECT COUNT(*) AS n FROM bid_events WHERE kind = 'CREATE_BID'",
  );
  const eventsEdit = countRows(
    raw,
    "SELECT COUNT(*) AS n FROM bid_events WHERE kind = 'EDIT_PRICE'",
  );
  const eventsCancel = countRows(
    raw,
    "SELECT COUNT(*) AS n FROM bid_events WHERE kind = 'CANCEL_BID'",
  );
  const ticksTotal = countRows(raw, 'SELECT COUNT(*) AS n FROM tick_metrics');
  const firstTick = (
    raw.prepare('SELECT MIN(tick_at) AS t FROM tick_metrics').all()[0] as {
      t: number | null;
    }
  )?.t;
  const lastTick = (
    raw.prepare('SELECT MAX(tick_at) AS t FROM tick_metrics').all()[0] as {
      t: number | null;
    }
  )?.t;

  console.log('→ table sizes:');
  console.log(`    owned_bids:       ${ownedTotal} total, ${ownedWithConsumed} with consumed > 0`);
  console.log(`    closed_bids_cache:${closedTotal}`);
  console.log(
    `    bid_events:       CREATE ${eventsCreate} · EDIT ${eventsEdit} · CANCEL ${eventsCancel}`,
  );
  console.log(
    `    tick_metrics:     ${ticksTotal} rows${
      firstTick && lastTick
        ? ` (${new Date(firstTick).toISOString()} → ${new Date(lastTick).toISOString()})`
        : ''
    }`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`→ opening ${args.dbPath}`);
  const handle = await openDatabase({ path: args.dbPath });
  try {
    const raw = handle.raw as unknown as RawSqliteDb;
    printDiagnostics(raw);

    const bids = loadOwnedBids(raw);
    const latestTick = latestTickAt(raw);
    if (latestTick === null) {
      console.log('\nNo tick_metrics rows at all — daemon never ran. Nothing to score.');
      return;
    }

    const reports: BidReport[] = bids.map((b) => analyzeBid(raw, b, latestTick));

    // Anomalously low ratios (< 0.1) almost always mean the bid wasn't
    // actually the autopilot's primary for most of [created_at, end] —
    // tick_metrics delivery rows were shared with another overlapping
    // owned bid that actually did the work. Flagging these out of the
    // aggregate summary; they're shown in the table with a note.
    const ANOMALY_FLOOR = 0.1;
    const filtered = reports.filter((r) => {
      if (!args.includeActive && !r.terminal) return false;
      if (
        !(
          r.lifetime_h >= args.minHours &&
          r.total_ph_days > 0 &&
          r.expected_at_bid_sat > 0 &&
          Number.isFinite(r.actual_over_expected_ratio)
        )
      ) {
        return false;
      }
      if (r.actual_over_expected_ratio < ANOMALY_FLOOR) {
        r.note = `ratio < ${ANOMALY_FLOOR} — likely not primary during claimed lifetime (overlapping owned bid)`;
        return false;
      }
      return true;
    });

    // Global ratio — immune to per-bid overlap artifacts. Sum of all
    // autopilot-observed actual consumption vs sum of tick_metrics'
    // modeled spend (already computed at pay-your-bid in the daemon).
    const globalActual = countRows(
      raw,
      'SELECT COALESCE(SUM(amount_consumed_sat), 0) AS n FROM owned_bids',
    );
    const globalExpected = countRows(
      raw,
      'SELECT COALESCE(SUM(spend_sat), 0) AS n FROM tick_metrics WHERE spend_sat IS NOT NULL',
    );
    const globalRatio =
      globalExpected > 0 ? globalActual / globalExpected : NaN;

    console.log('');
    console.log(
      'ID               | state    | life(h) | avg PH | PH-days | consumed sat | avg bid/PH/day | expected@bid | actual/expected',
    );
    console.log(
      '-----------------+----------+---------+--------+---------+--------------+----------------+--------------+---------------',
    );
    for (const r of reports) {
      const state = r.terminal ? 'terminal' : 'active  ';
      if (r.note || !Number.isFinite(r.actual_over_expected_ratio)) {
        console.log(
          `${r.id.slice(0, 16).padEnd(16)} | ${state} | ${fmtNum(r.lifetime_h, 1).padStart(7)} |      — |       — | ${fmtInt(r.consumed_sat).padStart(12)} |              — |            — | (${r.note ?? 'no expected spend'})`,
        );
        continue;
      }
      console.log(
        [
          r.id.slice(0, 16).padEnd(16),
          state,
          fmtNum(r.lifetime_h, 1).padStart(7),
          fmtNum(r.avg_delivered_ph, 2).padStart(6),
          fmtNum(r.total_ph_days, 3).padStart(7),
          fmtInt(r.consumed_sat).padStart(12),
          fmtInt(r.avg_bid_price_sat_ph_day).padStart(14),
          fmtInt(r.expected_at_bid_sat).padStart(12),
          fmtNum(r.actual_over_expected_ratio, 4).padStart(13),
        ].join(' | '),
      );
    }

    console.log('');
    console.log(
      `→ scored bids (≥${args.minHours}h, non-trivial delivery${args.includeActive ? ', including active' : ', terminal only'}): ${filtered.length}`,
    );

    if (filtered.length === 0) {
      console.log('');
      console.log('Not enough usable data to determine the pricing model yet.');
      console.log('Try again after the autopilot has been running for a few hours,');
      console.log('or lower the threshold with --min-hours 0.5.');
      return;
    }

    const ratios = filtered.map((r) => r.actual_over_expected_ratio);
    const med = median(ratios);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);

    console.log(`  median ratio: ${fmtNum(med, 4)}`);
    console.log(`  mean   ratio: ${fmtNum(mean, 4)}`);
    console.log(`  range       : [${fmtNum(min, 4)}, ${fmtNum(max, 4)}]`);

    console.log('');
    if (med >= 0.98 && med <= 1.03) {
      console.log('=================================================================');
      console.log(' VERDICT: pay-your-bid. Our daemon model is correct.');
      console.log(' actual_consumed ≈ bid_price × delivered_ph × time');
      console.log(' Lowering bids matters — every sat of bid reduction = sat saved.');
      console.log('=================================================================');
    } else if (med < 0.98) {
      const discountPct = (1 - med) * 100;
      console.log('=====================================================================');
      console.log(
        ` VERDICT: pay-at-ask / classic CLOB. Median discount vs bid: ${fmtNum(discountPct, 1)}%`,
      );
      console.log(' Our daemon OVER-states spend. Lowering bids has little cost impact —');
      console.log(' they mainly act as a ceiling on acceptable ask prices.');
      console.log('=====================================================================');
    } else {
      console.log('=====================================================================');
      console.log(` VERDICT: unexpected. Median ratio ${fmtNum(med, 4)} > 1.03.`);
      console.log(' Possible: fees on top of consumed_sat, stale bid_events, data');
      console.log(' quality issue, or a matching model we have not characterised.');
      console.log('=====================================================================');
    }
  } finally {
    await closeDatabase(handle);
  }
}

void main();
