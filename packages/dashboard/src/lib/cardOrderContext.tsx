// #244: shared dashboard card-order + rearrange-mode state.
//
// The order itself is consumed by the Status page (to render blocks in
// the saved sequence) but the "Rearrange" toggle lives in the global
// header (Layout), so the edit-mode flag and the order controls have to
// be reachable from both. This context, mounted above both the header
// and the routed page, is that shared home.

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useCardOrder, type CardOrderControls } from './cardOrder';

// Built-in top-level dashboard block order. Each ID is a draggable
// unit; a saved order is reconciled against this list, so adding a
// block here is enough to slot it in for everyone and a saved order
// referencing a removed ID degrades cleanly. `proposals` keeps its
// position even when hidden (no last-tick data this cycle).
export const DEFAULT_BLOCK_ORDER = [
  'hero',
  'period',
  'indicators',
  'hashrate',
  'price',
  'pipeline',
  'bids',
  'finance',
  'proposals',
  'bip110',
  'solo',
] as const;

interface CardOrderContextValue extends CardOrderControls {
  /** Whether the dashboard is in drag-to-reorder mode. */
  rearranging: boolean;
  setRearranging: (v: boolean) => void;
}

const CardOrderContext = createContext<CardOrderContextValue | null>(null);

export function CardOrderProvider({ children }: { children: ReactNode }) {
  const controls = useCardOrder(DEFAULT_BLOCK_ORDER);
  const [rearranging, setRearranging] = useState(false);
  // Recomputed only when the provider re-renders (i.e. on an actual
  // order or rearranging change), so consumers don't churn per frame.
  const value: CardOrderContextValue = { ...controls, rearranging, setRearranging };
  return <CardOrderContext.Provider value={value}>{children}</CardOrderContext.Provider>;
}

export function useCardOrderContext(): CardOrderContextValue {
  const value = useContext(CardOrderContext);
  if (!value) {
    throw new Error('useCardOrderContext must be used within a CardOrderProvider');
  }
  return value;
}
