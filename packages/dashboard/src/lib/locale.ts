/**
 * Locale override — lets the operator pick a date/number format that's
 * independent of their browser's language. Persists to localStorage.
 *
 * The `auto` value means "use whatever the browser reports"
 * (`navigator.language`). Any other value is passed directly to Intl APIs.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  formatAge as formatAgeRaw,
  formatHashratePH as formatHashratePHRaw,
  formatNumber as formatNumberRaw,
  formatSatPerPH as formatSatPerPHRaw,
  formatSats as formatSatsRaw,
  formatTimestamp as formatTimestampRaw,
} from './format';

const STORAGE_KEY = 'braiins.displayLocale';

/** Locales we ship as quick presets. Anything is accepted via "Other". */
export const LOCALE_PRESETS: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'system default' },
  { code: 'en-GB', label: 'English (UK, DD/MM/YYYY)' },
  { code: 'en-US', label: 'English (US, MM/DD/YYYY)' },
  { code: 'es-UY', label: 'Español (Uruguay)' },
  { code: 'es-ES', label: 'Español (España)' },
  { code: 'nl-NL', label: 'Nederlands' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
];

export function getStoredLocale(): string {
  return window.localStorage.getItem(STORAGE_KEY) ?? 'auto';
}

export function setStoredLocale(code: string): void {
  window.localStorage.setItem(STORAGE_KEY, code);
}

/**
 * Resolves the display locale to pass into Intl constructors. `auto`
 * becomes `undefined` (Intl default = browser locale).
 */
export function resolveLocale(selected: string): string | undefined {
  return selected === 'auto' ? undefined : selected;
}

export interface LocaleContextValue {
  selected: string;
  intlLocale: string | undefined;
  setSelected: (code: string) => void;
}

export const LocaleContext = createContext<LocaleContextValue>({
  selected: 'auto',
  intlLocale: undefined,
  setSelected: () => undefined,
});

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useLocaleState(): LocaleContextValue {
  const [selected, setSelectedState] = useState(() => getStoredLocale());

  useEffect(() => {
    setStoredLocale(selected);
  }, [selected]);

  return {
    selected,
    intlLocale: resolveLocale(selected),
    setSelected: setSelectedState,
  };
}

/**
 * Pre-bound formatters that use the current display locale. Components
 * call these like `fmt.satPerPH(n)` instead of `formatSatPerPH(n, locale)`.
 */
export function useFormatters() {
  const { intlLocale } = useLocale();
  return useMemo(
    () => ({
      number: (n: number, opts?: Intl.NumberFormatOptions) =>
        formatNumberRaw(n, opts, intlLocale),
      satPerPH: (n: number | null | undefined) => formatSatPerPHRaw(n, intlLocale),
      sats: (n: number | null | undefined) => formatSatsRaw(n, intlLocale),
      hashratePH: (n: number | null | undefined) => formatHashratePHRaw(n, intlLocale),
      timestamp: (ms: number | null | undefined) => formatTimestampRaw(ms, intlLocale),
      age: formatAgeRaw,
    }),
    [intlLocale],
  );
}
