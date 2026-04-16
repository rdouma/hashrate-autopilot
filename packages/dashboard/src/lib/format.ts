/**
 * Formatting helpers for the dashboard. Prices are displayed in
 * sat/PH/day throughout (API already returns them in that unit).
 *
 * Default locale is read from localStorage (`braiins.displayLocale`)
 * every call so the sidebar selector takes effect without threading
 * `locale` through every component. Pass an explicit locale to
 * override per call.
 */

type Locale = string | undefined;

const LOCALE_STORAGE_KEY = 'braiins.displayLocale';

function defaultLocale(): Locale {
  if (typeof window === 'undefined') return undefined;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (!stored || stored === 'auto') return undefined;
  return stored;
}

export function formatNumber(
  n: number,
  opts: Intl.NumberFormatOptions = {},
  locale: Locale = defaultLocale(),
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...opts }).format(n);
}

export function formatSatPerPH(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '—';
  return `${formatNumber(n, {}, locale)} sat/PH/day`;
}

export function formatSats(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '—';
  return `${formatNumber(n, {}, locale)} sat`;
}

export function formatHashratePH(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '—';
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)} PH/s`;
}

export function formatTimestamp(
  ms: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * UTC-only short format, handy for matching the Braiins dashboard (which
 * is always UTC). Always `YYYY-MM-DD HH:MM:SS UTC`, no locale conversion.
 */
export function formatTimestampUtc(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatAge(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return '—';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
