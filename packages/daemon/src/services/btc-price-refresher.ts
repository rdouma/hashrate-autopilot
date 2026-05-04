/**
 * Periodic BTC/USD oracle refresh from inside the daemon.
 *
 * Without this, the BtcPriceService cache was driven entirely by
 * dashboard activity: `/api/btc-price` (which the dashboard polls)
 * was the only path that called `fetchPrice()`. When the operator's
 * laptop suspended / the browser tab went idle / they stopped looking
 * at the page, the dashboard's polling halted, the daemon's tick
 * loop kept calling `getLatest()`, and the same stale price got
 * written into `tick_metrics.btc_usd_price` for every tick until
 * someone opened the dashboard again. Visible to the operator as a
 * suspiciously flat ~2h BTC/USD line on the price chart that lined
 * up exactly with their sleeping hours.
 *
 * Mirrors HashpriceRefresher's structure - the daemon owns its own
 * cache cadence so the per-tick snapshot is always recent regardless
 * of dashboard activity. Cadence is well below the cache TTL so a
 * single transient oracle failure doesn't push the cache past the
 * staleness gate in `BtcPriceService.getLatest`.
 */
import type { ConfigRepo } from '../state/repos/config.js';
import type { BtcPriceService } from './btc-price.js';

export interface BtcPriceRefresherOptions {
  /** Milliseconds between refreshes. Defaults to 4 min - well below the 5-min cache TTL so one transient miss survives the staleness gate. */
  readonly intervalMs?: number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly log?: (msg: string) => void;
}

export class BtcPriceRefresher {
  private readonly configRepo: ConfigRepo;
  private readonly btcPriceService: BtcPriceService;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    configRepo: ConfigRepo,
    btcPriceService: BtcPriceService,
    opts: BtcPriceRefresherOptions = {},
  ) {
    this.configRepo = configRepo;
    this.btcPriceService = btcPriceService;
    this.intervalMs = opts.intervalMs ?? 4 * 60 * 1000;
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
    const source = cfg.btc_price_source;
    if (!source || source === 'none') return;

    try {
      await this.btcPriceService.fetchPrice(source);
    } catch (err) {
      this.log(`[btc-price-refresh] fetch failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
