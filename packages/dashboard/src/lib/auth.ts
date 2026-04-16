/**
 * Minimal Basic-Auth credential stash. We send the password as the Basic
 * Auth password on every fetch; there's no server-side session.
 *
 * Stored in sessionStorage so a tab refresh keeps the operator logged in
 * but closing the tab forgets it.
 */

const STORAGE_KEY = 'braiins.dashboardPassword';

export function setPassword(password: string): void {
  window.sessionStorage.setItem(STORAGE_KEY, password);
}

export function getPassword(): string | null {
  return window.sessionStorage.getItem(STORAGE_KEY);
}

export function clearPassword(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function basicAuthHeader(password: string): string {
  // Username is ignored server-side; "dashboard" is cosmetic.
  return 'Basic ' + btoa(`dashboard:${password}`);
}
