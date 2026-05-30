/**
 * Formatting helpers for the dashboard. Prices are displayed in
 * sat/PH/day throughout (API already returns them in that unit).
 *
 * #147: separators-of-concerns refactor. Two independent format
 * preferences:
 *
 *   - `numberLocale`: drives `Intl.NumberFormat` (thousands / decimal
 *     separators only). Read from localStorage `hashrate-autopilot.numberLocale`.
 *   - `dateLayout`: drives date/time layout (order, separators, 12h
 *     vs 24h). Read from localStorage `hashrate-autopilot.dateLayout`.
 *
 * Month-name language follows the *UI language* picker (Lingui),
 * NOT either of the format preferences - so an English-UI operator
 * who picks `1.234,56` European separators still sees `Apr` /
 * `May`, not `apr` / `mei`. See `lib/locale.ts` for the seam.
 *
 * Default values are read every call so the sidebar selectors take
 * effect without threading args through every component. Pass an
 * explicit locale/options object to override per call.
 */

import { t } from '@lingui/core/macro';

type Locale = string | undefined;

const NUMBER_LOCALE_STORAGE_KEY = 'hashrate-autopilot.numberLocale';
const DATE_LAYOUT_STORAGE_KEY = 'hashrate-autopilot.dateLayout';

function defaultLocale(): Locale {
  if (typeof window === 'undefined') return undefined;
  const stored = window.localStorage.getItem(NUMBER_LOCALE_STORAGE_KEY);
  if (!stored || stored === 'auto' || stored === 'system') return undefined;
  return stored;
}

function defaultDateLayout(): DateLayout {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(DATE_LAYOUT_STORAGE_KEY);
  if (isDateLayout(stored)) return stored;
  return 'system';
}

/**
 * Discrete date-layout enum. `system` means "let
 * `toLocaleString(uiLocale)` decide" - the original behaviour, useful
 * as a no-opinion fallback. The other variants are hand-assembled
 * from numeric parts so layout + 12h/24h are pinned regardless of
 * the UI language.
 */
export type DateLayout =
  | 'system'
  | 'us'
  | 'eu-spaced-24h'
  | 'slash-dmy-24h'
  | 'iso'
  | 'slash-mdy-12h';

const DATE_LAYOUTS: ReadonlyArray<DateLayout> = [
  'system',
  'us',
  'eu-spaced-24h',
  'slash-dmy-24h',
  'iso',
  'slash-mdy-12h',
];

function isDateLayout(v: string | null | undefined): v is DateLayout {
  return v !== null && v !== undefined && (DATE_LAYOUTS as readonly string[]).includes(v);
}

export interface FormatTimestampOptions {
  /** UI-language locale (drives month-name language). */
  uiLocale?: string;
  /** Layout enum (drives order / separators / 12h vs 24h). */
  layout?: DateLayout;
}

export function formatNumber(
  n: number,
  opts: Intl.NumberFormatOptions = {},
  locale: Locale = defaultLocale(),
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...opts }).format(n);
}

/**
 * Compact tick label for chart axes - auto-scales to the magnitude
 * and adds a k / M / B suffix so big numbers don't eat half the
 * chart's horizontal space. Targets readability at-a-glance, not
 * full precision (use formatNumber elsewhere when every digit
 * matters).
 *
 * Examples:
 *   48,400,000  -> "48,4M"  (nl-NL) / "48.4M" (en-US)
 *   1,234,567   -> "1,2M"
 *   12,345      -> "12,3k"
 *   123         -> "123"
 *   30.5        -> "30,5"   (1 decimal max)
 *   3.142       -> "3,14"   (2 decimals when below 10)
 *   0.00318     -> "0,003"  (3 decimals when below 1)
 *   0.0000182   -> "1,82e-5" (scientific when below 0.001)
 *
 * Suffix is always the literal "k" / "M" / "B" in every locale -
 * the alternative `notation: 'compact'` returns localised forms
 * like "48 mln." in nl-NL which read awkwardly on a tight axis.
 */
export function formatCompactNumber(
  n: number,
  locale: Locale = defaultLocale(),
  axisSpan?: number,
): string {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const fmt = (v: number, minDecimals: number, maxDecimals: number): string =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    }).format(v);
  // When the caller supplies the axis span (max - min), pick enough
  // decimals in the suffix so adjacent ticks don't collapse to the
  // same label. E.g. 1,780,000..1,840,000 at the M tier: span/1e6 =
  // 0.06 -> need 2 decimals ("1,78M" vs "1,84M") instead of the
  // default 1 ("1,8M" for both).
  const suffixDecimals = (divisor: number): number => {
    if (axisSpan === undefined || axisSpan <= 0) return 1;
    const spanInSuffix = axisSpan / divisor;
    if (spanInSuffix >= 1) return 1;
    if (spanInSuffix >= 0.1) return 2;
    return 3;
  };
  // For k/M/B-suffixed values, force exactly 1 decimal so adjacent
  // ticks don't visually swap suffix - "80k" next to "79,5k" reads
  // as a width jump even though the magnitude is identical. Always
  // showing 1 decimal ("80,0k" / "79,5k") keeps the column stable.
  // When axisSpan is provided and narrow, more decimals are used.
  if (abs >= 1e9) { const d = suffixDecimals(1e9); return `${fmt(n / 1e9, d, d)}B`; }
  if (abs >= 1e6) { const d = suffixDecimals(1e6); return `${fmt(n / 1e6, d, d)}M`; }
  // Below 1M we render with full thousands grouping rather than the
  // `k` suffix - "25,000" reads better than "25,0k" at the typical
  // pool-hashrate magnitudes where we have room for it. The k
  // suffix only saves a couple of characters in this range and the
  // grouped form is easier to scan.
  if (abs >= 1000) return fmt(n, 0, 0);
  // Below 1000, force a stable decimal count so a column of ticks
  // doesn't shuffle widths. Each tier picks the natural decimal
  // count for its magnitude.
  if (abs >= 10) return fmt(n, 1, 1);
  if (abs >= 1) return fmt(n, 2, 2);
  if (abs >= 0.001) return fmt(n, 3, 3);
  if (abs === 0) return '0';
  // Sub-0.001: scientific. toExponential is locale-dumb but the
  // exponent is universally readable.
  return n.toExponential(2);
}

export function formatSatPerPH(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '-';
  return `${formatNumber(n, {}, locale)} sat/PH/day`;
}

export function formatSats(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '-';
  return `${formatNumber(n, {}, locale)} sat`;
}

/**
 * Format a temperature stored as °C into the operator's preferred
 * unit. Internal storage always °C; conversion happens at display
 * boundary only (#157).
 *
 * Returns `'-'` on null/undefined (matches the rest of this file's
 * placeholder convention). `digits` defaults to 1, matching the
 * existing `.toFixed(1) °C` pattern; pass 0 for whole-degree
 * thresholds where decimals would be noise.
 */
export function formatTemperature(
  c: number | null | undefined,
  unit: 'C' | 'F',
  digits: number = 1,
): string {
  if (c === null || c === undefined) return '-';
  if (unit === 'F') {
    const f = c * 9 / 5 + 32;
    return `${f.toFixed(digits)} °F`;
  }
  return `${c.toFixed(digits)} °C`;
}

/** Round-trip conversion utilities for inputs that store °C but display °F. */
export function celsiusToFahrenheit(c: number): number {
  return c * 9 / 5 + 32;
}
export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

export function formatHashratePH(
  n: number | null | undefined,
  locale: Locale = defaultLocale(),
): string {
  if (n === null || n === undefined) return '-';
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)} PH/s`;
}

/**
 * Render a timestamp using the operator's date-layout preference.
 *
 * Backwards-compatible signature:
 *   - `formatTimestamp(ms)` reads numberLocale + dateLayout from
 *     localStorage (legacy default path).
 *   - `formatTimestamp(ms, "nl-NL")` is the *old* bare-locale form
 *     and is treated as `{ uiLocale: "nl-NL", layout: 'system' }`.
 *     Kept so #147's migration can ship without rewriting every
 *     non-leak call site at once; new call sites should pass the
 *     options object.
 *   - `formatTimestamp(ms, { uiLocale, layout })` is the post-#147
 *     idiomatic form. `uiLocale` drives month-name language;
 *     `layout` drives ordering / separators / 12h vs 24h.
 */
export function formatTimestamp(
  ms: number | null | undefined,
  opts: Locale | FormatTimestampOptions = {},
): string {
  if (!ms) return '-';
  const o: FormatTimestampOptions =
    opts === undefined || typeof opts === 'string'
      ? { uiLocale: opts ?? undefined, layout: defaultDateLayout() }
      : opts;
  const layout: DateLayout = o.layout ?? defaultDateLayout();
  const uiLocale = o.uiLocale;
  const d = new Date(ms);

  if (layout === 'system') {
    return d.toLocaleString(uiLocale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  const pad = (n: number) => n.toString().padStart(2, '0');
  // Month-name in the operator's UI language (Apr / apr / abr / Mai).
  // Fall back to en-US so the build doesn't break under jsdom in
  // tests where Intl is partial.
  const monthShort = new Intl.DateTimeFormat(uiLocale ?? 'en-US', { month: 'short' }).format(d);
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const dayNum = d.getDate();
  const h24 = pad(d.getHours());
  const min = pad(d.getMinutes());
  const sec = pad(d.getSeconds());
  const h12Raw = ((d.getHours() + 11) % 12) + 1;
  const h12 = pad(h12Raw);
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';

  let datePart: string;
  let timePart: string;
  switch (layout) {
    case 'us':
      datePart = `${monthShort} ${dayNum}, ${Y}`;
      timePart = `${h12Raw}:${min}:${sec} ${ampm}`;
      break;
    case 'eu-spaced-24h':
      datePart = `${dayNum} ${monthShort} ${Y}`;
      timePart = `${h24}:${min}:${sec}`;
      break;
    case 'slash-dmy-24h':
      datePart = `${D}/${M}/${Y}`;
      timePart = `${h24}:${min}:${sec}`;
      break;
    case 'iso':
      datePart = `${Y}-${M}-${D}`;
      timePart = `${h24}:${min}:${sec}`;
      break;
    case 'slash-mdy-12h':
      datePart = `${M}/${D}/${Y}`;
      timePart = `${h12}:${min}:${sec} ${ampm}`;
      break;
  }
  return `${datePart}, ${timePart}`;
}

/**
 * Compact, secondsless variant for the format-picker preview labels
 * on the Config page. Same layout rules as `formatTimestamp` minus
 * seconds, so the dropdown options match the canonical "shape
 * sample" used in #147's spec.
 */
export function formatTimestampSample(
  ms: number,
  uiLocale: string | undefined,
  layout: DateLayout,
): string {
  if (layout === 'system') {
    return new Date(ms).toLocaleString(uiLocale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const monthShort = new Intl.DateTimeFormat(uiLocale ?? 'en-US', { month: 'short' }).format(d);
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const dayNum = d.getDate();
  const h24 = pad(d.getHours());
  const min = pad(d.getMinutes());
  const h12Raw = ((d.getHours() + 11) % 12) + 1;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  switch (layout) {
    case 'us':
      return `${monthShort} ${dayNum}, ${Y}, ${h12Raw}:${min} ${ampm}`;
    case 'eu-spaced-24h':
      return `${dayNum} ${monthShort} ${Y}, ${h24}:${min}`;
    case 'slash-dmy-24h':
      return `${D}/${M}/${Y}, ${h24}:${min}`;
    case 'iso':
      return `${Y}-${M}-${D}, ${h24}:${min}`;
    case 'slash-mdy-12h':
      return `${M}/${D}/${Y}, ${h12Raw}:${min} ${ampm}`;
  }
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
    // ignore - fall through to offset-based string below
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
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function formatAge(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return '-';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return t`${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.round(hours / 24);
  return t`${days}d ago`;
}

/**
 * Format a raw duration (in ms) as "Xs", "Xm", "Xh Ym", "Xd Yh" - the
 * same shape as {@link formatAgeMinutes} but without the trailing
 * "ago", because the value is a duration not an offset-from-now. Used
 * by event cards on the Alerts page ("was open for 6m") where the
 * value is `recovery.created_at - firing.created_at`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return m > 0 ? `${totalHr}h ${m}m` : `${totalHr}h`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return h > 0 ? `${totalDay}d ${h}h` : `${totalDay}d`;
}

/**
 * Two-unit age at minute resolution - "just now", "5m ago", "18h 22m ago",
 * "2d 5h ago". No seconds (too noisy for static popovers); single-unit
 * {@link formatAge} loses the minute detail past an hour ("18h ago").
 */
export function formatAgeMinutes(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ms) return '-';
  const totalSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (totalSec < 60) return t`just now`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return t`${totalMin}m ago`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return t`${totalHr}h ${m}m ago`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return t`${totalDay}d ${h}h ago`;
}

/**
 * Two-unit age - "45s ago", "12m 17s ago", "3h 4m ago", "2d 5h ago".
 * Re-render once per second and the seconds digit ticks visibly; the
 * single-unit {@link formatAge} rounds and so feels frozen mid-minute.
 */
export function formatAgePrecise(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ms) return '-';
  const totalSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (totalSec < 60) return t`${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec - totalMin * 60;
    return t`${totalMin}m ${s}s ago`;
  }
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return t`${totalHr}h ${m}m ago`;
  }
  const totalDay = Math.floor(totalHr / 24);
  const h = totalHr - totalDay * 24;
  return t`${totalDay}d ${h}h ago`;
}

/**
 * Two-unit forward duration - "45s", "12m 17s", "3h 4m", "2d 5h".
 * Used for the "refreshes in X" countdown in panel headers. Rounds
 * fractional seconds up so a 950ms remainder shows as 1s (not 0s)
 * and the counter doesn't flicker down to 0 while the timer fires.
 * Returns "now" when the target has already passed.
 */
export function formatCountdownPrecise(msUntil: number): string {
  if (msUntil <= 0) return t`now`;
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
