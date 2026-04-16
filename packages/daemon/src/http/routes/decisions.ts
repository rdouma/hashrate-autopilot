import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import type { HttpServerDeps } from '../server.js';
import type { DecisionDetail, DecisionSummary } from '../types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export async function registerDecisionsRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { limit?: string; mode?: string } }>(
    '/api/decisions',
    async (req): Promise<DecisionSummary[]> => {
      const limit = clamp(Number.parseInt(req.query.limit ?? '', 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
      const mode = req.query.mode?.toUpperCase();
      const validMode =
        mode === 'DRY_RUN' || mode === 'LIVE' || mode === 'PAUSED' ? mode : undefined;
      return deps.decisionsRepo.listRecent(limit, validMode);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/decisions/:id',
    async (req, reply): Promise<DecisionDetail | { error: string }> => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id < 1) {
        reply.code(400);
        return { error: 'invalid id' };
      }
      // Drop down to the underlying Kysely query because DecisionsRepo
      // doesn't expose a findById yet (M4 scope). One-off here.
      const row = await app.decisionsQuery(id);
      if (!row) {
        reply.code(404);
        return { error: 'not found' };
      }
      return {
        id: row.id,
        tick_at: row.tick_at,
        run_mode: row.run_mode,
        action_mode: row.action_mode,
        proposal_count: safeJsonLen(row.proposed_json),
        observed: safeJson(row.observed_json),
        proposed: safeJson(row.proposed_json),
        gated: safeJson(row.gated_json),
        executed: safeJson(row.executed_json),
      };
    },
  );

  // Decorate a thin findById helper. (Avoids adding method churn to the
  // repo at this milestone; we just grab the row shape directly.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate('decisionsQuery', async (id: number) => {
    const row = await deps.decisionsRepo['db']
      .selectFrom('decisions')
      .selectAll()
      .where(sql`id`, '=', id)
      .executeTakeFirst();
    return row;
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeJsonLen(s: string): number {
  const v = safeJson(s);
  return Array.isArray(v) ? v.length : 0;
}

declare module 'fastify' {
  interface FastifyInstance {
    decisionsQuery(id: number): Promise<
      | {
          id: number;
          tick_at: number;
          run_mode: string;
          action_mode: string;
          observed_json: string;
          proposed_json: string;
          gated_json: string;
          executed_json: string;
        }
      | undefined
    >;
  }
}
