/**
 * GET /api/reward-events
 *
 * Returns the most recent rows from the `reward_events` table - one per
 * coinbase output the payout observer (Electrs or bitcoind) has
 * detected paying the configured BTC payout address. The dashboard
 * polls this to drive the audible block-found notification (#88):
 * each tab tracks the max `id` seen in localStorage and rings the
 * configured sound once when a new id appears (no on-load false
 * positives).
 *
 * Returned rows are ordered by `id` ASC so callers can simply keep the
 * largest id they've seen and ask "anything > N?" - no since-filter
 * needed at this scale (a home miner sees on the order of minutes-
 * to-hours between events; the default 50-row cap is plenty of
 * headroom).
 */

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../../state/types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface RewardEventView {
  readonly id: number;
  readonly txid: string;
  readonly vout: number;
  readonly block_height: number;
  readonly value_sat: number;
  readonly detected_at: number;
  readonly reorged: boolean;
}

export interface RewardEventsResponse {
  readonly events: readonly RewardEventView[];
}

export interface RewardEventsDeps {
  readonly db: Kysely<Database>;
}

export async function registerRewardEventsRoute(
  app: FastifyInstance,
  deps: RewardEventsDeps,
): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/reward-events',
    async (req): Promise<RewardEventsResponse> => {
      const limit = clamp(
        Number.parseInt(req.query.limit ?? '', 10) || DEFAULT_LIMIT,
        1,
        MAX_LIMIT,
      );
      const rows = await deps.db
        .selectFrom('reward_events')
        .select(['id', 'txid', 'vout', 'block_height', 'value_sat', 'detected_at', 'reorged'])
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      // Re-sort ASC so the newest row is last - matches the
      // "track max id" consumption pattern.
      const events = rows
        .slice()
        .reverse()
        .map((r) => ({
          id: Number(r.id),
          txid: String(r.txid),
          vout: Number(r.vout),
          block_height: Number(r.block_height),
          value_sat: Number(r.value_sat),
          detected_at: Number(r.detected_at),
          reorged: Number(r.reorged) === 1,
        }));
      return { events };
    },
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
