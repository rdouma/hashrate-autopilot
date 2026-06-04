/**
 * #238: per-series chart color resolution.
 *
 * Defaults table below is the canonical home of "what color does each
 * named line / marker default to." Operator overrides come from
 * `AppConfig.chart_color_overrides`, a JSON object stringified
 * server-side. The parser is defensive — any malformed key, missing
 * `#RRGGBB` prefix, or non-string value is silently dropped so a
 * stray browser write can't break the chart.
 *
 * Why JSON in one column instead of N columns: future series can be
 * added or removed without another migration; the table here is the
 * source of truth for keys, the daemon just stores the bag.
 */

/** Stable identifiers for every configurable series. New entries
 *  must be added here AND in CHART_COLOR_DEFAULTS below. */
export type ChartColorKey =
  // Hashrate chart left-axis
  | 'hashrate.delivered'
  | 'hashrate.received_datum'
  | 'hashrate.received_ocean'
  | 'hashrate.target'
  | 'hashrate.floor'
  | 'hashrate.pool_block_ours'
  | 'hashrate.pool_block_others'
  | 'hashrate.pool_block_bip110'
  | 'hashrate.marker_retarget'
  | 'hashrate.marker_ip_change'
  // Hashrate chart right-axis (universal — applies to whichever
  // right-axis option is selected; difficulty/share-log/pool-hashrate
  // all share this one slot).
  | 'hashrate.right_axis'
  // Price chart left-axis
  | 'price.our_bid'
  | 'price.fillable'
  | 'price.hashprice'
  | 'price.max_bid'
  | 'price.marker_payout_gem'
  | 'price.marker_deposit'
  // Price chart right-axis (universal — same shape as the hashrate
  // right axis).
  | 'price.right_axis'
  // Bid-event markers (both charts)
  | 'events.create'
  | 'events.edit_price'
  | 'events.edit_speed'
  | 'events.cancel';

export const CHART_COLOR_DEFAULTS: Record<ChartColorKey, string> = {
  // Hashrate left
  'hashrate.delivered': '#fb923c',          // amber-400 — Braiins delivered
  'hashrate.received_datum': '#34d399',     // emerald-400 — Datum received
  'hashrate.received_ocean': '#3b82f6',     // blue-500 — Ocean received
  'hashrate.target': '#64748b',             // slate-500 — dashed target
  'hashrate.floor': '#64748b',              // slate-500 — dashed floor
  'hashrate.pool_block_ours': '#facc15',    // yellow-400 — own pool blocks (crown)
  'hashrate.pool_block_others': '#3b82f6',  // sky/blue — non-own pool blocks (cube)
  'hashrate.pool_block_bip110': '#fde047',  // yellow-300 — BIP 110-signalling cube
  'hashrate.marker_retarget': '#c084fc',    // violet-400 — difficulty-retarget pickaxe
  'hashrate.marker_ip_change': '#38bdf8',   // sky-400 — public-IP-change router
  // Hashrate right
  'hashrate.right_axis': '#c084fc',         // violet-400 — shared right-axis line
  // Price left
  'price.our_bid': '#fb923c',               // amber-400
  'price.fillable': '#22d3ee',              // cyan-400
  'price.hashprice': '#a78bfa',             // violet-400 dotted
  'price.max_bid': '#f87171',               // rose-400
  'price.marker_payout_gem': '#10b981',     // emerald-500 — on-chain payout gem
  'price.marker_deposit': '#c084fc',        // violet-400 — Braiins deposit gem
  // Price right
  'price.right_axis': '#c084fc',            // violet-400
  // Bid-event markers
  'events.create': '#34d399',               // emerald-400 — +
  'events.edit_price': '#facc15',           // yellow-400 — ●
  'events.edit_speed': '#38bdf8',           // sky-400 — ◆
  'events.cancel': '#f87171',               // rose-400 — ×
};

/** Curated swatches for the picker. Two brightness rows × six hues
 *  covers the practical chart-color space without overwhelming the
 *  operator with the full hex spectrum on the first click. The
 *  "custom" tile in the picker opens the native color input for full
 *  freedom. */
export const CHART_COLOR_PRESETS: readonly string[] = [
  // Row 1: medium brightness
  '#f59e0b', // amber-500
  '#10b981', // emerald-500
  '#0ea5e9', // sky-500
  '#8b5cf6', // violet-500
  '#f43f5e', // rose-500
  '#14b8a6', // teal-500
  // Row 2: lighter for fills / secondary lines
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#38bdf8', // sky-400
  '#c084fc', // violet-400
  '#fb7185', // rose-400
  '#5eead4', // teal-400
];

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Backward-compat key renames for `parseOverrides`. When a key is
 * renamed in the schema (e.g. `price.unpaid` → `price.marker_deposit`
 * because the original key was misnamed - the colour only ever drove
 * the deposit gem marker, never the unpaid sat line), any saved
 * overrides under the old key should still take effect under the new
 * one. Old key on the left, current key on the right.
 */
const KEY_ALIASES: Record<string, ChartColorKey> = {
  'price.unpaid': 'price.marker_deposit',
};

/**
 * Parse the JSON-string overrides bag stored on the daemon into a
 * partial map of valid `#RRGGBB` entries. Malformed JSON, non-object
 * roots, unknown keys, and non-hex values are silently dropped — the
 * dashboard treats a missing override as "use the default", which
 * is the safe behavior.
 */
export function parseOverrides(json: string | null | undefined): Partial<Record<ChartColorKey, string>> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<ChartColorKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (!HEX_PATTERN.test(v)) continue;
    // Resolve old aliases (renamed keys) before checking against the
    // current schema. The alias map intentionally only redirects when
    // the new key isn't already present in the same blob - so an
    // operator who already set the new key isn't silently overridden
    // by a stale legacy value.
    const aliased: ChartColorKey | undefined =
      k in KEY_ALIASES && !((KEY_ALIASES[k] as string) in (raw as object))
        ? KEY_ALIASES[k]
        : (k as ChartColorKey);
    if (!aliased || !(aliased in CHART_COLOR_DEFAULTS)) continue;
    out[aliased] = v;
  }
  return out;
}

/**
 * Resolve a series's color: operator override if present, else the
 * documented default. The lookup is cheap (object access twice) — safe
 * to call on every render inside chart components.
 */
export function getChartColor(
  key: ChartColorKey,
  overrides: Partial<Record<ChartColorKey, string>>,
): string {
  return overrides[key] ?? CHART_COLOR_DEFAULTS[key];
}

/**
 * Serialize a partial override map back into the JSON string the
 * daemon stores. Drops `undefined` and `null` entries (the convention
 * is that a key absent from the bag means "use default", not "store
 * null").
 */
export function serializeOverrides(overrides: Partial<Record<ChartColorKey, string>>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string' && HEX_PATTERN.test(v)) {
      clean[k] = v;
    }
  }
  return JSON.stringify(clean);
}
