// Lingui i18n bootstrap (issue #1).
//
// Three-piece job:
//
// 1. Singleton `i18n` instance from @lingui/core - holds the active
//    locale and the loaded catalog. The same instance is consumed
//    by every <Trans> macro and every `t` template tag in the app.
//
// 2. `loadAndActivate(locale)` dynamically imports the compiled
//    catalog for the requested locale and switches the active one.
//    Code-split: each locale lives in its own chunk, so a NL user
//    never downloads the ES catalog. Catalogs are produced by
//    `pnpm lingui:compile` from the `.po` files committed in
//    `src/locales/<locale>/messages.po`.
//
// 3. `getInitialLocale()` resolves the launch locale: first the
//    operator's stored preference (localStorage), then the closest
//    match for `navigator.language`, then English as fallback.
//
// Note: this is the *language* picker (translates the UI). It is
// independent of the existing `lib/locale.ts`, which only governs
// number/date formatting display via Intl.

import { i18n } from '@lingui/core';

// Locales declared in `lingui.config.js`. Adding a new language: add
// the code here AND in `lingui.config.js`, run `pnpm lingui:extract`,
// fill the new `.po` file. Order is display order in the picker.
export const SUPPORTED_LOCALES = ['en', 'nl', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  nl: 'Nederlands',
  es: 'Español',
};

const STORAGE_KEY = 'braiins.uiLanguage';

function isSupported(code: string): code is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(code);
}

export function getInitialLocale(): SupportedLocale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    /* SSR / disabled storage - fall through */
  }
  // navigator.language can be 'nl-NL', 'es-419' etc. Match by primary
  // subtag only - we don't ship region-specific catalogs.
  const browserRaw = typeof navigator !== 'undefined' ? navigator.language : '';
  const browser = (browserRaw.split('-')[0] ?? '').toLowerCase();
  if (isSupported(browser)) return browser;
  return 'en';
}

export function setStoredLocale(locale: SupportedLocale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

// Compiled catalogs live at `src/locales/<locale>/messages.ts` (with
// --typescript on the compile step). Vite resolves the dynamic import
// at build time and emits one chunk per locale.
export async function loadAndActivate(locale: SupportedLocale) {
  const { messages } = await import(`../locales/${locale}/messages.ts`);
  i18n.load(locale, messages);
  i18n.activate(locale);
}

export { i18n };
