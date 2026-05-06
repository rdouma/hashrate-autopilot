/**
 * Wraps the raw Braiins client with two concerns:
 *
 * 1. **TTL cache** for slow-moving market metadata (`/spot/settings`,
 *    `/spot/fee`) - refresh every `settingsTtlMs` / `feeTtlMs` rather
 *    than on every tick.
 * 2. **Last-OK tracking** - records the timestamp of the last successful
 *    read so the control loop can detect API outages (SPEC §9
 *    `api_outage_alert_after_minutes`).
 *
 * The underlying client already handles auth headers and grpc-message
 * decoding. See `@braiins-hashrate/braiins-client`.
 */

import type {
  AccountBalances,
  BidDeliveryHistory,
  BidsResponse,
  BraiinsClient,
  FeeSchedule,
  MarketSettings,
  MarketStats,
  OrderbookSnapshot,
} from '@braiins-hashrate/braiins-client';

interface CachedValue<T> {
  value: T;
  cached_at: number;
}

export interface BraiinsServiceOptions {
  readonly client: BraiinsClient;
  /**
   * Per-endpoint TTLs for slow-moving metadata. Settings change
   * maybe once per Braiins release (weeks/months); fee changes only
   * on beta-exit. Separate knobs so we can poll fee faster than
   * settings to catch the beta-exit transition within the alert
   * window (addresses #7).
   */
  readonly settingsTtlMs?: number;
  readonly feeTtlMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export class BraiinsService {
  private readonly client: BraiinsClient;
  private readonly settingsTtlMs: number;
  private readonly feeTtlMs: number;
  private readonly now: () => number;

  private settingsCache: CachedValue<MarketSettings> | null = null;
  private feeCache: CachedValue<FeeSchedule> | null = null;
  private lastApiOkAt: number | null = null;

  constructor(options: BraiinsServiceOptions) {
    this.client = options.client;
    this.settingsTtlMs = options.settingsTtlMs ?? 60 * 60_000; // 1 hour
    this.feeTtlMs = options.feeTtlMs ?? 15 * 60_000; // 15 min
    this.now = options.now ?? Date.now;
  }

  // ---- fresh-every-tick reads ------------------------------------------

  async getStats(): Promise<MarketStats> {
    const v = await this.client.getStats();
    this.lastApiOkAt = this.now();
    return v;
  }

  async getOrderbook(): Promise<OrderbookSnapshot> {
    const v = await this.client.getOrderbook();
    this.lastApiOkAt = this.now();
    return v;
  }

  async getBalance(): Promise<AccountBalances> {
    const v = await this.client.getBalance();
    this.lastApiOkAt = this.now();
    return v;
  }

  async getCurrentBids(): Promise<BidsResponse> {
    const v = await this.client.getCurrentBids();
    this.lastApiOkAt = this.now();
    return v;
  }

  async getBidDeliveryHistory(orderId: string): Promise<BidDeliveryHistory> {
    const v = await this.client.getBidDeliveryHistory(orderId);
    this.lastApiOkAt = this.now();
    return v;
  }

  // ---- cached reads ----------------------------------------------------

  async getSettings(): Promise<MarketSettings> {
    if (this.settingsCache && this.now() - this.settingsCache.cached_at < this.settingsTtlMs) {
      return this.settingsCache.value;
    }
    const value = await this.client.getSettings();
    this.settingsCache = { value, cached_at: this.now() };
    this.lastApiOkAt = this.now();
    return value;
  }

  async getFee(): Promise<FeeSchedule> {
    if (this.feeCache && this.now() - this.feeCache.cached_at < this.feeTtlMs) {
      return this.feeCache.value;
    }
    const value = await this.client.getFee();
    this.feeCache = { value, cached_at: this.now() };
    this.lastApiOkAt = this.now();
    return value;
  }

  // ---- diagnostics -----------------------------------------------------

  getLastApiOkAt(): number | null {
    return this.lastApiOkAt;
  }

  /** Force-invalidate the metadata caches (e.g. after a schema-change alert). */
  invalidateMetadataCaches(): void {
    this.settingsCache = null;
    this.feeCache = null;
  }
}
