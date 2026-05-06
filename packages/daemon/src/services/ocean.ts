/**
 * Ocean pool stats client using the public JSON API at api.ocean.xyz.
 *
 * Primary endpoint: GET /v1/statsnap/<address> - returns unpaid
 * earnings, estimated next-block earnings, shares in the TIDES
 * reward window.
 *
 * Secondary: GET /v1/user_hashrate/<address> - multi-interval
 * hashrates + active worker count. Used for the daily-earnings
 * estimate and share-log %.
 *
 * GET /v1/pool_stat - pool-wide stats for share-log % computation.
 *
 * All endpoints are unauthenticated, per-address. No rate-limit
 * headers observed; we cache with a 5-min TTL to be polite.
 *
 * Previous version scraped HTML templates from ocean.xyz (fragments
 * at /template/workers/*). Replaced per issue #9 - the JSON API is
 * more reliable and returns structured data.
 */

const OCEAN_API_BASE = 'https://api.ocean.xyz/v1';
const PAYOUT_THRESHOLD_SAT = 1_048_576;
// 60 s matches the dashboard tick / Ocean-panel refetch cadence.
// Originally 5 min to "be polite" to Ocean's public API, but the
// panel felt sluggish and the four endpoints we hit (statsnap,
// user_hashrate, pool_stat, blocks) total ~4 req/min per wallet -
// well below any sane rate limit. Keeping this aligned with the
// panel refetchInterval also makes block-metadata enrichment pick
// up new blocks within a minute instead of up to five.
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const SAT_PER_BTC = 100_000_000;
const BLOCKS_PER_DAY = 144;

export interface OceanBlock {
  readonly height: number;
  readonly timestamp_ms: number;
  readonly total_reward_sat: number;
  readonly subsidy_sat: number;
  readonly fees_sat: number;
  readonly worker: string;
  /** Finder's BTC payout address (Ocean's `username` field). Used to
   *  tag blocks our own wallet submitted the winning share for. */
  readonly username: string;
  /** Block hash for explorer links / tooltip context. */
  readonly block_hash: string;
}

export interface OceanPoolInfo {
  readonly active_users: number | null;
  readonly active_workers: number | null;
  readonly network_difficulty: number | null;
  readonly pool_hashrate_ph: number | null;
  readonly estimated_block_reward_sat: number | null;
}

export interface OceanStats {
  readonly unpaid_sat: number | null;
  readonly lifetime_sat: number | null;
  readonly rewards_in_window_sat: number | null;
  readonly next_block_sat: number | null;
  readonly daily_estimate_sat: number | null;
  /**
   * Break-even hashprice: revenue per PH/s per day from mining at
   * the current network difficulty and block reward. If you're
   * buying hashrate ABOVE this, you're paying more than mining
   * earns - unprofitable. Below = profitable.
   *
   * Formula: (block_reward_sat × 144 blocks/day) / network_hashrate_ph
   */
  readonly hashprice_sat_per_ph_day: number | null;
  readonly time_to_payout_text: string | null;
  readonly share_log_pct: number | null;
  readonly payout_threshold_sat: number;
  readonly recent_blocks: readonly OceanBlock[];
  readonly pool: OceanPoolInfo;
  readonly user_hashrate_th: number | null;
  /**
   * 5-minute sliding-window hashrate (PH/s) from the same
   * `/v1/user_hashrate` response's `hashrate_300s` field - what the
   * Hashrate chart plots as `received (Ocean)`. Exposed on the Ocean
   * panel so the at-a-glance row matches the chart series. Null when
   * unavailable.
   */
  readonly user_hashrate_5m_ph: number | null;
  readonly fetched_at_ms: number;
}

export interface OceanClient {
  fetchStats(address: string): Promise<OceanStats | null>;
}

export interface OceanClientOptions {
  readonly fetch?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export function createOceanClient(opts: OceanClientOptions = {}): OceanClient {
  const fetchImpl = opts.fetch ?? fetch;
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  const cache = new Map<string, OceanStats>();

  return {
    async fetchStats(address: string): Promise<OceanStats | null> {
      const cached = cache.get(address);
      if (cached && now() - cached.fetched_at_ms < ttl) return cached;

      try {
        const [statsnap, hashrate, poolStat, blocksResp, poolHashrateResp] = await Promise.all([
          getJson(fetchImpl, `${OCEAN_API_BASE}/statsnap/${address}`),
          getJson(fetchImpl, `${OCEAN_API_BASE}/user_hashrate/${address}`),
          getJson(fetchImpl, `${OCEAN_API_BASE}/pool_stat`),
          getJson(fetchImpl, `${OCEAN_API_BASE}/blocks`).catch(() => null),
          // Direct pool hashrate from Ocean - server-side 5-min
          // smoothed value, far more reliable than our previous
          // user_hashrate / share_log estimate (which spiked when
          // either input jittered single-tick).
          getJson(fetchImpl, `${OCEAN_API_BASE}/pool_hashrate`).catch(() => null),
        ]);

        const snap = (statsnap?.result ?? {}) as Record<string, string>;
        const hr = (hashrate?.result ?? {}) as Record<string, string>;
        const pool = (poolStat?.result ?? {}) as Record<string, string>;
        const poolHr = (poolHashrateResp?.result ?? {}) as Record<string, string>;

        const unpaidBtc = parseFloat(snap.unpaid ?? '');
        const unpaid_sat = Number.isFinite(unpaidBtc)
          ? Math.round(unpaidBtc * SAT_PER_BTC)
          : null;

        const nextBlockBtc = parseFloat(snap.estimated_total_earn_next_block ?? '');
        const next_block_sat = Number.isFinite(nextBlockBtc)
          ? Math.round(nextBlockBtc * SAT_PER_BTC)
          : null;

        // Shares in TIDES window
        const sharesInTides = Number(snap.shares_in_tides ?? 0);
        const poolShares = Number(pool.current_tides_shares ?? 0);
        const share_log_pct =
          poolShares > 0 ? (sharesInTides / poolShares) * 100 : null;

        // Estimated rewards in window (share % * estimated block reward)
        const blockRewardBtc = parseFloat(pool.current_estimated_block_reward ?? '');
        const rewards_in_window_sat =
          share_log_pct !== null && Number.isFinite(blockRewardBtc)
            ? Math.round((share_log_pct / 100) * blockRewardBtc * SAT_PER_BTC)
            : null;

        // Daily estimate: user's share of pool hashrate × blocks/day × reward
        const userHash3h = Number(hr.hashrate_10800s ?? 0);
        const networkDifficulty = Number(pool.network_difficulty ?? 0);
        const networkHashrate =
          networkDifficulty > 0
            ? (networkDifficulty * 2 ** 32) / 600
            : 0;
        const daily_estimate_sat =
          networkHashrate > 0 && userHash3h > 0 && Number.isFinite(blockRewardBtc)
            ? Math.round(
                (userHash3h / networkHashrate) *
                  BLOCKS_PER_DAY *
                  blockRewardBtc *
                  SAT_PER_BTC,
              )
            : null;

        // Hashprice: revenue per PH/s per day at current difficulty.
        // This is the break-even line - if you're buying above this,
        // mining costs more than it earns.
        const networkHashratePh = networkHashrate / 1e15;
        const hashprice_sat_per_ph_day =
          networkHashratePh > 0 && Number.isFinite(blockRewardBtc)
            ? Math.round(
                (BLOCKS_PER_DAY * blockRewardBtc * SAT_PER_BTC) /
                  networkHashratePh,
              )
            : null;

        // Time to payout: (threshold − unpaid) / daily_rate
        let time_to_payout_text: string | null = null;
        if (unpaid_sat !== null && daily_estimate_sat !== null && daily_estimate_sat > 0) {
          const remainingSat = PAYOUT_THRESHOLD_SAT - unpaid_sat;
          if (remainingSat <= 0) {
            time_to_payout_text = 'Next block';
          } else {
            const daysRemaining = remainingSat / daily_estimate_sat;
            if (daysRemaining < 1) {
              const hours = Math.max(1, Math.round(daysRemaining * 24));
              time_to_payout_text = `${hours} hours`;
            } else {
              time_to_payout_text = `${Math.round(daysRemaining)} days`;
            }
          }
        }

        // Parse recent blocks.
        // Ocean's /v1/blocks returns ts as a bare ISO datetime with
        // microsecond precision and no timezone suffix, e.g.
        // "2026-04-18T10:54:28.021400". JavaScript's Date parser treats
        // such a string as *local time*, which made our "found X ago"
        // display drift by whatever TZ the daemon host was in - a block
        // mined minutes ago could appear hours off, sometimes even
        // inverting the monotonic height/time ordering. Force UTC.
        const rawBlocks = (blocksResp?.result as Record<string, unknown>)?.blocks;
        const recent_blocks: OceanBlock[] = Array.isArray(rawBlocks)
          ? (rawBlocks as Record<string, unknown>[]).slice(0, 15).map((b) => ({
              height: Number(b.height ?? 0),
              timestamp_ms: parseOceanTs(b.ts),
              total_reward_sat: Number(b.total_reward_sats ?? 0),
              subsidy_sat: Number(b.subsidy_sats ?? 0),
              fees_sat: Number(b.txn_fees_sats ?? 0),
              worker: String(b.workername ?? ''),
              username: String(b.username ?? ''),
              block_hash: String(b.block_hash ?? ''),
            }))
          : [];

        // Pool info
        const activeUsers = parseInt(String(pool.active_users ?? ''), 10);
        const activeWorkers = parseInt(String(pool.active_workers ?? ''), 10);
        const estimatedRewardBtc = parseFloat(pool.current_estimated_block_reward ?? '');

        // User hashrate (3h window, in H/s from the API)
        const userHash3hRaw = Number(hr.hashrate_10800s ?? 0);
        const user_hashrate_th = userHash3hRaw > 0 ? userHash3hRaw / 1e12 : null;
        // 5-min window - matches what the chart plots.
        const userHash5mRaw = Number(hr.hashrate_300s ?? 0);
        const user_hashrate_5m_ph = userHash5mRaw > 0 ? userHash5mRaw / 1e15 : null;

        // Pool hashrate from Ocean's dedicated /v1/pool_hashrate
        // endpoint - server-side 5-min smoothed value (`pool_300s`,
        // in H/s). Convert to PH/s by dividing by 1e15.
        // Falls back to the legacy user_hashrate / share_log
        // estimate when the dedicated endpoint is unreachable so
        // historical readings still populate.
        let pool_hashrate_ph: number | null = null;
        const poolHashrate300s = Number(poolHr.pool_300s ?? 0);
        if (Number.isFinite(poolHashrate300s) && poolHashrate300s > 0) {
          pool_hashrate_ph = Math.round(poolHashrate300s / 1e15);
        } else if (
          user_hashrate_5m_ph !== null &&
          share_log_pct !== null &&
          share_log_pct > 0
        ) {
          // Legacy fallback - noisy estimator. Kept for resilience
          // when the dedicated endpoint is unreachable.
          pool_hashrate_ph = Math.round(user_hashrate_5m_ph / (share_log_pct / 100));
        }
        const poolInfo: OceanPoolInfo = {
          active_users: Number.isFinite(activeUsers) ? activeUsers : null,
          active_workers: Number.isFinite(activeWorkers) ? activeWorkers : null,
          network_difficulty: networkDifficulty > 0 ? networkDifficulty : null,
          pool_hashrate_ph,
          estimated_block_reward_sat: Number.isFinite(estimatedRewardBtc)
            ? Math.round(estimatedRewardBtc * SAT_PER_BTC)
            : null,
        };

        const stats: OceanStats = {
          unpaid_sat,
          lifetime_sat: null,
          rewards_in_window_sat,
          next_block_sat,
          daily_estimate_sat,
          hashprice_sat_per_ph_day,
          time_to_payout_text,
          share_log_pct,
          payout_threshold_sat: PAYOUT_THRESHOLD_SAT,
          recent_blocks,
          pool: poolInfo,
          user_hashrate_th,
          user_hashrate_5m_ph,
          fetched_at_ms: now(),
        };
        cache.set(address, stats);
        return stats;
      } catch (err) {
        console.warn(
          `[ocean] fetchStats(${address}) failed: ${(err as Error).message}`,
        );
        return null;
      }
    },
  };
}

/**
 * Ocean returns ts like "2026-04-18T10:54:28.021400" - bare ISO with
 * no timezone suffix. Treat it as UTC by appending "Z" unless the
 * string already carries an offset. Return 0 on parse failure (our
 * caller converts that into a "never" in the UI).
 */
export function parseOceanTs(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const normalised = hasTz ? raw : raw + 'Z';
  const t = new Date(normalised).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'braiins-hashrate-autopilot/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}
