/**
 * POST /api/simulate
 *
 * Stateless backtest: replays historical tick_metrics with a set of
 * candidate autopilot parameters and returns simulated uptime, cost,
 * and a tick-by-tick price trace the dashboard overlays on the charts.
 *
 * The operator's 1 PH/s bid is a price-taker — it doesn't move the
 * market — so the counterfactual is reliable: "if my bid had been X
 * at this tick, would I have been filled?"
 *
 * Fill model: simulated_bid >= fillable_ask → filled, else → gap.
 */

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { Database } from '../../state/types.js';

const EH_PER_PH = 1000;

interface SimulateRequest {
  range?: string;
  overpay_sat_per_eh_day: number;
  max_bid_sat_per_eh_day: number;
  /**
   * Dynamic-cap allowance (issue #27). When non-null, effective cap
   * per tick = min(max_bid, hashprice + this). Matches decide()'s
   * `effectiveCap` computation so the simulator can't escalate
   * above a ceiling the real controller would refuse to cross.
   * Null / 0 disables the dynamic cap and falls back to max_bid.
   */
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
  fill_escalation_step_sat_per_eh_day: number;
  fill_escalation_after_minutes: number;
  lower_patience_minutes: number;
  min_lower_delta_sat_per_eh_day: number;
  escalation_mode: 'market' | 'dampened';
}

interface SimulatedTick {
  tick_at: number;
  simulated_price_sat_per_ph_day: number;
  delivered_ph: number;
}

interface StatsSummary {
  uptime_pct: number | null;
  avg_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  avg_overpay_sat_per_ph_day: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  gap_count: number;
  gap_minutes: number;
}

export interface SimulateResponse {
  actual: StatsSummary;
  simulated: StatsSummary;
  ticks: SimulatedTick[];
  tick_count: number;
  range: ChartRange;
}

interface TickRow {
  tick_at: number;
  delivered_ph: number;
  target_ph: number;
  floor_ph: number;
  fillable_ask_sat_per_eh_day: number | null;
  our_primary_price_sat_per_eh_day: number | null;
  hashprice_sat_per_eh_day: number | null;
}

export async function registerSimulateRoute(
  app: FastifyInstance,
  deps: { db: Kysely<Database> },
): Promise<void> {
  app.post<{ Body: SimulateRequest }>(
    '/api/simulate',
    async (req): Promise<SimulateResponse> => {
      const body = req.body;
      const range = parseChartRange(body.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];
      const nowMs = Date.now();
      const sinceMs = spec.windowMs === null ? 0 : nowMs - spec.windowMs;

      const rows = await deps.db
        .selectFrom('tick_metrics')
        .select([
          'tick_at',
          'delivered_ph',
          'target_ph',
          'floor_ph',
          'fillable_ask_sat_per_eh_day',
          'our_primary_price_sat_per_eh_day',
          'hashprice_sat_per_eh_day',
        ])
        .where('tick_at', '>=', sinceMs)
        .orderBy('tick_at', 'asc')
        .execute();

      const empty: StatsSummary = {
        uptime_pct: null,
        avg_hashrate_ph: null,
        total_ph_hours: null,
        avg_cost_per_ph_sat_per_ph_day: null,
        avg_overpay_sat_per_ph_day: null,
        avg_overpay_vs_hashprice_sat_per_ph_day: null,
        gap_count: 0,
        gap_minutes: 0,
      };

      if (rows.length < 2) {
        return { actual: empty, simulated: empty, ticks: [], tick_count: 0, range };
      }

      const actual = computeStats(rows, (r) => ({
        price_eh: r.our_primary_price_sat_per_eh_day,
        delivered: r.delivered_ph,
        target: r.target_ph,
      }));

      const simResult = simulate(rows, {
        overpay: body.overpay_sat_per_eh_day,
        maxBid: body.max_bid_sat_per_eh_day,
        maxOverpayVsHashprice: body.max_overpay_vs_hashprice_sat_per_eh_day ?? null,
        escalationStep: body.fill_escalation_step_sat_per_eh_day,
        escalationWindowMs: body.fill_escalation_after_minutes * 60_000,
        lowerPatienceMs: body.lower_patience_minutes * 60_000,
        minLowerDelta: body.min_lower_delta_sat_per_eh_day,
        escalationMode: body.escalation_mode ?? 'dampened',
      });

      const simulated = computeStats(rows, (_r, i) => ({
        price_eh: simResult.prices[i]!,
        delivered: simResult.filled[i]! ? rows[i]!.target_ph : 0,
        target: rows[i]!.target_ph,
      }));
      simulated.gap_count = simResult.gapCount;
      simulated.gap_minutes = simResult.gapMinutes;

      const ticks: SimulatedTick[] = rows.map((r, i) => ({
        tick_at: r.tick_at,
        simulated_price_sat_per_ph_day: simResult.prices[i]! / EH_PER_PH,
        delivered_ph: simResult.filled[i]! ? r.target_ph : 0,
      }));

      return { actual, simulated, ticks, tick_count: rows.length, range };
    },
  );
}

// -------------------------------------------------------------------------

interface SimParams {
  overpay: number;
  maxBid: number;
  /** Null disables; otherwise effective cap per tick uses hashprice + this. */
  maxOverpayVsHashprice: number | null;
  escalationStep: number;
  escalationWindowMs: number;
  lowerPatienceMs: number;
  minLowerDelta: number;
  escalationMode: 'market' | 'dampened';
}

interface SimResult {
  prices: number[];   // simulated bid price (sat/EH/day) per tick
  filled: boolean[];  // whether each tick would be filled
  gapCount: number;
  gapMinutes: number;
}

function simulate(rows: TickRow[], params: SimParams): SimResult {
  const prices: number[] = [];
  const filled: boolean[] = [];
  let bidPrice: number | null = null;
  let belowFloorSince: number | null = null;
  let aboveFloorSince: number | null = null;
  let overrideUntil: number | null = null;
  let gapCount = 0;
  let gapMs = 0;
  let inGap = false;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const dur = i < rows.length - 1 ? rows[i + 1]!.tick_at - r.tick_at : 60_000;
    const fillable = r.fillable_ask_sat_per_eh_day;

    if (overrideUntil !== null && overrideUntil <= r.tick_at) {
      overrideUntil = null;
    }

    if (fillable === null) {
      prices.push(bidPrice ?? 0);
      filled.push(false);
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
      continue;
    }

    // Effective cap per tick — mirrors decide.ts's `effectiveCap`.
    // When the dynamic cap is configured AND hashprice is known for
    // this tick, use the tighter of the two ceilings. Otherwise fall
    // back to the fixed max_bid.
    const hashprice = r.hashprice_sat_per_eh_day;
    const dynamicCap =
      params.maxOverpayVsHashprice !== null && hashprice !== null
        ? hashprice + params.maxOverpayVsHashprice
        : null;
    const effectiveCap =
      dynamicCap !== null ? Math.min(params.maxBid, dynamicCap) : params.maxBid;
    const targetPrice = Math.min(fillable + params.overpay, effectiveCap);
    const overrideActive = overrideUntil !== null && overrideUntil > r.tick_at;

    if (bidPrice === null) {
      bidPrice = targetPrice;
      overrideUntil = r.tick_at + params.escalationWindowMs;
    } else if (!overrideActive) {
      if (belowFloorSince !== null) {
        const elapsed = r.tick_at - belowFloorSince;
        if (elapsed >= params.escalationWindowMs && bidPrice < targetPrice) {
          bidPrice = params.escalationMode === 'market'
            ? targetPrice
            : Math.min(bidPrice + params.escalationStep, targetPrice);
          overrideUntil = r.tick_at + params.escalationWindowMs;
        }
      }

      const aboveFloorLongEnough =
        aboveFloorSince !== null &&
        (r.tick_at - aboveFloorSince) >= params.lowerPatienceMs;
      if (aboveFloorLongEnough && bidPrice > targetPrice + params.minLowerDelta) {
        bidPrice = targetPrice;
        overrideUntil = r.tick_at + params.escalationWindowMs;
      }
    }

    const isFilled = bidPrice >= fillable;
    prices.push(bidPrice);
    filled.push(isFilled);

    if (isFilled) {
      if (inGap) inGap = false;
      if (belowFloorSince !== null) {
        belowFloorSince = null;
        aboveFloorSince = r.tick_at;
      } else if (aboveFloorSince === null) {
        aboveFloorSince = r.tick_at;
      }
    } else {
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
      if (belowFloorSince === null) {
        belowFloorSince = r.tick_at;
        aboveFloorSince = null;
      }
    }
  }

  return { prices, filled, gapCount, gapMinutes: Math.round(gapMs / 60_000) };
}

// -------------------------------------------------------------------------

function computeStats(
  rows: TickRow[],
  extract: (r: TickRow, i: number) => {
    price_eh: number | null;
    delivered: number;
    target: number;
  },
): StatsSummary {
  let uptimeDur = 0;
  let totalDur = 0;
  let hashrateWeighted = 0;
  let costWeighted = 0;
  let costDur = 0;
  let overpayWeighted = 0;
  let overpayDur = 0;
  let overpayHpWeighted = 0;
  let overpayHpDur = 0;
  let gapCount = 0;
  let gapMs = 0;
  let inGap = false;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const dur = i < rows.length - 1 ? rows[i + 1]!.tick_at - r.tick_at : 60_000;
    const { price_eh, delivered } = extract(r, i);
    totalDur += dur;
    hashrateWeighted += delivered * dur;

    if (delivered > 0) {
      uptimeDur += dur;
      if (inGap) inGap = false;
    } else {
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
    }

    if (price_eh !== null && delivered > 0) {
      costWeighted += price_eh * delivered * dur;
      costDur += delivered * dur;
    }

    if (price_eh !== null && r.fillable_ask_sat_per_eh_day !== null) {
      overpayWeighted += (price_eh - r.fillable_ask_sat_per_eh_day) * dur;
      overpayDur += dur;
    }

    if (price_eh !== null && r.hashprice_sat_per_eh_day !== null) {
      overpayHpWeighted += (price_eh - r.hashprice_sat_per_eh_day) * dur;
      overpayHpDur += dur;
    }
  }

  return {
    uptime_pct: totalDur > 0 ? (uptimeDur / totalDur) * 100 : null,
    avg_hashrate_ph: totalDur > 0 ? hashrateWeighted / totalDur : null,
    total_ph_hours: hashrateWeighted / 3_600_000,
    avg_cost_per_ph_sat_per_ph_day: costDur > 0 ? costWeighted / costDur / EH_PER_PH : null,
    avg_overpay_sat_per_ph_day: overpayDur > 0 ? overpayWeighted / overpayDur / EH_PER_PH : null,
    avg_overpay_vs_hashprice_sat_per_ph_day: overpayHpDur > 0 ? overpayHpWeighted / overpayHpDur / EH_PER_PH : null,
    gap_count: gapCount,
    gap_minutes: Math.round(gapMs / 60_000),
  };
}
