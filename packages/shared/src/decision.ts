/**
 * Pure implementation of the mutation-gate rule from SPEC §7.2.
 *
 * canMutate(action) =
 *   runMode == LIVE
 *   AND runMode != PAUSED
 *
 * All three mutation kinds (create, edit, cancel) use the same rule.
 * ActionMode was removed in v1.1 (owner-token API bypasses 2FA).
 */

import type { GateInputs, MutationAction, RunMode } from './types.js';

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GateDenialReason };

export type GateDenialReason =
  | 'RUN_MODE_NOT_LIVE'
  | 'RUN_MODE_PAUSED';

export function canMutate({ runMode }: GateInputs): GateDecision {
  if (runMode === 'PAUSED') {
    return { allowed: false, reason: 'RUN_MODE_PAUSED' };
  }
  if (runMode !== 'LIVE') {
    return { allowed: false, reason: 'RUN_MODE_NOT_LIVE' };
  }
  return { allowed: true };
}

export type { GateInputs, MutationAction, RunMode };
