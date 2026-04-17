/**
 * Ocean pool stats client using the public JSON API at api.ocean.xyz.
 *
 * Primary endpoint: GET /v1/statsnap/<address> — returns unpaid
 * earnings, estimated next-block earnings, shares in the TIDES
 * reward window.
 *
 * Secondary: GET /v1/user_hashrate/<address> — multi-interval
 * hashrates + active worker count. Used for the daily-earnings
 * estimate and share-log %.
 *
 * GET /v1/pool_stat — pool-wide stats for share-log % computation.
 *
 * All endpoints are unauthenticated, per-address. No rate-limit
 * headers observed; we cache with a 5-min TTL to be polite.
 *
 * Previous version scraped HTML templates from ocean.xyz (fragments
 * at /template/workers/*). Replaced per issue #9 — the JSON API is
 * more reliable and returns structured data.
 */

const OCEAN_API_BASE = 'https://api.ocean.xyz/v1';
const PAYOUT_THRESHOLD_SAT = 1_048_576;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const SAT_PER_BTC = 100_000_000;
const BLOCKS_PER_DAY = 144;

export interface OceanStats {
  readonly unpaid_sat: number | null;
  readonly lifetime_sat: number | null;
  readonly rewards_in_window_sat: number | null;
  readonly next_block_sat: number | null;
  readonly daily_estimate_sat: number | null;
  readonly time_to_payout_text: string | null;
  readonly share_log_pct: number | null;
  readonly payout_threshold_sat: number;
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
        const [statsnap, hashrate, poolStat] = await Promise.all([
          getJson(fetchImpl, `${OCEAN_API_BASE}/statsnap/${address}`),
          getJson(fetchImpl, `${OCEAN_API_BASE}/user_hashrate/${address}`),
          getJson(fetchImpl, `${OCEAN_API_BASE}/pool_stat`),
        ]);

        const snap = (statsnap?.result ?? {}) as Record<string, string>;
        const hr = (hashrate?.result ?? {}) as Record<string, string>;
        const pool = (poolStat?.result ?? {}) as Record<string, string>;

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

        const stats: OceanStats = {
          unpaid_sat,
          lifetime_sat: null, // Not available via API; would need HTML scrape
          rewards_in_window_sat,
          next_block_sat,
          daily_estimate_sat,
          time_to_payout_text,
          share_log_pct,
          payout_threshold_sat: PAYOUT_THRESHOLD_SAT,
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
