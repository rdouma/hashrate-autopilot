// Verifies the Lingui catalog loop end-to-end without needing a DOM:
// the compiled NL/ES catalogs activate cleanly, and translated strings
// come back when looked up via the singleton i18n. A full
// react-testing-library render test would also exercise <Trans /> in a
// component, but it would require jsdom + @testing-library/react in
// the workspace. The catalog-level test here covers the same failure
// modes (broken extract/compile, wrong locale code, missing message)
// for materially less ceremony.

import { i18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { messages as enMessages } from '../locales/en/messages';
import { messages as esMessages } from '../locales/es/messages';
import { messages as nlMessages } from '../locales/nl/messages';

// Lingui v5 hashes message IDs at compile time (the macro runs through
// babel-plugin-macros and rewrites `t\`sign out\`` → `i18n._('ydgdD7')`).
// In a plain .ts test file the macro never runs, so we look up the
// known compile-time hash directly. The hash for "sign out" is stable
// across builds; if you ever change the source string, the hash
// changes too and this test will tell you.
const SIGN_OUT_ID = 'ydgdD7';

describe('i18n catalog loading', () => {
  it('returns the Dutch translation for a known message after activating nl', () => {
    i18n.load('nl', nlMessages);
    i18n.activate('nl');
    expect(i18n._(SIGN_OUT_ID)).toBe('afmelden');
  });

  it('returns the Spanish translation for a known message after activating es', () => {
    i18n.load('es', esMessages);
    i18n.activate('es');
    expect(i18n._(SIGN_OUT_ID)).toBe('cerrar sesión');
  });

  it('falls back to the source string when an unknown message is looked up', () => {
    i18n.load('en', enMessages);
    i18n.activate('en');
    expect(i18n._('this-is-not-a-real-id-9876')).toBe('this-is-not-a-real-id-9876');
  });
});
