/**
 * Empirically determine how the Braiins Hashpower marketplace prices
 * matched hashrate: pay-your-bid (actual spend = bid price × delivered)
 * or pay-at-ask / classic CLOB (actual spend ≤ bid price × delivered).
 *
 * The docs don't say. This script reads our own `data/state.db`, walks
 * every closed bid, reconstructs its bid-price timeline from
 * `bid_events`, sums the theoretical pay-your-bid spend across ticks,
 * and compares against Braiins's authoritative `amount_consumed_sat`
 * from `closed_bids_cache`.
 *
 * Ratio = actual_consumed / expected_at_bid_price
 *   ≈ 1.00            → pay-your-bid (our daemon model is correct).
 *   < 1.00 by some %  → pay-at-ask / CLOB. The discount tells you how
 *                       much our dashboard spend/net figures are
 *                       over-stated.
 *   ≫ 1.00            → unexpected (fees, stale bid_events, model error).
 *
 * Caveats:
 * - `amount_consumed_sat` on Braiins excludes exchange fees (`fee_paid_sat`
 *   is a separate counter we do not cache). A small positive bias in
 *   actual/expected is probably fees, not the matching model.
 * - Bids with short lifetimes or trivial delivery get filtered to keep
 *   noise from dominating the ratio.
 *
 * Usage:
 *   pnpm tsx scripts/verify-pricing-model.ts
 *   pnpm tsx scripts/verify-pricing-model.ts --db /custom/path/state.db
 *   pnpm tsx scripts/verify-pricing-model.ts --min-hours 2
 */

import { resolve } from 'node:path';

import { openDatabase, closeDatabase } from '@braiins-hashrate/daemon';

const EH_PER_PH = 1000;
const MS_PER_MIN = 60_000;

interface Args {
  dbPath: string;
  minHours: number;
}

function parseArgs(argv: string[]): Args {
  const projectRoot = process.cwd();
  let dbPath = resolve(projectRoot, 'data/state.db');
  let minHours = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--db' && argv[i + 1]) {
      dbPath = resolve(argv[i + 1]!);
      i += 1;
    } else if (a === '--min-hours' && argv[i + 1]) {
      minHours = Number(argv[i + 1]);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm tsx scripts/verify-pricing-model.ts [--db <path>] [--min-hours <n>]',
      );
      process.exit(0);
    }
  }
  return { dbPath, minHours };
}

interface ClosedBid {
  braiins_order_id: string;
  amount_consumed_sat: number;
  first_seen_at: number;
  last_seen_at: number;
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
  lifetime_h: number;
  avg_delivered_ph: number;
  total_ph_days: number;
  consumed_sat: number;
  avg_bid_price_sat_ph_day: number;
  expected_at_bid_sat: number;
  actual_over_expected_ratio: number;
  skipped_reason?: string;
}

// Minimal better-sqlite3 surface we rely on; avoids needing the package
// as a direct dep of the scripts folder since it's already installed via
// the daemon workspace.
interface RawSqliteDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

function loadClosedBids(raw: RawSqliteDb): ClosedBid[] {
  return raw
    .prepare(
      'SELECT braiins_order_id, amount_consumed_sat, first_seen_at, last_seen_at FROM closed_bids_cache ORDER BY first_seen_at ASC',
    )
    .all() as ClosedBid[];
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

/**
 * Reconstruct the piecewise-constant bid-price timeline from the event
 * log. Returns [] when the log is missing a CREATE for this bid — typical
 * for bids that predate migration 0009, or for bids that weren't
 * autopilot-owned. Those get reported as "skipped" in the output.
 */
function buildPriceSegments(events: BidEvent[], lifetimeEndAt: number): PriceSegment[] {
  const createIdx = events.findIndex((e) => e.kind === 'CREATE_BID');
  if (createIdx === -1) return [];
  const create = events[createIdx]!;
  if (create.new_price_sat == null) return [];

  const segments: PriceSegment[] = [];
  let currentPrice = create.new_price_sat;
  let segStart = create.occurred_at;

  for (let i = createIdx + 1; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.kind === 'EDIT_PRICE' && e.new_price_sat != null) {
      segments.push({ t_start: segStart, t_end: e.occurred_at, price_sat_eh_day: currentPrice });
      currentPrice = e.new_price_sat;
      segStart = e.occurred_at;
    } else if (e.kind === 'CANCEL_BID') {
      segments.push({ t_start: segStart, t_end: e.occurred_at, price_sat_eh_day: currentPrice });
      return segments;
    }
  }
  if (lifetimeEndAt > segStart) {
    segments.push({ t_start: segStart, t_end: lifetimeEndAt, price_sat_eh_day: currentPrice });
  }
  return segments;
}

function loadTicksInRange(raw: RawSqliteDb, startMs: number, endMs: number): TickRow[] {
  return raw
    .prepare(
      'SELECT tick_at, delivered_ph FROM tick_metrics WHERE tick_at >= ? AND tick_at <= ? ORDER BY tick_at ASC',
    )
    .all(startMs, endMs) as TickRow[];
}

/**
 * Sum PH-days delivered and the pay-your-bid expected spend across the
 * bid's price segments. Per-tick:
 *   ph_days       = delivered_ph × (dur_min / 1440)
 *   expected_sat  = price_sat_eh_day × delivered_ph × dur_min / 1_440_000
 *                   (divide by 1000 for EH→PH, by 1440 for min→day)
 */
function analyzeBid(raw: RawSqliteDb, bid: ClosedBid): BidReport {
  const events = loadBidEvents(raw, bid.braiins_order_id);
  const segments = buildPriceSegments(events, bid.last_seen_at);
  const lifetimeH = (bid.last_seen_at - bid.first_seen_at) / 3_600_000;

  if (segments.length === 0) {
    return {
      id: bid.braiins_order_id,
      lifetime_h: lifetimeH,
      avg_delivered_ph: 0,
      total_ph_days: 0,
      consumed_sat: bid.amount_consumed_sat,
      avg_bid_price_sat_ph_day: 0,
      expected_at_bid_sat: 0,
      actual_over_expected_ratio: NaN,
      skipped_reason: 'no bid_events (pre-migration bid or not autopilot-owned)',
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
  const avgBidPricePhDay = totalPhDays > 0 ? priceWeightedByPhDays / totalPhDays : 0;

  return {
    id: bid.braiins_order_id,
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
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtNum(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`→ opening ${args.dbPath}`);
  const handle = await openDatabase({ path: args.dbPath });
  try {
    const raw = handle.raw as unknown as RawSqliteDb;
    const bids = loadClosedBids(raw);
    console.log(`→ ${bids.length} closed bids in cache`);

    const reports: BidReport[] = bids.map((b) => analyzeBid(raw, b));

    const usable = reports.filter(
      (r) =>
        r.skipped_reason === undefined &&
        r.lifetime_h >= args.minHours &&
        r.total_ph_days > 0 &&
        r.expected_at_bid_sat > 0 &&
        Number.isFinite(r.actual_over_expected_ratio),
    );

    console.log('');
    console.log(
      'ID               | life(h) | avg PH | PH-days  | consumed sat | avg bid sat/PH/day | expected@bid    | actual/expected',
    );
    console.log(
      '-----------------+---------+--------+----------+--------------+--------------------+-----------------+---------------',
    );
    for (const r of reports) {
      if (r.skipped_reason) {
        console.log(
          `${r.id.slice(0, 16).padEnd(16)} | ${fmtNum(r.lifetime_h, 1).padStart(7)} |      — |        — |  ${fmtInt(r.consumed_sat).padStart(11)} |                  — |               — |   (skip: ${r.skipped_reason})`,
        );
        continue;
      }
      console.log(
        [
          r.id.slice(0, 16).padEnd(16),
          fmtNum(r.lifetime_h, 1).padStart(7),
          fmtNum(r.avg_delivered_ph, 2).padStart(6),
          fmtNum(r.total_ph_days, 3).padStart(8),
          fmtInt(r.consumed_sat).padStart(12),
          fmtInt(r.avg_bid_price_sat_ph_day).padStart(18),
          fmtInt(r.expected_at_bid_sat).padStart(15),
          fmtNum(r.actual_over_expected_ratio, 4).padStart(13),
        ].join(' | '),
      );
    }

    console.log('');
    console.log(`→ usable bids (≥${args.minHours}h, non-trivial delivery): ${usable.length}`);

    if (usable.length === 0) {
      console.log('');
      console.log(
        'Not enough usable data. Need at least one closed bid with bid_events history and actual delivery.',
      );
      return;
    }

    const ratios = usable.map((r) => r.actual_over_expected_ratio);
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
      console.log(` VERDICT: pay-at-ask / classic CLOB. Median discount vs bid: ${fmtNum(discountPct, 1)}%`);
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
