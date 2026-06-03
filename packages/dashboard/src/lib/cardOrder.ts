// #244: dashboard card/block ordering.
//
// The operator can drag the top-level dashboard blocks (hero, charts,
// pipeline, bids, P&L, ...) into any order. The chosen order is
// persisted daemon-side (config.dashboard_card_order, a JSON string
// array of stable block IDs) so it follows the operator between
// devices - the whole motivation was "I open the dashboard on my
// phone and have to scroll to the bottom to see the P&L card". Browser
// localStorage is used as an instant-apply cache so the order is right
// on first paint, before the config GET resolves; the daemon copy is
// the cross-device source of truth.
//
// This module mirrors the dual-write pattern in lib/locale.ts: read
// localStorage synchronously on init, push to the daemon on mount /
// on change, and adopt the daemon's value if it differs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, UnauthorizedError } from './api';

const CARD_ORDER_KEY = 'hashrate-autopilot.cardOrder';

/**
 * Reconcile a saved order against the current set of default block IDs.
 *
 * - Saved IDs that no longer exist (a block removed in a later release)
 *   are dropped.
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
  /** Persist a new order (array of block IDs) to localStorage + daemon. */
  setOrder: (next: string[]) => void;
  /** Clear back to the built-in default order. */
  reset: () => void;
  /** True when the current order differs from the default order. */
  isCustomized: boolean;
}

/**
 * Stateful hook owning the card order. `defaultIds` is the built-in
 * order for the blocks currently present (already filtered for
 * conditionally-rendered blocks by the caller). The hook keeps the
 * persisted order reconciled against whatever `defaultIds` is today.
 */
export function useCardOrder(defaultIds: readonly string[]): CardOrderControls {
  // Snapshot the saved order once; reconcile against the live
  // defaultIds on every render so toggling a conditional block
  // (e.g. last-tick proposals appearing) re-slots correctly.
  const [savedOrder, setSavedOrder] = useState<string[]>(() => readStoredOrder());
  const order = reconcileOrder(defaultIds, savedOrder);

  // Persist the JSON string to localStorage whenever the saved order
  // changes. Empty array = "use default", stored as '[]'.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(savedOrder));
  }, [savedOrder]);

  // One-shot sync with the daemon on mount: adopt the daemon's order
  // if it has one, otherwise push a local custom order up so other
  // devices (and a fresh browser) inherit it.
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    if (typeof window === 'undefined') return;
    syncedRef.current = true;
    void (async () => {
      try {
        const res = await api.config();
        const cfg = res.config;
        const daemonOrder = parseCardOrder(cfg.dashboard_card_order);
        if (daemonOrder.length > 0) {
          // Daemon is authoritative; adopt if it differs from local.
          setSavedOrder((prev) => (sameOrder(prev, daemonOrder) ? prev : daemonOrder));
          window.localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(daemonOrder));
        } else if (savedOrder.length > 0) {
          // Daemon at default but this browser has a custom order:
          // push it up so it follows the operator to other devices.
          await api
            .updateConfig({ ...cfg, dashboard_card_order: JSON.stringify(savedOrder) })
            .catch(() => null);
        }
      } catch (e) {
        if (e instanceof UnauthorizedError) return;
        // Network / parse failure: local state stays authoritative.
      }
    })();
    // Intentionally mount-only (matches lib/locale.ts); savedOrder read
    // inside is the initial value, which is what we want to push up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((next: string[]) => {
    setSavedOrder(next);
    void (async () => {
      try {
        const res = await api.config();
        const cfg = res.config;
        const encoded = JSON.stringify(next);
        if (cfg.dashboard_card_order !== encoded) {
          await api.updateConfig({ ...cfg, dashboard_card_order: encoded });
        }
      } catch {
        // Best-effort; local state remains authoritative this session.
      }
    })();
  }, []);

  const setOrder = useCallback(
    (next: string[]) => {
      persist(reconcileOrder(defaultIds, next));
    },
    [persist, defaultIds],
  );

  const reset = useCallback(() => {
    // Store an empty array = "default order"; reconcile renders defaults.
    persist([]);
  }, [persist]);

  return {
    order,
    setOrder,
    reset,
    isCustomized: !sameOrder(order, defaultIds),
  };
}
