/**
 * Observes on-chain receipts at the operator's configured
 * `btc_payout_address` via bitcoind's `scantxoutset`. Runs on a fixed
 * cadence (every `scanIntervalMs`, default 10 min). Caches the latest
 * snapshot in memory for the HTTP layer.
 *
 * We deliberately use `scantxoutset` instead of `listreceivedbyaddress`
 * so the address doesn't need to be imported into any bitcoind wallet -
 * it works against a vanilla node out of the box.
 *
 * Caveat: `scantxoutset` returns **currently unspent** outputs. If the
 * user sweeps their rewards elsewhere, the number resets. That's
 * documented in the dashboard card copy.
 */

import type { BitcoindClient, ScanTxoutSetResult } from '@braiins-hashrate/bitcoind-client';
import type { Kysely } from 'kysely';

import type { Database } from '../state/types.js';
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
  /**
   * #88: when provided, each bitcoind scan inserts any newly-seen
   * coinbase outputs into `reward_events` so the dashboard can ring
   * an audible cue. Optional - the reward_events table predates this
   * wiring and the observer's primary job is the balance snapshot,
   * not bookkeeping individual UTXOs.
   */
  readonly db?: Kysely<Database>;
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
    // #88: record any newly-seen coinbase UTXOs into reward_events so
    // the dashboard can ring the block-found cue. Best-effort: a DB
    // hiccup must not block the snapshot update above.
    if (this.options.db) {
      try {
        await this.recordNewRewardEvents(result, now());
      } catch (err) {
        this.options.log?.(`[payout] reward_events write failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Insert one row per coinbase UTXO not already in `reward_events`.
   * Non-coinbase UTXOs at the payout address (e.g. the operator
   * received a regular payment, or self-consolidated) are skipped -
   * we only want to ring the cue for actual block finds.
   */
  private async recordNewRewardEvents(
    result: ScanTxoutSetResult,
    detectedAt: number,
  ): Promise<void> {
    const db = this.options.db;
    if (!db) return;
    const coinbaseOuts = result.unspents.filter((u) => u.coinbase === true);
    if (coinbaseOuts.length === 0) return;
    // Cheap one-shot query: pull existing (txid, vout) pairs we've
    // already recorded so we only insert the deltas. The table is
    // tiny in practice (one row per pool block paid to this address)
    // so we don't need a per-row WHERE NOT EXISTS dance.
    const existing = await db
      .selectFrom('reward_events')
      .select(['txid', 'vout'])
      .execute();
    const seen = new Set(existing.map((r) => `${r.txid}:${r.vout}`));
    const newOnes = coinbaseOuts.filter((u) => !seen.has(`${u.txid}:${u.vout}`));
    if (newOnes.length === 0) return;
    await db
      .insertInto('reward_events')
      .values(
        newOnes.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          block_height: u.height,
          confirmations: Math.max(0, result.height - u.height + 1),
          value_sat: Math.round(u.amount * SAT_PER_BTC),
          detected_at: detectedAt,
        })),
      )
      .execute();
    this.options.log?.(
      `[payout] recorded ${newOnes.length} new reward_event row(s)`,
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

  /**
   * State machine for the dashboard's `collected (on-chain)` row (#97):
   * - 'computing' - observer is enabled but the first scan has not yet
   *   produced a snapshot. Either the very first scan is in flight, or
   *   the previous attempt errored before any snapshot existed. Renders
   *   as a spinner instead of the em-dash that confused the operator
   *   into thinking the integration was broken.
   * - 'ready'     - at least one scan has produced a snapshot. The
   *   `collected_sat` value the route returns reflects that snapshot.
   *
   * `idle` (observer disabled / not configured) is detected by the
   * route from `payoutObserver === null`, not from this method.
   */
  getCollectedStatus(): 'computing' | 'ready' {
    return this.lastSnapshot ? 'ready' : 'computing';
  }
}
