/**
 * Minimal Basic-Auth credential stash. We send the password as the Basic
 * Auth password on every fetch; there's no server-side session.
 *
 * Two storage backends:
 *   - `sessionStorage` (default) - dropped when the tab closes.
 *   - `localStorage` (when "Remember me" is ticked on the Login form) -
 *     persists across tab closes and device reboots. Required for mobile
 *     where the OS aggressively backgrounds tabs; without this, the
 *     operator hits a login screen every visit. LAN-only dashboard behind
 *     a password means the realistic threat is physical device access,
 *     which localStorage doesn't meaningfully worsen.
 *
 * `getPassword()` checks localStorage first, then sessionStorage - so the
 * rest of the app is oblivious to which backend is in use.
 */

const STORAGE_KEY = 'braiins.dashboardPassword';

export function setPassword(password: string, remember = false): void {
  const target = remember ? window.localStorage : window.sessionStorage;
  const other = remember ? window.sessionStorage : window.localStorage;
  target.setItem(STORAGE_KEY, password);
  // Clear the non-chosen store so a stale copy there can't shadow the
  // fresh one (edge case: operator logs in without remember, then logs
  // in again with remember - we want the localStorage copy to win and
  // no stray sessionStorage copy to linger).
  other.removeItem(STORAGE_KEY);
}

export function getPassword(): string | null {
  return (
    window.localStorage.getItem(STORAGE_KEY) ??
    window.sessionStorage.getItem(STORAGE_KEY)
  );
}

export function clearPassword(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function basicAuthHeader(password: string): string {
  // Username is ignored server-side; "dashboard" is cosmetic.
  return 'Basic ' + btoa(`dashboard:${password}`);
}
