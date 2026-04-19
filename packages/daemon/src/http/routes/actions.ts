/**
 * Manual operator overrides.
 *
 * These bypass the usual tick-driven logic so the operator can take
 * direct action from the dashboard when they disagree with the
 * autopilot's pacing.
 *
 * - POST /api/actions/tick-now — runs a full observe→decide→gate→execute
 *   tick immediately AND arms a one-shot pacing bypass so decide()
 *   skips its patience / escalation timers for that tick. The intent
 *   is "do the thing you were going to do anyway, just without
 *   waiting"; server-side gates (Braiins cooldown, run_mode) still
 *   apply.
 */

import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

export interface ActionDeps extends HttpServerDeps {
  /** Path to the secrets file — reserved for future actions that need an owner-token client. */
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
      // Manual operator action — bypass any stale post-edit lock so the
      // controller is free to make its current best decision instead of
      // sitting on its hands until the auto-set window expires.
      const clearedOverrideUntil = deps.controller.clearManualOverride();
      const result = await deps.controller.tick();
      return {
        ok: true,
        tick_at: result.state.tick_at,
        proposals: result.proposals.length,
        cleared_override_until_ms: clearedOverrideUntil,
        executed: result.executed.map((e) => ({
          kind: e.proposal.kind,
          outcome: e.outcome,
        })),
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

}
