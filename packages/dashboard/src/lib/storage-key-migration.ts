/**
 * #228: one-shot localStorage rename from the legacy `braiins.*`
 * prefix to `hashrate-autopilot.*`.
 *
 * The project was originally Braiins-only and the dashboard's
 * browser-persistence keys inherited the brand prefix. After the
 * project's market-agnostic repositioning (Braiins is one integrated
 * marketplace, not the project itself), the prefix became misleading
 * - DevTools, exported settings, and any browser-side tooling all
 * surface it. The actual daemon-side config field names (e.g.
 * `display_number_locale`, `notify_on_*`) are already correctly
 * marketplace-agnostic; only the dashboard's browser cache carried
 * the leak.
 *
 * Runs once at app bootstrap (called from `main.tsx` before
 * `createRoot().render`) so the first paint already sees the new
 * keys. Idempotent: re-runs are no-ops because the destination keys
 * already exist after the first migration.
 *
 * The function intentionally does NOT special-case any single key.
 * If a future hashrate-autopilot.* key gets added and we never need
 * to migrate it, the migration loop just skips it (no legacy braiins
 * partner means no copy happens). If a future braiins.* key gets
 * added on the legitimate Braiins-marketplace side, it won't match
 * the rename map and stays untouched.
 */

const RENAMES: Readonly<Record<string, string>> = {
  // Dashboard credentials
  'braiins.dashboardPassword': 'hashrate-autopilot.dashboardPassword',
  // UI language / locale / format / temperature
  'braiins.uiLanguage': 'hashrate-autopilot.uiLanguage',
  'braiins.numberLocale': 'hashrate-autopilot.numberLocale',
  'braiins.dateLayout': 'hashrate-autopilot.dateLayout',
  'braiins.temperatureUnit': 'hashrate-autopilot.temperatureUnit',
  // Legacy localStorage display-locale, kept in the map so an
  // operator still on a pre-#147 install upgrades cleanly through
  // *this* migration first; the existing migrateLegacyDisplayLocale
  // in locale.ts then handles the value translation under the new
  // prefix.
  'braiins.displayLocale': 'hashrate-autopilot.displayLocale',
  // Denomination + hashrate unit toggle (Status page header)
  'braiins.denomination': 'hashrate-autopilot.denomination',
  'braiins.hashrateUnit': 'hashrate-autopilot.hashrateUnit',
  // Block-found sound de-dup
  'braiins.lastSeenOceanBlockHeight': 'hashrate-autopilot.lastSeenOceanBlockHeight',
  // Chart UI state
  'braiins.hashrateRightAxis': 'hashrate-autopilot.hashrateRightAxis',
  'braiins.priceRightAxis': 'hashrate-autopilot.priceRightAxis',
  // Config / Alerts / Layout UI state
  'braiins.configAutoSave': 'hashrate-autopilot.configAutoSave',
  'braiins.alertsUnacknowledgedOnly': 'hashrate-autopilot.alertsUnacknowledgedOnly',
  'braiins.alertsLastToastId': 'hashrate-autopilot.alertsLastToastId',
};

export function migrateLegacyStorageKeys(): void {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  for (const [oldKey, newKey] of Object.entries(RENAMES)) {
    const v = ls.getItem(oldKey);
    if (v === null) continue;
    // If the new key already exists, the operator already moved over
    // (or set it via a fresh install); don't overwrite. Just delete
    // the legacy key.
    if (ls.getItem(newKey) === null) {
      ls.setItem(newKey, v);
    }
    ls.removeItem(oldKey);
  }
}
