/**
 * Display-units context: currency (sats/BTC/USD) + hashrate unit
 * (TH/PH/EH) for every value rendered on the dashboard. Internal
 * storage is always sats for currency and PH/s for hashrate (canonical
 * API shapes); these toggles only change presentation.
 *
 * Polls /api/btc-price every 5 minutes for sat<->USD conversion.
 * Mode persisted to localStorage:
 *   - 'braiins.denomination'   = 'sats' | 'btc' | 'usd'
 *   - 'braiins.hashrateUnit'   = 'TH'   | 'PH'  | 'EH'
 *
 * When the price source is 'none' or the API is unreachable, btcPrice
 * is null; USD is hidden in the toggle UI and forced back to sats here
 * (BTC mode still works, since BTC <-> sat conversion is a static
 * 100,000,000 multiplier independent of the oracle).
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
import { useLocale } from './locale';

const DENOMINATION_STORAGE_KEY = 'braiins.denomination';
const HASHRATE_UNIT_STORAGE_KEY = 'braiins.hashrateUnit';
const POLL_INTERVAL_MS = 5 * 60_000;

const SAT_PER_BTC = 100_000_000;
const PH_PER_TH = 0.001;
const PH_PER_EH = 1000;

export type DenominationMode = 'sats' | 'btc' | 'usd';
export type HashrateUnit = 'TH' | 'PH' | 'EH';

export interface DenominationContextValue {
  /** Current currency denomination. */
  mode: DenominationMode;
  /** Set the currency denomination. */
  setMode: (m: DenominationMode) => void;
  /** Cycle currency: sats -> btc -> usd -> sats. Hidden values skipped. */
  toggle: () => void;
  /** Current BTC/USD price, or null if unavailable. */
  btcPrice: number | null;
  /** Current hashrate unit (TH/PH/EH). */
  hashrateUnit: HashrateUnit;
  /** Set the hashrate unit. */
  setHashrateUnit: (u: HashrateUnit) => void;
  /**
   * Format a raw sat amount in the current currency.
   * Returns "12,345 sat" / "0.00012345 BTC" / "$1.28".
   * Returns "--" for null.
   */
  formatSat: (sat: number | null, locale?: string) => string;
  /**
   * Format a sat-per-PH-per-day rate in the current currency AND
   * hashrate unit. Examples (input = 47,928 sat/PH/day):
   *   sats + PH:  "47,928 sat/PH/day"
   *   sats + EH:  "47,928,000 sat/EH/day"
   *   sats + TH:  "47.93 sat/TH/day"
   *   BTC  + PH:  "0.00047928 BTC/PH/day"
   *   USD  + EH:  "$47.93/EH/day"
   * Returns "--" for null.
   */
  formatSatPerPhDay: (satPerPhDay: number | null, locale?: string) => string;
  /**
   * Format a hashrate (input PH/s) in the current hashrate unit.
   * Examples (input = 3.14):
   *   TH: "3,140 TH/s"
   *   PH: "3.14 PH/s"
   *   EH: "0.00314 EH/s"
   * Returns "--" for null.
   */
  formatHashrate: (ph: number | null, locale?: string) => string;
  /** Just the unit suffix without a value, e.g. "PH/s" or "EH/s". */
  hashrateSuffix: string;
  /** Just the rate-suffix without a value, e.g. "sat/PH/day" or "$/EH/day". */
  rateSuffix: string;
}

function getStoredDenomination(): DenominationMode {
  if (typeof window === 'undefined') return 'sats';
  const stored = window.localStorage.getItem(DENOMINATION_STORAGE_KEY);
  if (stored === 'usd' || stored === 'btc' || stored === 'sats') return stored;
  return 'sats';
}

function getStoredHashrateUnit(): HashrateUnit {
  if (typeof window === 'undefined') return 'PH';
  const stored = window.localStorage.getItem(HASHRATE_UNIT_STORAGE_KEY);
  if (stored === 'TH' || stored === 'PH' || stored === 'EH') return stored;
  return 'PH';
}

function setStoredDenomination(mode: DenominationMode): void {
  window.localStorage.setItem(DENOMINATION_STORAGE_KEY, mode);
}

function setStoredHashrateUnit(unit: HashrateUnit): void {
  window.localStorage.setItem(HASHRATE_UNIT_STORAGE_KEY, unit);
}

function satToUsd(sat: number, usdPerBtc: number): number {
  return (sat / SAT_PER_BTC) * usdPerBtc;
}

function formatUsd(usd: number, locale?: string): string {
  // Plain "$" prefix instead of Intl currency formatting - in
  // non-en-US locales (e.g. nl-NL) the `style: 'currency'` path
  // disambiguates to "US$36.48", which eats horizontal space on
  // a panel and reads wrong when the whole app already makes
  // the denomination clear from context. Keep locale-aware
  // number grouping and decimal separator, just drop the symbol.
  const n = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
  return `$${n}`;
}

function formatBtc(sat: number, locale?: string): string {
  const btc = sat / SAT_PER_BTC;
  // Adaptive precision: sub-1 BTC needs all 8 decimals to be
  // legible (a sat is 1e-8 BTC); >=1 BTC reads better with 4.
  // The autopilot's typical bid budgets sit well under 1 BTC, so
  // the 8-decimal branch is the common case.
  const fractionDigits = Math.abs(btc) < 1 ? 8 : 4;
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(btc)} ₿`;
}

function formatSatNumber(sat: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(sat);
}

const defaultContext: DenominationContextValue = {
  mode: 'sats',
  setMode: () => undefined,
  toggle: () => undefined,
  btcPrice: null,
  hashrateUnit: 'PH',
  setHashrateUnit: () => undefined,
  formatSat: () => '-',
  formatSatPerPhDay: () => '-',
  formatHashrate: () => '-',
  hashrateSuffix: 'PH/s',
  rateSuffix: 'sat/PH/day',
};

export const DenominationContext = createContext<DenominationContextValue>(defaultContext);

export function useDenomination(): DenominationContextValue {
  return useContext(DenominationContext);
}

export function DenominationProvider({ children }: { children: ReactNode }) {
  // Reads the operator's display-locale preference from the
  // LocaleProvider so every formatter inside this context defaults
  // to the right number-formatting locale (commas vs periods,
  // grouping, etc) without callers having to thread `intlLocale`
  // explicitly. An undefined intlLocale means "browser default" -
  // identical fallback behaviour to before this hookup.
  const { intlLocale: defaultLocale } = useLocale();
  const [mode, setModeState] = useState<DenominationMode>(() => getStoredDenomination());
  const [hashrateUnit, setHashrateUnitState] = useState<HashrateUnit>(
    () => getStoredHashrateUnit(),
  );

  useEffect(() => {
    setStoredDenomination(mode);
  }, [mode]);

  useEffect(() => {
    setStoredHashrateUnit(hashrateUnit);
  }, [hashrateUnit]);

  const setMode = useCallback((m: DenominationMode) => setModeState(m), []);
  const setHashrateUnit = useCallback((u: HashrateUnit) => setHashrateUnitState(u), []);

  const priceQuery = useQuery<BtcPriceResponse>({
    queryKey: ['btc-price'],
    queryFn: api.btcPrice,
    refetchInterval: POLL_INTERVAL_MS,
    // Keep retrying even after errors - the first request fires before
    // login (401) and React Query would otherwise give up and not retry
    // until the user manually triggers a refetch. With retryDelay at 30s
    // the price loads within half a minute of logging in.
    retry: true,
    retryDelay: 30_000,
    refetchOnWindowFocus: false,
  });

  const btcPrice = priceQuery.data?.usd_per_btc ?? null;

  const toggle = useCallback(() => {
    setModeState((prev) => {
      // Cycle sats -> btc -> usd -> sats; skip USD when no oracle.
      const next = prev === 'sats' ? 'btc' : prev === 'btc' ? 'usd' : 'sats';
      if (next === 'usd' && btcPrice === null) return 'sats';
      return next;
    });
  }, [btcPrice]);

  const value = useMemo<DenominationContextValue>(() => {
    // USD is unreachable when the oracle is off; force back to sats.
    // BTC is always reachable (static conversion).
    const effectiveMode: DenominationMode =
      mode === 'usd' && btcPrice === null ? 'sats' : mode;

    const hashrateMultiplier =
      hashrateUnit === 'TH' ? 1 / PH_PER_TH : hashrateUnit === 'EH' ? 1 / PH_PER_EH : 1;
    const rateMultiplier =
      hashrateUnit === 'TH' ? PH_PER_TH : hashrateUnit === 'EH' ? PH_PER_EH : 1;
    const hashrateSuffix = `${hashrateUnit}/s`;

    // Each formatter's `locale` parameter overrides the contextual
    // default; pass it when you specifically want a different locale
    // (e.g. forcing en-US in a copy-to-clipboard JSON payload).
    // Otherwise the operator's chosen display locale wins via
    // `defaultLocale`.
    const formatSat = (sat: number | null, locale: string | undefined = defaultLocale): string => {
      if (sat === null) return '-';
      if (effectiveMode === 'usd' && btcPrice !== null) {
        return formatUsd(satToUsd(sat, btcPrice), locale);
      }
      if (effectiveMode === 'btc') return formatBtc(sat, locale);
      return `${formatSatNumber(sat, locale)} sat`;
    };

    const formatSatPerPhDay = (
      satPerPhDay: number | null,
      locale: string | undefined = defaultLocale,
    ): string => {
      if (satPerPhDay === null) return '-';
      const scaled = satPerPhDay * rateMultiplier;
      if (effectiveMode === 'usd' && btcPrice !== null) {
        return `${formatUsd(satToUsd(scaled, btcPrice), locale)}/${hashrateUnit}/day`;
      }
      if (effectiveMode === 'btc') {
        const btcRate = scaled / SAT_PER_BTC;
        // Rates per TH/PH are tiny in BTC; per EH closer to a
        // legible decimal. Use 8 decimals across the board for
        // consistency between modes (the operator's eye snaps to
        // the digit position rather than the magnitude).
        return `${new Intl.NumberFormat(locale, {
          minimumFractionDigits: 8,
          maximumFractionDigits: 8,
        }).format(btcRate)} ₿/${hashrateUnit}/day`;
      }
      // sats: integer for PH/EH (whole-sat precision); for TH (1/1000
      // of PH) three decimals keep adjacent ticks distinguishable on
      // the price chart (a single sat/PH/day tick of spread maps to a
      // 0.001 sat/TH/day step).
      const fractionDigits = hashrateUnit === 'TH' ? 3 : 0;
      return `${new Intl.NumberFormat(locale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(scaled)} sat/${hashrateUnit}/day`;
    };

    const formatHashrate = (
      ph: number | null,
      locale: string | undefined = defaultLocale,
    ): string => {
      if (ph === null) return '-';
      const scaled = ph * hashrateMultiplier;
      // TH wants integer-or-1-decimal (~1000x bigger than PH);
      // PH wants 2 decimals (operator-native granularity);
      // EH wants 4-5 decimals to keep small bids visible (1 PH = 0.001 EH).
      const fractionDigits = hashrateUnit === 'TH' ? 1 : hashrateUnit === 'EH' ? 5 : 2;
      return `${new Intl.NumberFormat(locale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(scaled)} ${hashrateSuffix}`;
    };

    const rateSuffix =
      effectiveMode === 'usd' && btcPrice !== null
        ? `$/${hashrateUnit}/day`
        : effectiveMode === 'btc'
          ? `₿/${hashrateUnit}/day`
          : `sat/${hashrateUnit}/day`;

    return {
      mode: effectiveMode,
      setMode,
      toggle,
      btcPrice,
      hashrateUnit,
      setHashrateUnit,
      formatSat,
      formatSatPerPhDay,
      formatHashrate,
      hashrateSuffix,
      rateSuffix,
    };
  }, [mode, btcPrice, toggle, setMode, hashrateUnit, setHashrateUnit, defaultLocale]);

  return (
    <DenominationContext.Provider value={value}>
      {children}
    </DenominationContext.Provider>
  );
}
