/**
 * Pure implementation of the mutation-gate rule from SPEC §7.3.
 *
 * canMutate(action) =
 *   runMode == LIVE
 *   AND NOT (action in {create, edit} AND actionMode == QUIET_HOURS)
 *   AND NOT (action in {create, edit} AND actionMode == PENDING_CONFIRMATION)
 *   AND NOT (action in {create, edit} AND actionMode == CONFIRMATION_TIMEOUT)
 *   AND NOT (runMode == PAUSED)
 *
 * Cancels are never blocked by action mode — only by run mode.
 */

import type { ActionMode, GateInputs, MutationAction, RunMode } from './types.js';

const CREATE_OR_EDIT: ReadonlySet<MutationAction> = new Set<MutationAction>(['create', 'edit']);

const ACTION_MODE_BLOCKS_CREATE_OR_EDIT: ReadonlySet<ActionMode> = new Set<ActionMode>([
  'QUIET_HOURS',
  'PENDING_CONFIRMATION',
  'CONFIRMATION_TIMEOUT',
]);

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GateDenialReason };

export type GateDenialReason =
  | 'RUN_MODE_NOT_LIVE'
  | 'RUN_MODE_PAUSED'
  | 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT';

export function canMutate({ runMode, actionMode, action }: GateInputs): GateDecision {
  if (runMode === 'PAUSED') {
    return { allowed: false, reason: 'RUN_MODE_PAUSED' };
  }
  if (runMode !== 'LIVE') {
    return { allowed: false, reason: 'RUN_MODE_NOT_LIVE' };
  }
  if (CREATE_OR_EDIT.has(action) && ACTION_MODE_BLOCKS_CREATE_OR_EDIT.has(actionMode)) {
    return { allowed: false, reason: 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT' };
  }
  return { allowed: true };
}

// Re-export for convenience at the package level.
export type { ActionMode, GateInputs, MutationAction, RunMode };
