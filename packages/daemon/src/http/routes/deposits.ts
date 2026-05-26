/**
 * GET /api/deposits
 *
 * Returns credited Braiins deposits from the `braiins_deposits` table.
 * The dashboard renders these as amber fuel-icon markers on the Price
 * chart (#211). Only rows with `notified_available = 1` (i.e. the
 * deposit reached DEPOSIT_STATUS_CREDITED) are returned.
 */

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../../state/types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface DepositView {
  readonly tx_id: string;
  readonly amount_sat: number;
  readonly address: string | null;
  readonly first_seen_at_ms: number;
}

export interface DepositsResponse {
  readonly deposits: readonly DepositView[];
}

export interface DepositsDeps {
  readonly db: Kysely<Database>;
}

export async function registerDepositsRoute(
  app: FastifyInstance,
  deps: DepositsDeps,
): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/deposits',
    async (req): Promise<DepositsResponse> => {
      const limit = clamp(
        Number.parseInt(req.query.limit ?? '', 10) || DEFAULT_LIMIT,
        1,
        MAX_LIMIT,
      );
      const rows = await deps.db
        .selectFrom('braiins_deposits')
        .select(['tx_id', 'amount_sat', 'address', 'first_seen_at_ms'])
        .where('notified_available', '=', 1)
        .orderBy('first_seen_at_ms', 'desc')
        .limit(limit)
        .execute();
      const deposits = rows
        .reverse()
        .map((r) => ({
          tx_id: String(r.tx_id),
          amount_sat: Number(r.amount_sat),
          address: typeof r.address === 'string' ? r.address : null,
          first_seen_at_ms: Number(r.first_seen_at_ms),
        }));
      return { deposits };
    },
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
