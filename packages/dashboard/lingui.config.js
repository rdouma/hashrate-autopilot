// Lingui v5 config (issue #1).
//
// `locales` is the launch set: English, Dutch, Spanish - the three
// languages the operator can verify directly. Czech is appealing
// (Braiins/Trezor/Prague culture) but deferred until a CZ reviewer
// is available. Adding a locale later is a matter of adding the
// code here, running `pnpm lingui:extract`, filling the new .po
// file, and shipping a fresh build.
//
// `sourceLocale: 'en'` means messages in the source code use English
// keys (via the <Trans> macro and the `t` template tag from
// @lingui/macro). The English catalog is therefore "the source of
// truth" - copy edits land in the EN catalog (or directly in code,
// then re-extracted) and translators see the new strings on the
// next pull.
//
// Format: PO. Standard for translators; Crowdin/Weblate friendly;
// preserves source-comment context that translators rely on.

export default {
  locales: ['en', 'nl', 'es'],
  sourceLocale: 'en',
  fallbackLocales: { default: 'en' },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src'],
    },
  ],
  format: 'po',
  formatOptions: {
    lineNumbers: false,
  },
  compileNamespace: 'es',
};
