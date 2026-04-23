/**
 * Append-only log of every control-loop tick.
 *
 * One row per tick, with the full observed / proposed / gated / executed
 * payloads as JSON so that ad-hoc forensic queries can replay the decision
 * context later. See architecture §5 and SPEC §9
 * ("All autopilot decisions are logged with the input state").
 */

import type { Kysely } from 'kysely';

import type { RunMode } from '@braiins-hashrate/shared';

import type { Database } from '../types.js';

import type { ExecutionResult, GateOutcome, Proposal, State } from '../../controller/types.js';

export class DecisionsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insertTick(args: {
    state: State;
    proposals: readonly Proposal[];
    gated: readonly GateOutcome[];
    executed: readonly ExecutionResult[];
  }): Promise<void> {
    await this.db
      .insertInto('decisions')
      .values({
        tick_at: args.state.tick_at,
        observed_json: JSON.stringify(trimStateForStorage(args.state)),
        proposed_json: JSON.stringify(args.proposals),
        gated_json: JSON.stringify(args.gated),
        executed_json: JSON.stringify(args.executed),
        run_mode: args.state.run_mode,
        action_mode: 'NORMAL' as const,
      })
      .execute();
  }

  async listRecent(
    limit = 50,
    runModeFilter?: RunMode,
  ): Promise<
    Array<{
      id: number;
      tick_at: number;
      run_mode: string;
      action_mode: string;
      proposal_count: number;
    }>
  > {
    let q = this.db
      .selectFrom('decisions')
      .select(['id', 'tick_at', 'run_mode', 'action_mode', 'proposed_json'])
      .orderBy('tick_at', 'desc')
      .limit(limit);
    if (runModeFilter) {
      q = q.where('run_mode', '=', runModeFilter);
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      tick_at: r.tick_at,
      run_mode: r.run_mode,
      action_mode: r.action_mode,
      proposal_count: safeJsonParse<unknown[]>(r.proposed_json, []).length,
    }));
  }

  /**
   * Delete every decision row with tick_at < cutoffMs, regardless of
   * whether it carried proposals. Use via the uneventful/eventful
   * variants below; this is the raw primitive.
   */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const result = await this.db
      .deleteFrom('decisions')
      .where('tick_at', '<', cutoffMs)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /**
   * Delete "uneventful" decisions (empty proposed_json array) older
   * than cutoffMs. These are the vast majority of rows and carry no
   * forensic value — the tick saw nothing to do.
   */
  async pruneUneventfulOlderThan(cutoffMs: number): Promise<number> {
    // SQLite has no JSON array-length in every build, but
    // proposed_json = '[]' for every uneventful tick (both the empty
    // array path and a missing-proposals-array path resolve to '[]'
    // after JSON.stringify). Match the literal.
    const result = await this.db
      .deleteFrom('decisions')
      .where('tick_at', '<', cutoffMs)
      .where('proposed_json', '=', '[]')
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /**
   * Delete decision-bearing rows (proposed_json != '[]') older than
   * cutoffMs. Should run with a much longer retention than the
   * uneventful prune — these are the forensic records.
   */
  async pruneEventfulOlderThan(cutoffMs: number): Promise<number> {
    const result = await this.db
      .deleteFrom('decisions')
      .where('tick_at', '<', cutoffMs)
      .where('proposed_json', '!=', '[]')
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Strip bulky data from the State before storing in the decisions
 * table. The full order book (150+ bid levels, market settings, fee
 * schedule) accounts for ~90% of the JSON but is never needed for
 * forensic analysis. Keep the asks (used by decide()), drop the bids,
 * drop static settings/fees, and trim balance to essentials.
 */
function trimStateForStorage(state: State): unknown {
  const { market, balance, config, ...rest } = state;
  return {
    ...rest,
    config: {
      target_hashrate_ph: config.target_hashrate_ph,
      minimum_floor_hashrate_ph: config.minimum_floor_hashrate_ph,
      max_bid_sat_per_eh_day: config.max_bid_sat_per_eh_day,
      max_overpay_vs_hashprice_sat_per_eh_day:
        config.max_overpay_vs_hashprice_sat_per_eh_day,
      bid_budget_sat: config.bid_budget_sat,
      cheap_target_hashrate_ph: config.cheap_target_hashrate_ph,
      cheap_threshold_pct: config.cheap_threshold_pct,
      cheap_sustained_window_minutes: config.cheap_sustained_window_minutes,
    },
    market: market
      ? {
          best_bid_sat: market.best_bid_sat,
          best_ask_sat: market.best_ask_sat,
          asks: market.orderbook.asks,
          tick_size_sat: market.settings.tick_size_sat,
          min_bid_speed_limit_ph: market.settings.min_bid_speed_limit_ph,
        }
      : null,
    balance: balance?.accounts?.map((a) => ({
      available_balance_sat: a.available_balance_sat,
      blocked_balance_sat: a.blocked_balance_sat,
    })) ?? null,
  };
}
