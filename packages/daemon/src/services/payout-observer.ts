/**
 * Observes on-chain receipts at the operator's configured
 * `btc_payout_address` via bitcoind's `scantxoutset`. Runs on a fixed
 * cadence (every `scanIntervalMs`, default 10 min). Caches the latest
 * snapshot in memory for the HTTP layer.
 *
 * We deliberately use `scantxoutset` instead of `listreceivedbyaddress`
 * so the address doesn't need to be imported into any bitcoind wallet —
 * it works against a vanilla node out of the box.
 *
 * Caveat: `scantxoutset` returns **currently unspent** outputs. If the
 * user sweeps their rewards elsewhere, the number resets. That's
 * documented in the dashboard card copy.
 */

import type { BitcoindClient, ScanTxoutSetResult } from '@braiins-hashrate/bitcoind-client';

import { createElectrsClient, type ElectrsClient } from './electrs-client.js';

const ELECTRS_INTERVAL_MS = 60 * 1000;
const BITCOIND_INTERVAL_MS = 60 * 60 * 1000;
const SAT_PER_BTC = 100_000_000;

export interface PayoutSnapshot {
  readonly address: string;
  readonly total_unspent_sat: number;
  readonly utxo_count: number | null;
  readonly scanned_block_height: number | null;
  readonly checked_at: number;
  readonly duration_ms: number;
  readonly source: 'electrs' | 'bitcoind';
}

export interface PayoutObserverOptions {
  readonly client: BitcoindClient;
  readonly getAddress: () => string;
  readonly electrsHost?: string | null;
  readonly electrsPort?: number | null;
  readonly scanIntervalMs?: number;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export class PayoutObserver {
  private lastSnapshot: PayoutSnapshot | null = null;
  private lastError: string | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PayoutObserverOptions) {}

  /**
   * Run one balance check. Uses Electrs if configured (instant indexed
   * lookup), otherwise falls back to bitcoind's `scantxoutset` (slow
   * full-UTXO-set scan). Never throws.
   */
  async scanOnce(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.running = (async () => {
      const address = this.options.getAddress();
      const now = this.options.now ?? Date.now;
      const start = now();
      try {
        if (this.options.electrsHost && this.options.electrsPort) {
          await this.scanViaElectrs(address, now, start);
        } else {
          await this.scanViaBitcoind(address, now, start);
        }
      } catch (err) {
        this.lastError = (err as Error).message;
        this.options.log?.(`[payout] scan failed: ${this.lastError}`);
      } finally {
        this.running = null;
      }
    })();
    await this.running;
  }

  private async scanViaElectrs(
    address: string,
    now: () => number,
    start: number,
  ): Promise<void> {
    let client: ElectrsClient | null = null;
    try {
      client = await createElectrsClient({
        host: this.options.electrsHost!,
        port: this.options.electrsPort!,
      });
      const balance = await client.getBalance(address);
      const totalSat = balance.confirmed + balance.unconfirmed;
      this.lastSnapshot = {
        address,
        total_unspent_sat: totalSat,
        utxo_count: null,
        scanned_block_height: null,
        checked_at: now(),
        duration_ms: now() - start,
        source: 'electrs',
      };
      this.lastError = null;
      this.options.log?.(
        `[payout] via electrs: ${address.slice(0, 12)}… balance=${totalSat} sat (${now() - start}ms)`,
      );
    } finally {
      client?.close();
    }
  }

  private async scanViaBitcoind(
    address: string,
    now: () => number,
    start: number,
  ): Promise<void> {
    const descriptor = `addr(${address})`;
    const result: ScanTxoutSetResult = await this.options.client.scanTxoutSet([descriptor]);
    const totalSat = Math.round(result.total_amount * SAT_PER_BTC);
    this.lastSnapshot = {
      address,
      total_unspent_sat: totalSat,
      utxo_count: result.unspents.length,
      scanned_block_height: result.height,
      checked_at: now(),
      duration_ms: now() - start,
      source: 'bitcoind',
    };
    this.lastError = null;
    this.options.log?.(
      `[payout] via bitcoind: ${address.slice(0, 12)}… unspent=${totalSat} sat in ${result.unspents.length} outs`,
    );
  }

  start(): void {
    if (this.timer) return;
    const useElectrs = !!(this.options.electrsHost && this.options.electrsPort);
    const defaultInterval = useElectrs ? ELECTRS_INTERVAL_MS : BITCOIND_INTERVAL_MS;
    const interval = this.options.scanIntervalMs ?? defaultInterval;
    setTimeout(() => void this.scanOnce(), 5_000);
    this.timer = setInterval(() => void this.scanOnce(), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLastSnapshot(): PayoutSnapshot | null {
    return this.lastSnapshot;
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
