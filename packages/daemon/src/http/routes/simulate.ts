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
  /**
   * Count of simulated bid mutations in this range — each CREATE or
   * EDIT_PRICE the sim would have issued. Lets the Mutations stat card
   * answer "how much churn does this parameter set produce?" at a glance.
   * Zero for `actual` (we don't re-derive real mutations here; the live
   * stats endpoint does that from bid_events).
   */
  mutation_count: number;
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
        mutation_count: 0,
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
      simulated.mutation_count = simResult.mutationCount;

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
  /** CREATE (null→price) + EDIT_PRICE (price→different price) events. */
  mutationCount: number;
}

// Braiins server-side floor on consecutive price decreases (issue #32).
// Real controller reads this from `market.settings.min_bid_price_decrease_period_s`
// with a 600s fallback (gate.ts); the simulator uses the fallback directly
// since historical tick rows don't carry the market settings blob.
const BRAIINS_PRICE_DECREASE_COOLDOWN_MS = 10 * 60_000;

function simulate(rows: TickRow[], params: SimParams): SimResult {
  const prices: number[] = [];
  const filled: boolean[] = [];
  let bidPrice: number | null = null;
  let belowFloorSince: number | null = null;
  // Lower-ready timer: set when the current simulated bid is priced
  // above (fillable + overpay) by more than `minLowerDelta` — mirrors
  // the real controller's `lowerReadySince`. Reset when the condition
  // breaks so a brief market dip that reverses inside the patience
  // window can't trigger a lower.
  let lowerReadySince: number | null = null;
  let overrideUntil: number | null = null;
  // Tracks when the simulator last fired a price decrease, so we
  // can refuse the next one until Braiins' 10-min cooldown has
  // elapsed. Mirrors gate.ts's `isInsidePriceDecreaseCooldown`.
  let lastPriceDecreaseAt: number | null = null;
  let gapCount = 0;
  let gapMs = 0;
  let inGap = false;
  let mutationCount = 0;

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
    const desiredPrice = fillable + params.overpay;
    const targetPrice = Math.min(desiredPrice, effectiveCap);
    // Mirror decide.ts's `isMarketTooExpensive` guard: when the price
    // the operator would aim for (fillable + overpay) exceeds the
    // effective cap, the real controller returns [] — it refuses to
    // create or escalate a bid that would sit above the cap. The
    // simulator must do the same, otherwise it paints escalations at
    // exactly the cap on ticks the real autopilot would have skipped.
    const marketTooExpensive = desiredPrice > effectiveCap;
    const overrideActive = overrideUntil !== null && overrideUntil > r.tick_at;

    if (!marketTooExpensive) {
      if (bidPrice === null) {
        bidPrice = targetPrice;
        overrideUntil = r.tick_at + params.escalationWindowMs;
        mutationCount++;
      } else if (!overrideActive) {
        const current: number = bidPrice;
        if (belowFloorSince !== null) {
          const elapsed = r.tick_at - belowFloorSince;
          if (elapsed >= params.escalationWindowMs && current < targetPrice) {
            const naiveEscalation: number = params.escalationMode === 'market'
              ? targetPrice
              : Math.min(current + params.escalationStep, targetPrice);
            // Min-delta as a floor on the step (not a veto) — same
            // semantic as decide.ts: when the natural raise is below
            // min_delta we still move, just by min_delta instead of a
            // pixel. Clamped to effectiveCap so the floor doesn't
            // push us above the ceiling.
            const nextPrice = Math.min(
              Math.max(naiveEscalation, current + params.minLowerDelta),
              effectiveCap,
            );
            if (nextPrice > current) {
              mutationCount++;
              bidPrice = nextPrice;
              overrideUntil = r.tick_at + params.escalationWindowMs;
            }
          }
        }

        const lowerReadyLongEnough =
          lowerReadySince !== null &&
          (r.tick_at - lowerReadySince) >= params.lowerPatienceMs;
        // Braiins refuses consecutive lowerings within the cooldown
        // window (gate.ts:58). Without this gate the simulator would
        // happily fire lowers every `lower_patience_minutes` ticks,
        // overstating how nimble the autopilot is on downward moves.
        const decreaseCooldownActive =
          lastPriceDecreaseAt !== null &&
          r.tick_at - lastPriceDecreaseAt < BRAIINS_PRICE_DECREASE_COOLDOWN_MS;
        if (
          lowerReadyLongEnough &&
          !decreaseCooldownActive &&
          bidPrice !== null &&
          bidPrice >= targetPrice + params.minLowerDelta
        ) {
          if (targetPrice !== bidPrice) {
            mutationCount++;
            lastPriceDecreaseAt = r.tick_at;
          }
          bidPrice = targetPrice;
          overrideUntil = r.tick_at + params.escalationWindowMs;
        }
      }
    }

    const isFilled = bidPrice !== null && bidPrice >= fillable;
    prices.push(bidPrice ?? 0);
    filled.push(isFilled);

    // Advance the lower-ready timer based on the END-OF-TICK bid price.
    // Evaluating before the tick's own mutations would mean an
    // escalation that happened on this tick couldn't contribute to a
    // later lower, which is fine (the override lock prevents immediate
    // lowering anyway), but using end-of-tick keeps the timer in
    // lockstep with the real controller's tick.ts, which updates
    // lowerReadySince after the tick's state settles.
    if (bidPrice !== null && bidPrice > targetPrice + params.minLowerDelta) {
      if (lowerReadySince === null) lowerReadySince = r.tick_at;
    } else {
      lowerReadySince = null;
    }

    if (isFilled) {
      if (inGap) inGap = false;
      if (belowFloorSince !== null) belowFloorSince = null;
    } else {
      gapMs += dur;
      if (!inGap) { gapCount++; inGap = true; }
      if (belowFloorSince === null) belowFloorSince = r.tick_at;
    }
  }

  return { prices, filled, gapCount, gapMinutes: Math.round(gapMs / 60_000), mutationCount };
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
    // computeStats doesn't see the tick-to-tick bid transitions; the
    // simulate() loop owns `mutation_count`, and the route overwrites
    // `simulated.mutation_count` before returning. Zero is correct for
    // `actual`, which comes from here (real-mode mutation counts live
    // in the /api/stats endpoint, derived from bid_events).
    mutation_count: 0,
  };
}
