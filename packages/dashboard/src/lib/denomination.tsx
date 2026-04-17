/**
 * Denomination context — lets the operator toggle between sats and USD
 * across the entire dashboard. Polls /api/btc-price every 5 minutes.
 * Mode persisted to localStorage ('braiins.denomination').
 *
 * When the price source is 'none' or the API is unreachable, btcPrice
 * is null and the toggle should be hidden (mode is forced to 'sats').
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type BtcPriceResponse } from './api';

const STORAGE_KEY = 'braiins.denomination';
const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

export type DenominationMode = 'sats' | 'usd';

export interface DenominationContextValue {
  /** Current display denomination. */
  mode: DenominationMode;
  /** Toggle between sats and usd. */
  toggle: () => void;
  /** Current BTC/USD price, or null if unavailable. */
  btcPrice: number | null;
  /**
   * Format a raw sat amount in the current denomination.
   * Returns "12,345 sat" in sats mode, "$1.28" in usd mode.
   * Returns "--" for null.
   */
  formatSat: (sat: number | null, locale?: string) => string;
  /**
   * Format a sat/PH/day rate in the current denomination.
   * Returns "45,662 sat/PH/day" in sats mode, "$4.75/PH/day" in usd mode.
   * Returns "--" for null.
   */
  formatSatPerPhDay: (sat: number | null, locale?: string) => string;
}

function getStoredMode(): DenominationMode {
  if (typeof window === 'undefined') return 'sats';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'usd' ? 'usd' : 'sats';
}

function setStoredMode(mode: DenominationMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode);
}

function satToUsd(sat: number, usdPerBtc: number): number {
  return (sat / 100_000_000) * usdPerBtc;
}

function formatUsd(usd: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
}

function formatSatNumber(sat: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(sat);
}

const defaultContext: DenominationContextValue = {
  mode: 'sats',
  toggle: () => undefined,
  btcPrice: null,
  formatSat: () => '\u2014',
  formatSatPerPhDay: () => '\u2014',
};

export const DenominationContext = createContext<DenominationContextValue>(defaultContext);

export function useDenomination(): DenominationContextValue {
  return useContext(DenominationContext);
}

export function DenominationProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DenominationMode>(() => getStoredMode());

  useEffect(() => {
    setStoredMode(mode);
  }, [mode]);

  const toggle = useCallback(() => {
    setModeState((prev) => (prev === 'sats' ? 'usd' : 'sats'));
  }, []);

  const priceQuery = useQuery<BtcPriceResponse>({
    queryKey: ['btc-price'],
    queryFn: api.btcPrice,
    refetchInterval: POLL_INTERVAL_MS,
    // Don't refetch on window focus — 5 min interval is enough.
    refetchOnWindowFocus: false,
  });

  const btcPrice = priceQuery.data?.usd_per_btc ?? null;

  const value = useMemo<DenominationContextValue>(() => {
    const effectiveMode = btcPrice !== null ? mode : 'sats';

    const formatSat = (sat: number | null, locale?: string): string => {
      if (sat === null) return '\u2014';
      if (effectiveMode === 'usd' && btcPrice !== null) {
        return formatUsd(satToUsd(sat, btcPrice), locale);
      }
      return `${formatSatNumber(sat, locale)} sat`;
    };

    const formatSatPerPhDay = (sat: number | null, locale?: string): string => {
      if (sat === null) return '\u2014';
      if (effectiveMode === 'usd' && btcPrice !== null) {
        return `${formatUsd(satToUsd(sat, btcPrice), locale)}/PH/day`;
      }
      return `${formatSatNumber(sat, locale)} sat/PH/day`;
    };

    return {
      mode: effectiveMode,
      toggle,
      btcPrice,
      formatSat,
      formatSatPerPhDay,
    };
  }, [mode, btcPrice, toggle]);

  return (
    <DenominationContext.Provider value={value}>
      {children}
    </DenominationContext.Provider>
  );
}
