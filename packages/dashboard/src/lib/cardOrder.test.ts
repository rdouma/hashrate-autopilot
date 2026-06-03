import { describe, expect, it } from 'vitest';
import { parseCardOrder, reconcileOrder } from './cardOrder';

const DEFAULTS = ['hero', 'charts', 'pipeline', 'bids', 'finance', 'proposals', 'bip110', 'solo'];

describe('reconcileOrder', () => {
  it('returns the default order when nothing is saved', () => {
    expect(reconcileOrder(DEFAULTS, [])).toEqual(DEFAULTS);
  });

  it('honours a fully-specified saved order', () => {
    const saved = ['finance', 'hero', 'charts', 'pipeline', 'bids', 'proposals', 'bip110', 'solo'];
    expect(reconcileOrder(DEFAULTS, saved)).toEqual(saved);
  });

  it('drops saved IDs that no longer exist', () => {
    const saved = ['finance', 'ghost', 'hero'];
    const out = reconcileOrder(DEFAULTS, saved);
    expect(out).not.toContain('ghost');
    // every current default still appears exactly once
    expect([...out].sort()).toEqual([...DEFAULTS].sort());
  });

  it('collapses duplicate saved IDs to first occurrence', () => {
    const out = reconcileOrder(DEFAULTS, ['finance', 'finance', 'hero']);
    expect(out.filter((id) => id === 'finance')).toHaveLength(1);
    expect(out[0]).toBe('finance');
  });

  it('inserts a newly-added default next to its neighbour, not at the end', () => {
    // Operator saved an order from before `solo` existed; it should
    // slot in right after its default predecessor `bip110`, not get
    // dumped after everything.
    const legacyDefaults = DEFAULTS.filter((id) => id !== 'solo');
    const saved = ['finance', ...legacyDefaults.filter((id) => id !== 'finance')];
    const out = reconcileOrder(DEFAULTS, saved);
    expect(out.indexOf('solo')).toBe(out.indexOf('bip110') + 1);
    expect([...out].sort()).toEqual([...DEFAULTS].sort());
  });

  it('always returns a permutation of the current defaults', () => {
    const out = reconcileOrder(DEFAULTS, ['solo', 'ghost', 'bids', 'bids']);
    expect([...out].sort()).toEqual([...DEFAULTS].sort());
  });
});

describe('parseCardOrder', () => {
  it('parses a valid JSON string array', () => {
    expect(parseCardOrder('["hero","finance"]')).toEqual(['hero', 'finance']);
  });

  it('returns [] for null/empty/malformed input', () => {
    expect(parseCardOrder(null)).toEqual([]);
    expect(parseCardOrder('')).toEqual([]);
    expect(parseCardOrder('not json')).toEqual([]);
    expect(parseCardOrder('{}')).toEqual([]);
    expect(parseCardOrder('42')).toEqual([]);
  });

  it('drops non-string elements', () => {
    expect(parseCardOrder('["hero",3,null,"finance"]')).toEqual(['hero', 'finance']);
  });
});
