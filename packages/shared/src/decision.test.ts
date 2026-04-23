import { describe, expect, it } from 'vitest';
import { canMutate } from './decision.js';
import type { MutationAction, RunMode } from './types.js';

const ALL_RUN_MODES: RunMode[] = ['DRY_RUN', 'LIVE', 'PAUSED'];
const ALL_ACTIONS: MutationAction[] = ['create', 'edit', 'cancel'];

describe('canMutate — run mode gates', () => {
  it.each(ALL_ACTIONS)('blocks %s in DRY_RUN', (action) => {
    expect(canMutate({ runMode: 'DRY_RUN', action })).toEqual({
      allowed: false,
      reason: 'RUN_MODE_NOT_LIVE',
    });
  });

  it.each(ALL_ACTIONS)('blocks %s in PAUSED', (action) => {
    expect(canMutate({ runMode: 'PAUSED', action })).toEqual({
      allowed: false,
      reason: 'RUN_MODE_PAUSED',
    });
  });

  it.each(ALL_ACTIONS)('allows %s in LIVE', (action) => {
    expect(canMutate({ runMode: 'LIVE', action })).toEqual({ allowed: true });
  });
});

describe('canMutate — exhaustive sanity check', () => {
  it('matches the SPEC §7.2 truth table: LIVE allows, everything else blocks', () => {
    for (const runMode of ALL_RUN_MODES) {
      for (const action of ALL_ACTIONS) {
        const result = canMutate({ runMode, action });
        const expected = runMode === 'LIVE';
        expect(result.allowed, `(${runMode}, ${action})`).toBe(expected);
      }
    }
  });
});
