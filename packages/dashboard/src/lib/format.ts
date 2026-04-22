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
 * Human-readable timestamp with explicit local timezone, e.g.
 * `"2026-04-19 01:30:45 CEST"`. Used inside JSON payloads copied from
 * the dashboard so someone reading the dump later can orient without
 * converting a unix ms integer in their head.
 */
export function formatTimestampHuman(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // Intl is the only reliable way to get a locale-independent short
  // timezone name (e.g. "CEST"/"EST"). Fall back to the numeric offset
  // if the runtime doesn't expose a named zone.
  let tz = '';
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
    tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    // ignore — fall through to offset-based string below
  }
  if (!tz) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    tz = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  return `${date} ${time} ${tz}`;
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

/**
 * Two-unit age at minute resolution — "just now", "5m ago", "18h 22m ago",
 * "2d 5h ago". No seconds (too noisy for static popovers); single-unit
 * {@link formatAge} loses the minute detail past an hour ("18h ago").
 */
export function formatAgeMinutes(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ms) return '—';
  const totalSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (totalSec < 60) return 'just now';
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ago`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return `${totalHr}h ${m}m ago`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return `${totalDay}d ${h}h ago`;
}

/**
 * Two-unit age — "45s ago", "12m 17s ago", "3h 4m ago", "2d 5h ago".
 * Re-render once per second and the seconds digit ticks visibly; the
 * single-unit {@link formatAge} rounds and so feels frozen mid-minute.
 */
export function formatAgePrecise(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ms) return '—';
  const totalSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec - totalMin * 60;
    return `${totalMin}m ${s}s ago`;
  }
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return `${totalHr}h ${m}m ago`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return `${totalDay}d ${h}h ago`;
}

/**
 * Two-unit forward duration — "45s", "12m 17s", "3h 4m", "2d 5h".
 * Used for the "refreshes in X" countdown in panel headers. Rounds
 * fractional seconds up so a 950ms remainder shows as 1s (not 0s)
 * and the counter doesn't flicker down to 0 while the timer fires.
 * Returns "now" when the target has already passed.
 */
export function formatCountdownPrecise(msUntil: number): string {
  if (msUntil <= 0) return 'now';
  const totalSec = Math.ceil(msUntil / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec - totalMin * 60;
    return `${totalMin}m ${s}s`;
  }
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return `${totalHr}h ${m}m`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return `${totalDay}d ${h}h`;
}
