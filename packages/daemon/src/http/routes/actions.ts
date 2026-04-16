/**
 * Manual operator overrides.
 *
 * These bypass the usual tick-driven logic so the operator can take
 * direct action from the dashboard when they disagree with the
 * autopilot's pacing.
 *
 * - POST /api/actions/tick-now — runs a full observe→decide→gate→execute
 *   tick immediately, without waiting for the interval timer.
 * - POST /api/actions/bump-price — runs one EDIT_PRICE on the current
 *   owned bid, adding `fill_escalation_step_sat_per_eh_day` on top of its
 *   current price. Still capped by `max_price_sat_per_eh_day`.
 */

import type { FastifyInstance } from 'fastify';

import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { loadSecrets } from '../../config/secrets.js';
import type { HttpServerDeps } from '../server.js';

export interface ActionDeps extends HttpServerDeps {
  /** Path to the secrets file — needed to materialise an owner-token client on demand. */
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
      const result = await deps.controller.tick();
      return {
        ok: true,
        tick_at: result.state.tick_at,
        proposals: result.proposals.length,
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

  app.post('/api/actions/bump-price', async (_req, reply) => {
    const last = deps.controller.getLastResult();
    if (!last || last.state.owned_bids.length === 0) {
      reply.code(409);
      return { ok: false, error: 'no owned bid to bump' };
    }
    const config = await deps.configRepo.get();
    if (!config) {
      reply.code(500);
      return { ok: false, error: 'config missing' };
    }
    const primary = [...last.state.owned_bids].sort((a, b) =>
      a.braiins_order_id.localeCompare(b.braiins_order_id),
    )[0]!;
    const step = config.fill_escalation_step_sat_per_eh_day;
    const newPrice = Math.min(primary.price_sat + step, config.max_price_sat_per_eh_day);
    if (newPrice <= primary.price_sat) {
      reply.code(409);
      return {
        ok: false,
        error: `already at or above cap ${config.max_price_sat_per_eh_day} sat/EH/day`,
      };
    }

    const runtime = await deps.runtimeRepo.get();
    if (!runtime) {
      reply.code(500);
      return { ok: false, error: 'runtime missing' };
    }
    if (runtime.run_mode !== 'LIVE') {
      reply.code(409);
      return {
        ok: false,
        error: `run_mode is ${runtime.run_mode} — can't send EDIT_PRICE outside LIVE`,
      };
    }

    // Build an owner client on demand — we don't keep tokens in the HTTP server.
    const secrets = await loadSecrets(deps.secretsPath, {
      env: { ...process.env, SOPS_AGE_KEY_FILE: deps.ageKeyPath },
    });
    const client = createBraiinsClient({
      ownerToken: secrets.braiins_owner_token,
      ...(secrets.braiins_read_only_token
        ? { readOnlyToken: secrets.braiins_read_only_token }
        : {}),
    });

    try {
      await client.editBid({
        bid_id: primary.braiins_order_id,
        new_price_sat: newPrice,
      });
      if (newPrice < primary.price_sat) {
        await deps.ownedBidsRepo.setLastPriceDecrease(
          primary.braiins_order_id,
          Date.now(),
          newPrice,
        );
      }
      return {
        ok: true,
        braiins_order_id: primary.braiins_order_id,
        old_price_sat_per_eh_day: primary.price_sat,
        new_price_sat_per_eh_day: newPrice,
      };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: (err as Error).message };
    }
  });
}
