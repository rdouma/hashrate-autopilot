/**
 * GET /api/ocean
 *
 * Returns pool-wide and user-specific Ocean stats for the dashboard
 * Ocean panel: recent blocks, pool info, user earnings, hashrate,
 * and payout progress.
 */

import type { FastifyInstance } from 'fastify';

import type { ConfigRepo } from '../../state/repos/config.js';
import type { TickMetricsRepo } from '../../state/repos/tick_metrics.js';
import type { OceanClient, OceanBlock, OceanPoolInfo } from '../../services/ocean.js';
import type { BlockVersionService } from '../../services/block-version.js';
import { signalsBip110 } from '../../services/block-version.js';
import { computePoolLuck } from '../../services/pool-luck.js';

// Tolerance for joining a pool block to its nearest tick_metrics row.
// Ticks fire every 30s and pool blocks land ~every 10 min, so any block
// inside our recorded history will have a tick within 30s. 5 min is
// generous and absorbs daemon-restart gaps without grabbing a stale
// share_log from the wrong epoch.
const SHARE_LOG_AT_BLOCK_TOLERANCE_MS = 5 * 60 * 1000;

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
  /**
   * `share_log_pct` recorded by the closest tick to this block's
   * timestamp (within a few minutes). Null when the block predates our
   * tick-level history or no tick within the tolerance window had a
   * recorded share_log. The chart tooltip prefers this over the live
   * share_log so older blocks aren't misrepresented as the current
   * value, and only falls back to "current share_log + drift caveat"
   * when this is null.
   */
  share_log_pct_at_block: number | null;
  /**
   * #94: true when the block's header version field signals BIP-110
   * support (top-3-bits == 0b001 AND bit-4 set). Null when we couldn't
   * look up the version (no bitcoind/electrs configured, or the
   * lookup failed and is in the negative cache). False = not signaling.
   * Drives the crown marker on the chart.
   */
  signals_bip110: boolean | null;
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
  blocks_30d: number;
  blocks_all_time: number;
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
  pool_luck_30d: number | null;
  pool_luck_all_time: number | null;
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
   * have actually credited us - but while mining continuously the
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
    tickMetricsRepo: TickMetricsRepo;
    /** #108 follow-up: persistent pool-block ledger; the chart's cube
     * markers source from here so backfilled history renders, not just
     * Ocean's last-15-blocks slice. */
    poolBlocksRepo: import('../../state/repos/pool_blocks.js').PoolBlocksRepo;
    blockVersionService: BlockVersionService | null;
  },
): Promise<void> {
  app.get('/api/ocean', async (): Promise<OceanResponse> => {
    if (!deps.oceanClient) {
      return {
        configured: false,
        last_block: null,
        blocks_24h: 0,
        blocks_7d: 0,
        blocks_30d: 0,
        blocks_all_time: 0,
        pool_luck_24h: null,
        pool_luck_7d: null,
        pool_luck_30d: null,
        pool_luck_all_time: null,
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
        blocks_30d: 0,
        blocks_all_time: 0,
        pool_luck_24h: null,
        pool_luck_7d: null,
        pool_luck_30d: null,
        pool_luck_all_time: null,
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
        blocks_30d: 0,
        blocks_all_time: 0,
        pool_luck_24h: null,
        pool_luck_7d: null,
        pool_luck_30d: null,
        pool_luck_all_time: null,
        recent_blocks: [],
        our_recent_blocks: [],
        pool: null,
        user: null,
        fetched_at_ms: null,
      };
    }

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // #108 follow-up: source the historical block list from the
    // persistent pool_blocks table, not Ocean's per-call slice.
    // pool_blocks is upserted on every tick + by the boot-time
    // backfill, so it covers the full lookback window with no
    // dependency on whatever default page size Ocean returns.
    const RECENT_BLOCKS_LOOKBACK_DAYS = 30;
    const blocksFromTable = await deps.poolBlocksRepo
      .recent(360)
      .catch(() => [] as Awaited<ReturnType<typeof deps.poolBlocksRepo.recent>>);
    const tableCutoff = now - RECENT_BLOCKS_LOOKBACK_DAYS * DAY_MS;
    const recentBlocksMerged = blocksFromTable
      .filter((b) => b.timestamp_ms >= tableCutoff)
      .map((b) => ({
        height: b.height,
        timestamp_ms: b.timestamp_ms,
        total_reward_sat: b.total_reward_sat,
        subsidy_sat: b.subsidy_sat,
        fees_sat: b.fees_sat,
        worker: b.worker ?? '',
        username: b.username ?? '',
        block_hash: b.block_hash,
      }));
    // Fall back to Ocean's live slice if the table is empty (fresh
    // install where backfill has not run yet).
    const recentBlocksForUi =
      recentBlocksMerged.length > 0 ? recentBlocksMerged : stats.recent_blocks;
    const lastBlock = recentBlocksForUi.length > 0 ? recentBlocksForUi[0]! : null;
    const blocks_24h = recentBlocksForUi.filter(
      (b) => b.timestamp_ms > 0 && now - b.timestamp_ms < DAY_MS,
    ).length;
    const blocks_7d = recentBlocksForUi.filter(
      (b) => b.timestamp_ms > 0 && now - b.timestamp_ms < 7 * DAY_MS,
    ).length;
    const blocks_30d = recentBlocksForUi.filter(
      (b) => b.timestamp_ms > 0 && now - b.timestamp_ms < 30 * DAY_MS,
    ).length;
    const blocks_all_time = await deps.poolBlocksRepo.countAll().catch(() => 0);
    const blockTimestamps = recentBlocksForUi.map((b) => b.timestamp_ms);
    const [poolHashrate24h, poolHashrate7d, poolHashrate30d] = await Promise.all([
      deps.tickMetricsRepo.avgPoolHashratePhSince(now - DAY_MS).catch(() => null),
      deps.tickMetricsRepo.avgPoolHashratePhSince(now - 7 * DAY_MS).catch(() => null),
      deps.tickMetricsRepo.avgPoolHashratePhSince(now - 30 * DAY_MS).catch(() => null),
    ]);
    const pool_luck_24h = computePoolLuck({
      tickAt: now,
      countInWindow: blocks_24h,
      poolHashrateAvgPh: poolHashrate24h ?? stats.pool.pool_hashrate_ph,
      networkDifficulty: stats.pool.network_difficulty,
      windowMs: DAY_MS,
      recentBlockTimestampsMs: blockTimestamps,
    });
    const pool_luck_7d = computePoolLuck({
      tickAt: now,
      countInWindow: blocks_7d,
      poolHashrateAvgPh: poolHashrate7d ?? stats.pool.pool_hashrate_ph,
      networkDifficulty: stats.pool.network_difficulty,
      windowMs: 7 * DAY_MS,
      recentBlockTimestampsMs: blockTimestamps,
    });
    const pool_luck_30d = computePoolLuck({
      tickAt: now,
      countInWindow: blocks_30d,
      poolHashrateAvgPh: poolHashrate30d ?? stats.pool.pool_hashrate_ph,
      networkDifficulty: stats.pool.network_difficulty,
      windowMs: 30 * DAY_MS,
      recentBlockTimestampsMs: blockTimestamps,
    });
    const earliestBlockMs = await deps.poolBlocksRepo.earliestTimestampMs().catch(() => null);
    const allTimeWindowMs = earliestBlockMs !== null && earliestBlockMs > 0
      ? now - earliestBlockMs
      : null;
    const allTimeBlockTimestamps = allTimeWindowMs !== null
      ? await deps.poolBlocksRepo.timestampsSince(earliestBlockMs!).catch(() => blockTimestamps)
      : blockTimestamps;
    const poolHashrateAllTime = allTimeWindowMs !== null
      ? await deps.tickMetricsRepo.avgPoolHashratePhSince(earliestBlockMs!).catch(() => null)
      : null;
    const pool_luck_all_time = allTimeWindowMs !== null && allTimeWindowMs > 0
      ? computePoolLuck({
          tickAt: now,
          countInWindow: blocks_all_time,
          poolHashrateAvgPh: poolHashrateAllTime ?? stats.pool.pool_hashrate_ph,
          networkDifficulty: stats.pool.network_difficulty,
          windowMs: allTimeWindowMs,
          recentBlockTimestampsMs: allTimeBlockTimestamps,
        })
      : null;
    const shareLogAtBlock = await Promise.all(
      recentBlocksForUi.map((b) =>
        b.timestamp_ms > 0
          ? deps.tickMetricsRepo.nearestShareLogPct(
              b.timestamp_ms,
              SHARE_LOG_AT_BLOCK_TOLERANCE_MS,
            )
          : Promise.resolve(null),
      ),
    );
    // #94: per-block BIP-110 signal lookup. Cached + persistent, so
    // steady-state polls hit only the in-memory map. Failures are
    // negatively cached (5 min) so a single bitcoind hiccup doesn't
    // trigger N retries on every dashboard refresh.
    const signalsBip110ByBlock = await Promise.all(
      recentBlocksForUi.map(async (b) => {
        if (!deps.blockVersionService || !b.block_hash) return null;
        const version = await deps.blockVersionService
          .getVersion(b.block_hash, b.height ?? null)
          .catch(() => null);
        return signalsBip110(version);
      }),
    );
    const our_recent_blocks: OurBlock[] = recentBlocksForUi.map((b, i) => ({
      height: b.height,
      timestamp_ms: b.timestamp_ms,
      total_reward_sat: b.total_reward_sat,
      subsidy_sat: b.subsidy_sat,
      fees_sat: b.fees_sat,
      block_hash: b.block_hash,
      worker: b.worker,
      found_by_us: b.username === address,
      share_log_pct_at_block: shareLogAtBlock[i] ?? null,
      signals_bip110: signalsBip110ByBlock[i] ?? null,
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
      blocks_30d,
      blocks_all_time,
      pool_luck_24h,
      pool_luck_7d,
      pool_luck_30d,
      pool_luck_all_time,
      recent_blocks: recentBlocksForUi,
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
