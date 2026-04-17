/**
 * POST /api/simulate
 *
 * Stateless backtest: replays historical tick_metrics with a set of
 * candidate autopilot parameters and returns simulated uptime, cost,
 * and a tick-by-tick price trace the dashboard can overlay on the
 * price chart.
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

interface SimulateRequest {
  range?: string;
  overpay_sat_per_eh_day: number;
  max_bid_sat_per_eh_day: number;
  fill_escalation_step_sat_per_eh_day: number;
  fill_escalation_after_minutes: number;
  lower_patience_minutes: number;
  min_lower_delta_sat_per_eh_day: number;
}

interface SimulatedTick {
  tick_at: number;
  simulated_price_sat_per_eh_day: number;
  filled: boolean;
}

export interface SimulateResponse {
  actual: {
    uptime_pct: number | null;
    avg_cost_sat_per_eh_day: number | null;
    gap_count: number;
    gap_minutes: number;
  };
  simulated: {
    uptime_pct: number | null;
    avg_cost_sat_per_eh_day: number | null;
    gap_count: number;
    gap_minutes: number;
  };
  ticks: SimulatedTick[];
  tick_count: number;
  range: ChartRange;
}

interface TickRow {
  tick_at: number;
  delivered_ph: number;
  fillable_ask_sat_per_eh_day: number | null;
  our_primary_price_sat_per_eh_day: number | null;
  max_bid_sat_per_eh_day: number | null;
  floor_ph: number;
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
          'fillable_ask_sat_per_eh_day',
          'our_primary_price_sat_per_eh_day',
          'max_bid_sat_per_eh_day',
          'floor_ph',
        ])
        .where('tick_at', '>=', sinceMs)
        .orderBy('tick_at', 'asc')
        .execute();

      if (rows.length < 2) {
        return {
          actual: { uptime_pct: null, avg_cost_sat_per_eh_day: null, gap_count: 0, gap_minutes: 0 },
          simulated: { uptime_pct: null, avg_cost_sat_per_eh_day: null, gap_count: 0, gap_minutes: 0 },
          ticks: [],
          tick_count: 0,
          range,
        };
      }

      const actual = computeActual(rows);
      const { summary: simulated, ticks } = simulate(rows, {
        overpay: body.overpay_sat_per_eh_day,
        maxBid: body.max_bid_sat_per_eh_day,
        escalationStep: body.fill_escalation_step_sat_per_eh_day,
        escalationWindowMs: body.fill_escalation_after_minutes * 60_000,
        lowerPatienceMs: body.lower_patience_minutes * 60_000,
        minLowerDelta: body.min_lower_delta_sat_per_eh_day,
      });

      return { actual, simulated, ticks, tick_count: rows.length, range };
    },
  );
}

interface SimParams {
  overpay: number;
  maxBid: number;
  escalationStep: number;
  escalationWindowMs: number;
  lowerPatienceMs: number;
  minLowerDelta: number;
}

function computeActual(rows: TickRow[]) {
  let uptimeDur = 0;
  let totalDur = 0;
  let costWeighted = 0;
  let costDur = 0;
  let gapCount = 0;
  let gapMs = 0;
  let inGap = false;

  for (let i = 0; i < rows.length; i++) {
    const dur = i < rows.length - 1 ? rows[i + 1]!.tick_at - rows[i]!.tick_at : 60_000;
    const r = rows[i]!;
    totalDur += dur;

    if (r.delivered_ph > 0) {
      uptimeDur += dur;
      if (inGap) inGap = false;
    } else {
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
    }

    if (r.our_primary_price_sat_per_eh_day !== null && r.delivered_ph > 0) {
      costWeighted += r.our_primary_price_sat_per_eh_day * dur;
      costDur += dur;
    }
  }

  return {
    uptime_pct: totalDur > 0 ? (uptimeDur / totalDur) * 100 : null,
    avg_cost_sat_per_eh_day: costDur > 0 ? costWeighted / costDur : null,
    gap_count: gapCount,
    gap_minutes: Math.round(gapMs / 60_000),
  };
}

function simulate(rows: TickRow[], params: SimParams) {
  let bidPrice: number | null = null;
  let belowFloorSince: number | null = null;
  let aboveFloorSince: number | null = null;
  let overrideUntil: number | null = null;

  let uptimeDur = 0;
  let totalDur = 0;
  let costWeighted = 0;
  let costDur = 0;
  let gapCount = 0;
  let gapMs = 0;
  let inGap = false;

  const ticks: SimulatedTick[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const dur = i < rows.length - 1 ? rows[i + 1]!.tick_at - r.tick_at : 60_000;
    const fillable = r.fillable_ask_sat_per_eh_day;

    // Clear expired override
    if (overrideUntil !== null && overrideUntil <= r.tick_at) {
      overrideUntil = null;
    }

    if (fillable === null) {
      // No market data — carry forward
      ticks.push({
        tick_at: r.tick_at,
        simulated_price_sat_per_eh_day: bidPrice ?? 0,
        filled: false,
      });
      totalDur += dur;
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
      continue;
    }

    const targetPrice = Math.min(fillable + params.overpay, params.maxBid);
    const overrideActive = overrideUntil !== null && overrideUntil > r.tick_at;

    if (bidPrice === null) {
      // No bid yet — create
      bidPrice = targetPrice;
      overrideUntil = r.tick_at + params.escalationWindowMs;
    } else if (!overrideActive) {
      // Escalation: if below floor long enough and underbidding
      if (belowFloorSince !== null) {
        const elapsed = r.tick_at - belowFloorSince;
        if (elapsed >= params.escalationWindowMs && bidPrice < targetPrice) {
          const stepped = Math.min(bidPrice + params.escalationStep, targetPrice);
          bidPrice = stepped;
          overrideUntil = r.tick_at + params.escalationWindowMs;
        }
      }

      // Lowering: if above floor long enough and overpaying
      const aboveFloorLongEnough =
        aboveFloorSince !== null &&
        (r.tick_at - aboveFloorSince) >= params.lowerPatienceMs;
      if (
        aboveFloorLongEnough &&
        bidPrice > targetPrice + params.minLowerDelta
      ) {
        bidPrice = targetPrice;
        overrideUntil = r.tick_at + params.escalationWindowMs;
      }
    }

    const filled = bidPrice >= fillable;

    ticks.push({
      tick_at: r.tick_at,
      simulated_price_sat_per_eh_day: bidPrice,
      filled,
    });

    totalDur += dur;

    // Track floor state using actual floor from config
    if (filled) {
      uptimeDur += dur;
      if (inGap) inGap = false;
      if (belowFloorSince !== null) {
        belowFloorSince = null;
        aboveFloorSince = r.tick_at;
      } else if (aboveFloorSince === null) {
        aboveFloorSince = r.tick_at;
      }
      costWeighted += bidPrice * dur;
      costDur += dur;
    } else {
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
      if (belowFloorSince === null) {
        belowFloorSince = r.tick_at;
        aboveFloorSince = null;
      }
    }
  }

  return {
    summary: {
      uptime_pct: totalDur > 0 ? (uptimeDur / totalDur) * 100 : null,
      avg_cost_sat_per_eh_day: costDur > 0 ? costWeighted / costDur : null,
      gap_count: gapCount,
      gap_minutes: Math.round(gapMs / 60_000),
    },
    ticks,
  };
}
