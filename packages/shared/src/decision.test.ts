import { describe, expect, it } from 'vitest';
import { canMutate } from './decision.js';
import type { ActionMode, MutationAction, RunMode } from './types.js';

const ALL_RUN_MODES: RunMode[] = ['DRY_RUN', 'LIVE', 'PAUSED'];
const ALL_ACTION_MODES: ActionMode[] = [
  'NORMAL',
  'QUIET_HOURS',
  'PENDING_CONFIRMATION',
  'CONFIRMATION_TIMEOUT',
];
const ALL_ACTIONS: MutationAction[] = ['create', 'edit', 'cancel'];

describe('canMutate — run mode gates', () => {
  it.each(ALL_ACTIONS)('blocks %s in DRY_RUN for every action mode', (action) => {
    for (const actionMode of ALL_ACTION_MODES) {
      expect(canMutate({ runMode: 'DRY_RUN', actionMode, action })).toEqual({
        allowed: false,
        reason: 'RUN_MODE_NOT_LIVE',
      });
    }
  });

  it.each(ALL_ACTIONS)('blocks %s in PAUSED for every action mode', (action) => {
    for (const actionMode of ALL_ACTION_MODES) {
      expect(canMutate({ runMode: 'PAUSED', actionMode, action })).toEqual({
        allowed: false,
        reason: 'RUN_MODE_PAUSED',
      });
    }
  });
});

describe('canMutate — action mode gates (only in LIVE)', () => {
  it('allows all actions in LIVE+NORMAL', () => {
    for (const action of ALL_ACTIONS) {
      expect(canMutate({ runMode: 'LIVE', actionMode: 'NORMAL', action })).toEqual({
        allowed: true,
      });
    }
  });

  it.each(['QUIET_HOURS', 'PENDING_CONFIRMATION', 'CONFIRMATION_TIMEOUT'] as const)(
    'blocks create/edit but allows cancel in LIVE+%s',
    (actionMode) => {
      expect(canMutate({ runMode: 'LIVE', actionMode, action: 'create' })).toEqual({
        allowed: false,
        reason: 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT',
      });
      expect(canMutate({ runMode: 'LIVE', actionMode, action: 'edit' })).toEqual({
        allowed: false,
        reason: 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT',
      });
      expect(canMutate({ runMode: 'LIVE', actionMode, action: 'cancel' })).toEqual({
        allowed: true,
      });
    },
  );
});

describe('canMutate — exhaustive sanity check', () => {
  it('matches the SPEC §7.3 truth table for every combination', () => {
    for (const runMode of ALL_RUN_MODES) {
      for (const actionMode of ALL_ACTION_MODES) {
        for (const action of ALL_ACTIONS) {
          const result = canMutate({ runMode, actionMode, action });
          const expected = specTruthTable(runMode, actionMode, action);
          expect(result.allowed, `(${runMode}, ${actionMode}, ${action})`).toBe(expected);
        }
      }
    }
  });
});

// Reference implementation copied verbatim from the SPEC §7.3 pseudocode.
function specTruthTable(runMode: RunMode, actionMode: ActionMode, action: MutationAction): boolean {
  const isCreateOrEdit = action === 'create' || action === 'edit';
  return (
    runMode === 'LIVE' &&
    !(isCreateOrEdit && actionMode === 'QUIET_HOURS') &&
    !(isCreateOrEdit && actionMode === 'PENDING_CONFIRMATION') &&
    !(isCreateOrEdit && actionMode === 'CONFIRMATION_TIMEOUT') &&
    (runMode as RunMode) !== 'PAUSED'
  );
}
