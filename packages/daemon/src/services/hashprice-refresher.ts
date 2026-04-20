/**
 * Periodic hashprice refresh for the in-daemon cache.
 *
 * The dynamic-cap guard in decide() (issue #28) refuses to trade when
 * the operator has configured `max_overpay_vs_hashprice_sat_per_eh_day`
 * but the hashprice cache is empty or stale beyond the freshness
 * window. Without an in-daemon refresher, the cache only ever gets
 * written on boot + from the dashboard's finance poll — so a daemon
 * running headless for more than the freshness window silently stops
 * responding to the market (issue #33).
 *
 * This service runs a short, steady poll of Ocean from inside the
 * daemon, independent of the dashboard being open. Cadence is well
 * below the freshness gate so one or two transient failures can't
 * starve the cache. Guarded by the same config checks that gate the
 * boot-time fetch: without a payout address or without the dynamic
 * cap configured, there's nothing the cache is used for.
 */
import type { ConfigRepo } from '../state/repos/config.js';
import type { HashpriceCache } from './hashprice-cache.js';
import type { OceanClient } from './ocean.js';

export interface HashpriceRefresherOptions {
  /** Milliseconds between refreshes. Defaults to 10 min. */
  readonly intervalMs?: number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly log?: (msg: string) => void;
}

export class HashpriceRefresher {
  private readonly configRepo: ConfigRepo;
  private readonly oceanClient: OceanClient;
  private readonly cache: HashpriceCache;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    configRepo: ConfigRepo,
    oceanClient: OceanClient,
    cache: HashpriceCache,
    opts: HashpriceRefresherOptions = {},
  ) {
    this.configRepo = configRepo;
    this.oceanClient = oceanClient;
    this.cache = cache;
    this.intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    const cfg = await this.configRepo.get();
    if (!cfg) return;
    if (!cfg.btc_payout_address) return;
    if (cfg.max_overpay_vs_hashprice_sat_per_eh_day === null) return;

    try {
      const stats = await this.oceanClient.fetchStats(cfg.btc_payout_address);
      if (stats?.hashprice_sat_per_ph_day != null) {
        this.cache.set(stats.hashprice_sat_per_ph_day);
      } else {
        this.log('[hashprice-refresh] Ocean returned no hashprice');
      }
    } catch (err) {
      this.log(`[hashprice-refresh] fetch failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
