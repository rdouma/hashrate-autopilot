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
        observed_json: JSON.stringify(args.state),
        proposed_json: JSON.stringify(args.proposals),
        gated_json: JSON.stringify(args.gated),
        executed_json: JSON.stringify(args.executed),
        run_mode: args.state.run_mode,
        action_mode: args.state.action_mode,
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
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
