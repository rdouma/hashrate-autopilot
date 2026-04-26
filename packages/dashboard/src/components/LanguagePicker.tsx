// Header dropdown that switches the UI language. Sibling to the
// "sign out" button. Distinct from the format-locale picker on the
// Config page (which only governs how numbers and dates *look*) -
// this one drives the Lingui catalog and translates labels.
//
// Persists choice to localStorage so the next page load opens in
// the same language. Default at first launch is browser language
// when supported, English otherwise (see getInitialLocale in
// lib/i18n.ts).

import { t } from '@lingui/macro';
import { useLingui } from '@lingui/react';

import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  loadAndActivate,
  setStoredLocale,
} from '../lib/i18n';

export function LanguagePicker() {
  const { i18n } = useLingui();
  const current = (
    SUPPORTED_LOCALES.includes(i18n.locale as SupportedLocale)
      ? i18n.locale
      : 'en'
  ) as SupportedLocale;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as SupportedLocale;
    setStoredLocale(next);
    void loadAndActivate(next);
  };

  return (
    <select
      value={current}
      onChange={onChange}
      aria-label={t`Language`}
      className="px-1 py-1 text-[11px] text-slate-300 bg-slate-900 border border-slate-700 rounded hover:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
    >
      {SUPPORTED_LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_LABELS[code]}
        </option>
      ))}
    </select>
  );
}
