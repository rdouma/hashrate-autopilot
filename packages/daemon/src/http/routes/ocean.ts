/**
 * GET /api/ocean
 *
 * Returns pool-wide and user-specific Ocean stats for the dashboard
 * Ocean panel: recent blocks, pool info, user earnings, hashrate,
 * and payout progress.
 */

import type { FastifyInstance } from 'fastify';

import type { ConfigRepo } from '../../state/repos/config.js';
import type { OceanClient, OceanBlock, OceanPoolInfo } from '../../services/ocean.js';

export interface OurBlock {
  height: number;
  timestamp_ms: number;
  total_reward_sat: number;
  subsidy_sat: number;
  fees_sat: number;
  block_hash: string;
  worker: string;
  /**
   * True when the block's finder was literally our payout address
   * (solo-lottery win, rare). False when we were only credited via
   * TIDES shares in the reward window (the common case while mining).
   */
  found_by_us: boolean;
}

export interface OceanResponse {
  configured: boolean;
  last_block: {
    height: number;
    timestamp_ms: number;
    total_reward_sat: number;
    block_hash: string;
    ago_text: string;
  } | null;
  blocks_24h: number;
  blocks_7d: number;
  recent_blocks: readonly OceanBlock[];
  /**
   * Pool blocks to overlay as markers on the Hashrate chart. Under
   * Ocean TIDES, every pool block credits every participant who had
   * shares in the reward window, so the MVP surfaces every recent
   * pool block; the `found_by_us` flag distinguishes the (rare)
   * solo-finder case so the UI can style it differently.
   *
   * Simplification: we do not yet cross-check per-block share-window
   * presence. If the daemon was offline long enough for our shares
   * to roll out of the 8-block TIDES window, those blocks would not
   * have actually credited us — but while mining continuously the
   * window is always non-empty, which matches the operator's day
   * to day use.
   */
  our_recent_blocks: readonly OurBlock[];
  pool: OceanPoolInfo | null;
  user: {
    unpaid_sat: number | null;
    next_block_sat: number | null;
    daily_estimate_sat: number | null;
    hashprice_sat_per_ph_day: number | null;
    time_to_payout_text: string | null;
    share_log_pct: number | null;
    hashrate_th: number | null;
    hashrate_5m_ph: number | null;
    payout_threshold_sat: number;
    rewards_in_window_sat: number | null;
  } | null;
  fetched_at_ms: number | null;
}

export async function registerOceanRoute(
  app: FastifyInstance,
  deps: {
    oceanClient: OceanClient | null;
    configRepo: ConfigRepo;
  },
): Promise<void> {
  app.get('/api/ocean', async (): Promise<OceanResponse> => {
    if (!deps.oceanClient) {
      return {
        configured: false,
        last_block: null,
        blocks_24h: 0,
        blocks_7d: 0,
        recent_blocks: [],
        our_recent_blocks: [],
        pool: null,
        user: null,
        fetched_at_ms: null,
      };
    }

    const config = await deps.configRepo.get();
    const address = config?.btc_payout_address;
    if (!address) {
      return {
        configured: false,
        last_block: null,
        blocks_24h: 0,
        blocks_7d: 0,
        recent_blocks: [],
        our_recent_blocks: [],
        pool: null,
        user: null,
        fetched_at_ms: null,
      };
    }

    const stats = await deps.oceanClient.fetchStats(address);
    if (!stats) {
      return {
        configured: true,
        last_block: null,
        blocks_24h: 0,
        blocks_7d: 0,
        recent_blocks: [],
        our_recent_blocks: [],
        pool: null,
        user: null,
        fetched_at_ms: null,
      };
    }

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    const lastBlock = stats.recent_blocks.length > 0 ? stats.recent_blocks[0]! : null;
    const blocks_24h = stats.recent_blocks.filter(
      (b) => b.timestamp_ms > 0 && now - b.timestamp_ms < DAY_MS,
    ).length;
    const blocks_7d = stats.recent_blocks.filter(
      (b) => b.timestamp_ms > 0 && now - b.timestamp_ms < 7 * DAY_MS,
    ).length;
    const our_recent_blocks: OurBlock[] = stats.recent_blocks.map((b) => ({
      height: b.height,
      timestamp_ms: b.timestamp_ms,
      total_reward_sat: b.total_reward_sat,
      subsidy_sat: b.subsidy_sat,
      fees_sat: b.fees_sat,
      block_hash: b.block_hash,
      worker: b.worker,
      found_by_us: b.username === address,
    }));

    return {
      configured: true,
      last_block: lastBlock
        ? {
            height: lastBlock.height,
            timestamp_ms: lastBlock.timestamp_ms,
            total_reward_sat: lastBlock.total_reward_sat,
            block_hash: lastBlock.block_hash,
            ago_text: formatAgo(now - lastBlock.timestamp_ms),
          }
        : null,
      blocks_24h,
      blocks_7d,
      recent_blocks: stats.recent_blocks,
      our_recent_blocks,
      pool: stats.pool,
      user: {
        unpaid_sat: stats.unpaid_sat,
        next_block_sat: stats.next_block_sat,
        daily_estimate_sat: stats.daily_estimate_sat,
        hashprice_sat_per_ph_day: stats.hashprice_sat_per_ph_day,
        time_to_payout_text: stats.time_to_payout_text,
        share_log_pct: stats.share_log_pct,
        hashrate_th: stats.user_hashrate_th,
        hashrate_5m_ph: stats.user_hashrate_5m_ph,
        payout_threshold_sat: stats.payout_threshold_sat,
        rewards_in_window_sat: stats.rewards_in_window_sat,
      },
      fetched_at_ms: stats.fetched_at_ms,
    };
  });
}

function formatAgo(ms: number): string {
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}
