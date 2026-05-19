// Lingui v6 config (issue #1).
//
// Locales: English, Dutch, Spanish - the three languages the operator
// can verify directly. Adding a locale: add the code here, run
// `pnpm lingui:extract`, fill the new .po file, ship a fresh build.
//
// sourceLocale 'en' means source code uses English keys (via <Trans>
// and `t` from @lingui/react/macro and @lingui/core/macro). The EN
// catalog is the source of truth.

import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

export default defineConfig({
  locales: ['en', 'nl', 'es'],
  sourceLocale: 'en',
  fallbackLocales: { default: 'en' },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src'],
    },
  ],
  format: formatter({ lineNumbers: false }),
  compileNamespace: 'es',
});
