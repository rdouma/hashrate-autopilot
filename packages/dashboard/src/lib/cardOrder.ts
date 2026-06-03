// #244: dashboard card/block ordering.
//
// The operator can drag the top-level dashboard blocks (hero, period
// selector, indicators, hashrate chart, price chart, pipeline, bids,
// P&L, ...) into any order. The chosen order is stored PER-DEVICE in
// browser localStorage, deliberately not synced to the daemon: a phone
// and a desktop want genuinely different layouts (the operator's own
// call after living with it), so each device keeps its own order.
//
// There is a dormant `config.dashboard_card_order` column daemon-side
// (migration 0108) left in place but unused; it is not deleted because
// the migration may already have run on a deployed instance, and a
// harmless unused column is safer than diverging the schema. If
// cross-device sync is ever wanted, the daemon plumbing is ready.

import { useCallback, useEffect, useState } from 'react';

const CARD_ORDER_KEY = 'hashrate-autopilot.cardOrder';

/**
 * Reconcile a saved order against the current set of default block IDs.
 *
 * - Saved IDs that no longer exist (a block removed/renamed in a later
 *   release) are dropped.
 * - Duplicate saved IDs collapse to their first occurrence.
 * - Default blocks missing from the saved order (a block ADDED in a
 *   later release, or a fresh install with an empty saved order) are
 *   spliced in next to their default neighbour rather than dumped at
 *   the end, so a brand-new card lands roughly where it was designed
 *   to sit instead of silently at the very bottom.
 *
 * Guarantees the result is a permutation of `defaultIds` (every
 * current block appears exactly once), so the render is never missing
 * or duplicating a block regardless of what was stored.
 */
export function reconcileOrder(
  defaultIds: readonly string[],
  savedIds: readonly string[],
): string[] {
  const known = new Set(defaultIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of savedIds) {
    if (known.has(id) && !seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  // Insert any default IDs missing from the saved order immediately
  // after their nearest preceding default that survived, so new blocks
  // appear next to their intended neighbour.
  for (let i = 0; i < defaultIds.length; i++) {
    const id = defaultIds[i]!;
    if (seen.has(id)) continue;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const pos = result.indexOf(defaultIds[j]!);
      if (pos !== -1) {
        insertAt = pos + 1;
        break;
      }
    }
    result.splice(insertAt, 0, id);
    seen.add(id);
  }
  return result;
}

/** Parse a stored JSON string into a string[] defensively. Any
 *  malformed value (non-array, non-string elements, bad JSON) yields
 *  an empty list, which reconciles to the default order. */
export function parseCardOrder(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function readStoredOrder(): string[] {
  if (typeof window === 'undefined') return [];
  return parseCardOrder(window.localStorage.getItem(CARD_ORDER_KEY));
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface CardOrderControls {
  /** The reconciled order to render, always a permutation of defaultIds. */
  order: string[];
  /** Persist a new order (array of block IDs) to localStorage. */
  setOrder: (next: string[]) => void;
  /** Clear back to the built-in default order. */
  reset: () => void;
  /** True when the current order differs from the default order. */
  isCustomized: boolean;
}

/**
 * Stateful hook owning the per-device card order. `defaultIds` is the
 * built-in order for all blocks; the hook keeps the persisted order
 * reconciled against it on every render, so adding/removing a block in
 * a later release re-slots a stored order cleanly.
 */
export function useCardOrder(defaultIds: readonly string[]): CardOrderControls {
  const [savedOrder, setSavedOrder] = useState<string[]>(() => readStoredOrder());
  const order = reconcileOrder(defaultIds, savedOrder);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Empty array = "use default", stored as '[]'.
    window.localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(savedOrder));
  }, [savedOrder]);

  const setOrder = useCallback(
    (next: string[]) => {
      setSavedOrder(reconcileOrder(defaultIds, next));
    },
    [defaultIds],
  );

  const reset = useCallback(() => {
    setSavedOrder([]);
  }, []);

  return {
    order,
    setOrder,
    reset,
    isCustomized: !sameOrder(order, defaultIds),
  };
}
