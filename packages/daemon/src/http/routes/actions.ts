/**
 * Manual operator overrides.
 *
 * These bypass the usual tick-driven logic so the operator can take
 * direct action from the dashboard when they disagree with the
 * autopilot's pacing.
 *
 * - POST /api/actions/tick-now - runs a full observe→decide→gate→execute
 *   tick immediately AND arms a one-shot pacing bypass so decide()
 *   skips its patience / escalation timers for that tick. The intent
 *   is "do the thing you were going to do anyway, just without
 *   waiting"; server-side gates (Braiins cooldown, run_mode) still
 *   apply.
 */

import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

export interface ActionDeps extends HttpServerDeps {
  /** Path to the secrets file - reserved for future actions that need an owner-token client. */
  readonly secretsPath: string;
  /** Path to the age key for sops. */
  readonly ageKeyPath: string;
}

export async function registerActionRoutes(
  app: FastifyInstance,
  deps: ActionDeps,
): Promise<void> {
  app.post('/api/actions/tick-now', async (_req, reply) => {
    try {
      // Manual operator action - just run a fresh tick. Post-#49
      // the controller no longer has self-imposed patience / override
      // timers to bypass; decide() is stateless on those dimensions.
      // Server-side gates (Braiins price-decrease cooldown, run_mode)
      // are untouched.
      const result = await deps.controller.tick();
      return {
        ok: true,
        tick_at: result.state.tick_at,
        proposals: result.proposals.length,
        cleared_override_until_ms: null,
        executed: result.executed.map((e) => ({
          kind: e.proposal.kind,
          outcome: e.outcome,
          // Surface the gate reason on BLOCKED (e.g. Braiins's 10-min
          // price-decrease cooldown) and the error text on FAILED so
          // the dashboard can tell the operator exactly why the
          // decision didn't land, instead of just "tick ok - 0
          // proposals" with no explanation.
          reason:
            e.outcome === 'BLOCKED'
              ? e.reason
              : e.outcome === 'FAILED'
                ? e.error
                : null,
        })),
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

}
