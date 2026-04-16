/**
 * gate() — applies the SPEC §7.3 mutation-gate to every proposal and also
 * enforces client-side pacing rules the market settings give us.
 *
 * The core `canMutate()` check lives in `@braiins-hashrate/shared`. This
 * wrapper adapts proposals (CREATE_BID / EDIT_PRICE / CANCEL_BID / PAUSE)
 * to the gate's (create / edit / cancel) vocabulary and layers on the
 * `min_bid_price_decrease_period_s` cooldown.
 */

import { canMutate, type MutationAction } from '@braiins-hashrate/shared';

import type { GateDenialReason, GateOutcome, Proposal, State } from './types.js';

export function gate(proposals: readonly Proposal[], state: State): GateOutcome[] {
  return proposals.map((p) => gateOne(p, state));
}

function gateOne(proposal: Proposal, state: State): GateOutcome {
  // PAUSE is not a Braiins mutation — it's an internal run-mode transition.
  // Always "allowed" in the sense that the tick driver will act on it.
  if (proposal.kind === 'PAUSE') {
    return { proposal, allowed: true };
  }

  const action: MutationAction = mapToGateAction(proposal);
  const base = canMutate({
    runMode: state.run_mode,
    actionMode: state.action_mode,
    action,
  });
  if (!base.allowed) {
    return { proposal, allowed: false, reason: base.reason satisfies GateDenialReason };
  }

  // Layer: price-decrease cooldown applies to EDIT_PRICE only, when going down.
  if (proposal.kind === 'EDIT_PRICE' && proposal.new_price_sat < proposal.old_price_sat) {
    if (isInsidePriceDecreaseCooldown(proposal.braiins_order_id, state)) {
      return { proposal, allowed: false, reason: 'PRICE_DECREASE_COOLDOWN' };
    }
  }

  return { proposal, allowed: true };
}

function mapToGateAction(proposal: Exclude<Proposal, { kind: 'PAUSE' }>): MutationAction {
  switch (proposal.kind) {
    case 'CREATE_BID':
      return 'create';
    case 'EDIT_PRICE':
      return 'edit';
    case 'CANCEL_BID':
      return 'cancel';
  }
}

function isInsidePriceDecreaseCooldown(braiinsOrderId: string, state: State): boolean {
  const bid = state.owned_bids.find((b) => b.braiins_order_id === braiinsOrderId);
  if (!bid || bid.last_price_decrease_at === null) return false;
  const periodMs = (state.market?.settings.min_bid_price_decrease_period_s ?? 600) * 1000;
  return state.tick_at - bid.last_price_decrease_at < periodMs;
}
