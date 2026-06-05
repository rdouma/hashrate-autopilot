/**
 * #266: dashboard StatsBar tile catalogue.
 *
 * Single source of truth for which tile ids exist, what they read
 * from, and how they're labelled. Server-side: used by the
 * defensive parser so a stale config blob doesn't reference a
 * dropped tile. Dashboard-side: drives the picker dropdown and
 * the tile renderer's source-field lookup.
 *
 * Adding a new tile:
 *
 * 1. Add an entry to TILE_CATALOGUE below.
 * 2. Ensure the data source it references exists on whichever query
 *    the dashboard already pulls. Add a stats-route field if the
 *    catalogue entry's `source` is `stats` and the field is new.
 * 3. Implement the dashboard-side renderer in StatsBar.tsx (it
 *    matches on tile id and reads the right source).
 *
 * Removing a tile:
 *
 * - Just delete the catalogue entry. Operators with the removed id
 *   in their saved blob will see it filtered at render time and
 *   their other tiles preserved.
 */

/** Stable identifier for a single tile slot. Persisted in config. */
export type DashboardTileId =
  | 'uptime'
  | 'avg_braiins'
  | 'avg_datum'
  | 'avg_ocean'
  | 'avg_cost_delivered'
  | 'avg_cost_vs_hashprice'
  | 'uptime_bid_coverage'
  | 'uptime_delivery_when_bid_active'
  | 'hashrate_target'
  | 'wallet_runway_days'
  | 'hashprice_now'
  | 'pool_blocks_30d'
  | 'pool_luck_24h'
  | 'pool_luck_7d'
  | 'pool_luck_30d'
  | 'share_log_pct'
  | 'share_rejection_pct'
  | 'avg_overpay_intent'
  | 'avg_overpay_settled'
  | 'bitaxe_fleet_hashrate'
  | 'bitaxe_fleet_power'
  | 'bitaxe_fleet_efficiency_j_per_th';

export interface DashboardTileMeta {
  readonly id: DashboardTileId;
  /**
   * Group label used in the picker dropdown to bucket similar
   * tiles together. Free-form string for now; the dashboard maps
   * known values to translated headings.
   */
  readonly group: 'Hashrate' | 'Pricing' | 'Pool' | 'Wallet' | 'Bitaxe' | 'Uptime';
  /**
   * Untranslated key the dashboard uses with Lingui's `t` macro to
   * render the tile's short label. Keep these stable; the dashboard
   * has a `switch` mapping each id to a translated `t\`...\`` call.
   */
  readonly labelKey: string;
}

export const TILE_CATALOGUE: ReadonlyArray<DashboardTileMeta> = [
  // The existing 6 tiles - these are what every install ships with
  // when `dashboard_tiles` is empty.
  { id: 'uptime', group: 'Uptime', labelKey: 'uptime' },
  { id: 'avg_braiins', group: 'Hashrate', labelKey: 'avg braiins' },
  { id: 'avg_datum', group: 'Hashrate', labelKey: 'avg datum' },
  { id: 'avg_ocean', group: 'Hashrate', labelKey: 'avg ocean' },
  { id: 'avg_cost_delivered', group: 'Pricing', labelKey: 'avg cost delivered' },
  { id: 'avg_cost_vs_hashprice', group: 'Pricing', labelKey: 'avg cost vs hashprice' },

  // Uptime decomposition (#254).
  { id: 'uptime_bid_coverage', group: 'Uptime', labelKey: 'bid coverage' },
  {
    id: 'uptime_delivery_when_bid_active',
    group: 'Uptime',
    labelKey: 'delivery rate (while bidding)',
  },

  // Hashrate metrics.
  { id: 'hashrate_target', group: 'Hashrate', labelKey: 'hashrate target' },
  { id: 'share_rejection_pct', group: 'Hashrate', labelKey: 'share rejection' },

  // Pricing metrics.
  { id: 'hashprice_now', group: 'Pricing', labelKey: 'hashprice now' },
  { id: 'avg_overpay_intent', group: 'Pricing', labelKey: 'avg overpay (intent)' },
  { id: 'avg_overpay_settled', group: 'Pricing', labelKey: 'avg overpay (settled)' },

  // Pool metrics.
  { id: 'pool_blocks_30d', group: 'Pool', labelKey: 'pool blocks 30d' },
  { id: 'pool_luck_24h', group: 'Pool', labelKey: 'pool luck 24h' },
  { id: 'pool_luck_7d', group: 'Pool', labelKey: 'pool luck 7d' },
  { id: 'pool_luck_30d', group: 'Pool', labelKey: 'pool luck 30d' },
  { id: 'share_log_pct', group: 'Pool', labelKey: 'share log %' },

  // Wallet metrics.
  { id: 'wallet_runway_days', group: 'Wallet', labelKey: 'wallet runway' },

  // Bitaxe fleet metrics.
  { id: 'bitaxe_fleet_hashrate', group: 'Bitaxe', labelKey: 'Bitaxe hashrate' },
  { id: 'bitaxe_fleet_power', group: 'Bitaxe', labelKey: 'Bitaxe power' },
  {
    id: 'bitaxe_fleet_efficiency_j_per_th',
    group: 'Bitaxe',
    labelKey: 'Bitaxe efficiency',
  },
];

const TILE_IDS: ReadonlySet<DashboardTileId> = new Set(
  TILE_CATALOGUE.map((m) => m.id),
);

/**
 * The dashboard's default tile set, shown on a fresh install or when
 * `config.dashboard_tiles` is empty. Mirrors the pre-#266 hardcoded
 * StatsBar so existing operators see the same layout until they pick
 * something different.
 */
export const DEFAULT_DASHBOARD_TILES: ReadonlyArray<DashboardTileId> = [
  'uptime',
  'avg_braiins',
  'avg_datum',
  'avg_ocean',
  'avg_cost_delivered',
  'avg_cost_vs_hashprice',
];

/**
 * Cap on how many tiles can be added at once. 24 is "two rows of 12"
 * on the widest desktop; in practice nobody will hit this. Soft cap
 * lives on the dashboard side; this hard cap protects the daemon
 * from a runaway JSON blob.
 */
export const MAX_DASHBOARD_TILES = 24;

/**
 * Parse the JSON-string `dashboard_tiles` config field into an array
 * of valid tile ids. Bad JSON, non-array, non-string entries, ids
 * not in the catalogue, and over-cap arrays all collapse cleanly:
 *
 * - Malformed JSON or non-array  → `[]` (= "use defaults" on render)
 * - Unknown ids in array         → filtered out, others preserved
 * - Duplicate ids                → collapsed to first occurrence
 * - Over-cap arrays              → truncated to MAX_DASHBOARD_TILES
 *
 * Returns the empty array when the operator is on the dashboard
 * default, which `dashboardTilesOrDefault` then resolves to the
 * built-in DEFAULT_DASHBOARD_TILES at render time.
 */
export function parseDashboardTiles(
  json: string | null | undefined,
): DashboardTileId[] {
  if (!json || typeof json !== 'string') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<DashboardTileId>();
  const out: DashboardTileId[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (!TILE_IDS.has(entry as DashboardTileId)) continue;
    const id = entry as DashboardTileId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_DASHBOARD_TILES) break;
  }
  return out;
}

/**
 * Resolve a parsed tile list against the catalogue and default. When
 * the operator hasn't customised (empty array), returns the
 * built-in defaults so callers can render without a separate
 * "are we using defaults?" check.
 */
export function dashboardTilesOrDefault(
  parsed: ReadonlyArray<DashboardTileId>,
): ReadonlyArray<DashboardTileId> {
  return parsed.length === 0 ? DEFAULT_DASHBOARD_TILES : parsed;
}
