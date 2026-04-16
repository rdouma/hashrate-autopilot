/**
 * execute() — turn gated proposals into side effects.
 *
 * - **DRY_RUN** (default after boot): every allowed proposal becomes an
 *   `outcome: 'DRY_RUN'` record with a human-readable "would have …" note.
 *   No Braiins API mutation. No ledger write. No run-mode transition.
 * - **LIVE**: allowed proposals are dispatched to the Braiins client and
 *   reconciled to `owned_bids`. Failures become `outcome: 'FAILED'` with
 *   the error string; the loop keeps going so one bad bid doesn't stall
 *   the rest.
 * - Blocked proposals (any mode) record `outcome: 'BLOCKED'` with the
 *   gate denial reason.
 *
 * PAUSE is a controller-only transition — when LIVE it flips
 * `runtime_state.run_mode` to PAUSED; in DRY_RUN it's logged only.
 *
 * Every tick persists the full (state, proposals, gated, executed) tuple
 * to the `decisions` table. Dashboard reads those back.
 */

import type { BraiinsClient } from '@braiins-hashrate/braiins-client';

import type { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import type { DecisionsRepo } from '../state/repos/decisions.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { ExecutionResult, GateOutcome, Proposal, State } from './types.js';

export interface ExecuteDeps {
  readonly braiinsClient: BraiinsClient;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly now: () => number;
}

export async function execute(
  deps: ExecuteDeps,
  state: State,
  gated: readonly GateOutcome[],
): Promise<ExecutionResult[]> {
  const executed: ExecutionResult[] = [];

  for (const outcome of gated) {
    if (!outcome.allowed) {
      executed.push({ proposal: outcome.proposal, outcome: 'BLOCKED', reason: outcome.reason });
      continue;
    }
    if (state.run_mode === 'LIVE') {
      executed.push(await executeLive(deps, outcome.proposal));
    } else {
      executed.push({
        proposal: outcome.proposal,
        outcome: 'DRY_RUN',
        note: dryRunNote(outcome.proposal),
      });
    }
  }

  await deps.decisionsRepo.insertTick({
    state,
    proposals: gated.map((g) => g.proposal),
    gated,
    executed,
  });

  return executed;
}

async function executeLive(deps: ExecuteDeps, proposal: Proposal): Promise<ExecutionResult> {
  try {
    switch (proposal.kind) {
      case 'CREATE_BID': {
        const res = await deps.braiinsClient.placeBid({
          price_sat: proposal.price_sat,
          amount_sat: proposal.amount_sat,
          speed_limit_ph: proposal.speed_limit_ph,
          dest_upstream: {
            url: proposal.dest_pool_url,
            identity: proposal.dest_worker_name,
          },
          memo: 'braiins-hashrate-autopilot',
        });
        await deps.ownedBidsRepo.insert({
          braiins_order_id: res.id,
          cl_order_id: res.cl_order_id ?? null,
          created_at: deps.now(),
          price_sat: proposal.price_sat,
          amount_sat: proposal.amount_sat,
          speed_limit_ph: proposal.speed_limit_ph,
          last_known_status: 'BID_STATUS_CREATED',
        });
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `POST /spot/bid OK  id=${res.id}  (Telegram 2FA tap required)`,
        };
      }

      case 'EDIT_PRICE': {
        await deps.braiinsClient.editBid({
          bid_id: proposal.braiins_order_id,
          new_price_sat: proposal.new_price_sat,
        });
        if (proposal.new_price_sat < proposal.old_price_sat) {
          await deps.ownedBidsRepo.setLastPriceDecrease(
            proposal.braiins_order_id,
            deps.now(),
            proposal.new_price_sat,
          );
        }
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `PUT /spot/bid OK  ${proposal.old_price_sat} → ${proposal.new_price_sat} sat/EH/day`,
        };
      }

      case 'CANCEL_BID': {
        await deps.braiinsClient.cancelBid({ order_id: proposal.braiins_order_id });
        await deps.ownedBidsRepo.markCancelled(proposal.braiins_order_id);
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `DELETE /spot/bid OK  id=${proposal.braiins_order_id}`,
        };
      }

      case 'PAUSE': {
        await deps.runtimeRepo.patch({ run_mode: 'PAUSED' });
        return {
          proposal,
          outcome: 'EXECUTED',
          note: `run_mode → PAUSED (${proposal.reason})`,
        };
      }
    }
  } catch (err) {
    return {
      proposal,
      outcome: 'FAILED',
      error: (err as Error)?.message ?? String(err),
    };
  }
}

function dryRunNote(proposal: Proposal): string {
  switch (proposal.kind) {
    case 'CREATE_BID':
      return `would POST /spot/bid  price=${proposal.price_sat} amount=${proposal.amount_sat} speed=${proposal.speed_limit_ph} PH/s`;
    case 'EDIT_PRICE':
      return `would PUT /spot/bid  id=${proposal.braiins_order_id}  price=${proposal.old_price_sat} → ${proposal.new_price_sat}`;
    case 'CANCEL_BID':
      return `would DELETE /spot/bid  id=${proposal.braiins_order_id}`;
    case 'PAUSE':
      return `would transition run_mode to PAUSED (${proposal.reason})`;
  }
}
