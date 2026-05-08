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
   * outputs at the payout address into `reward_events` so the
   * dashboard can ring an audible cue and the chart's
   * paid_total_sat series can plot actual on-chain payment timing.
   * Optional - the reward_events table predates this wiring and the
   * observer's primary job is the balance snapshot, not bookkeeping
   * individual UTXOs.
   */
  readonly db?: Kysely<Database>;
  /**
   * Fires after a scan inserts at least one new `reward_events` row.
   * Used to immediately trigger a backfill of `tick_metrics.paid_total_sat`
   * (via runPoolLuckRecompute) so the chart updates without a second
   * daemon restart. Best-effort: failures are logged and swallowed.
   */
  readonly onRewardsChanged?: () => Promise<void>;
}

export class PayoutObserver {
  private lastSnapshot: PayoutSnapshot | null = null;
  private lastError: string | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rewardsTimer: NodeJS.Timeout | null = null;

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
      // Pull the per-UTXO list too so we can populate `reward_events`
      // without relying on bitcoind. Cost is one extra Electrum
      // call per scan against an instantly-indexed lookup. Listing
      // failures are non-fatal: the balance snapshot has already
      // been computed; reward_events just falls back to whatever
      // it had before.
      let unspents: Array<{ tx_hash: string; tx_pos: number; height: number; value: number }> = [];
      try {
        unspents = await client.listUnspent(address);
      } catch (err) {
        this.options.log?.(
          `[payout] electrs listunspent failed: ${(err as Error).message}`,
        );
      }
      this.lastSnapshot = {
        address,
        total_unspent_sat: totalSat,
        utxo_count: unspents.length || null,
        scanned_block_height: null,
        checked_at: now(),
        duration_ms: now() - start,
        source: 'electrs',
      };
      this.lastError = null;
      this.options.log?.(
        `[payout] via electrs: ${address.slice(0, 12)}… balance=${totalSat} sat in ${unspents.length} outs (${now() - start}ms)`,
      );

      // Insert any unspents we haven't already recorded into
      // reward_events. The chart's paid_total_sat series reads
      // straight from this table, so without this an electrs-only
      // setup (no bitcoind RPC, e.g. Umbrel installs that didn't
      // declare bitcoind as a dependency) had a flat-zero
      // lifetime-earnings line.
      if (this.options.db && unspents.length > 0 && client) {
        try {
          const inserted = await this.recordNewRewardEventsViaElectrs(
            client,
            unspents,
            now(),
          );
          if (inserted > 0 && this.options.onRewardsChanged) {
            await this.options.onRewardsChanged().catch((err) =>
              this.options.log?.(
                `[payout] onRewardsChanged failed: ${(err as Error).message}`,
              ),
            );
          }
        } catch (err) {
          this.options.log?.(
            `[payout] electrs reward_events write failed: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      client?.close();
    }
  }

  /**
   * Electrs counterpart to recordNewRewardEvents. Same
   * INSERT...ON CONFLICT DO NOTHING shape so duplicate (txid, vout)
   * pairs are idempotently filtered by the UNIQUE index added in
   * migration 0072. Block timestamp lookup goes through electrs's
   * `blockchain.block.header` (parsed at byte offset 68 for the
   * unix-epoch timestamp), cached per-height for the duration of
   * this scan to keep the Electrum round-trip count down.
   */
  private async recordNewRewardEventsViaElectrs(
    client: ElectrsClient,
    unspents: Array<{ tx_hash: string; tx_pos: number; height: number; value: number }>,
    fallbackDetectedAt: number,
  ): Promise<number> {
    const db = this.options.db;
    if (!db) return 0;
    if (unspents.length === 0) return 0;

    // Unconfirmed outputs (height 0) don't have a block time yet.
    // Skip them this scan; we'll pick them up next time once they
    // confirm. Reward events are inherently ledger entries, not
    // mempool blips.
    const confirmed = unspents.filter((u) => u.height > 0);
    if (confirmed.length === 0) return 0;

    const uniqueHeights = [...new Set(confirmed.map((u) => u.height))];
    const heightToTimeMs = new Map<number, number>();
    for (const h of uniqueHeights) {
      try {
        const t = await client.getBlockTimeByHeight(h);
        heightToTimeMs.set(h, t * 1000);
      } catch (err) {
        this.options.log?.(
          `[payout] electrs block-time lookup for #${h} failed: ${(err as Error).message}`,
        );
      }
    }

    // We need the chain tip to compute confirmations. Without
    // bitcoind handy, fall back to "max height + 1" - good enough
    // for the row's confirmations field; only used cosmetically.
    const tipHeight = Math.max(...uniqueHeights);

    const result = await db
      .insertInto('reward_events')
      .values(
        confirmed.map((u) => ({
          txid: u.tx_hash,
          vout: u.tx_pos,
          block_height: u.height,
          confirmations: Math.max(0, tipHeight - u.height + 1),
          value_sat: u.value,
          detected_at: heightToTimeMs.get(u.height) ?? fallbackDetectedAt,
        })),
      )
      .onConflict((oc) => oc.columns(['txid', 'vout']).doNothing())
      .executeTakeFirst();
    const inserted = Number(result.numInsertedOrUpdatedRows ?? 0);
    if (inserted > 0) {
      this.options.log?.(
        `[payout] recorded ${inserted} new reward_event row(s) via electrs (${confirmed.length} confirmed unspents at the payout address)`,
      );
    }
    return inserted;
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
    // Record any newly-seen UTXOs into reward_events so the chart's
    // paid_total_sat series picks up the payment. Best-effort: a DB
    // hiccup must not block the snapshot update above.
    if (this.options.db) {
      try {
        const inserted = await this.recordNewRewardEvents(result, now());
        if (inserted > 0 && this.options.onRewardsChanged) {
          await this.options.onRewardsChanged().catch((err) =>
            this.options.log?.(
              `[payout] onRewardsChanged failed: ${(err as Error).message}`,
            ),
          );
        }
      } catch (err) {
        this.options.log?.(`[payout] reward_events write failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Insert one row per UTXO not already in `reward_events`.
   *
   * Originally we filtered on `u.coinbase === true` so only pool
   * payout outputs landed in the table. That filter turned out to be
   * a bug: bitcoind's `scantxoutset` does not reliably populate the
   * `coinbase` field across versions, so the strict `=== true` check
   * silently rejected every UTXO on setups where the field was
   * missing or false-by-default - leaving reward_events empty even
   * when the panel showed a non-zero unspent total. Operator hit
   * exactly this on May 8 2026 (build 276 had the half-fix that
   * surfaced the issue: rows still empty, chart still flat zero).
   *
   * Net effect of dropping the filter: any UTXO at the payout
   * address counts as a reward event. For Ocean (TIDES pays via
   * coinbase) this is essentially always correct. The edge case is
   * an operator self-sending to their own payout address, which is
   * unusual and worth surfacing on the chart anyway.
   *
   * `detected_at` is set to the BLOCK TIME (when the payout actually
   * landed on-chain), not when our scan happened to notice it. This
   * matters when a daemon backfills reward_events on first run after
   * weeks of empty state - using now() would stamp every historical
   * payout as "today", and the chart's paid_total_sat series would
   * show one cliff today instead of the actual payment timeline. The
   * caller's `fallbackDetectedAt` is used only when the block-time
   * lookup fails (RPC error, orphaned block, etc.).
   *
   * Returns the number of rows inserted, so the caller can decide
   * whether to kick off the cumulative-paid_total_sat backfill.
   */
  private async recordNewRewardEvents(
    result: ScanTxoutSetResult,
    fallbackDetectedAt: number,
  ): Promise<number> {
    const db = this.options.db;
    if (!db) return 0;
    const candidateOuts = result.unspents;
    if (candidateOuts.length === 0) return 0;

    // Look up actual block timestamps (in ms since epoch) for each
    // unique block_height we're about to insert. Two batched RPC
    // round-trips: getblockhash by height, then getblockheader by
    // hash. Failure is non-fatal - rows with no mapping fall back to
    // fallbackDetectedAt.
    const uniqueHeights = [...new Set(candidateOuts.map((u) => u.height))];
    const heightToTimeMs = new Map<number, number>();
    try {
      const hashes = await this.options.client.batch<string>(
        uniqueHeights.map((h) => ({ method: 'getblockhash', params: [h] })),
      );
      const headers = await this.options.client.batch<{ time: number }>(
        hashes.map((h) => ({ method: 'getblockheader', params: [h, true] })),
      );
      for (let i = 0; i < uniqueHeights.length; i++) {
        const h = uniqueHeights[i];
        const t = headers[i]?.time;
        if (h !== undefined && typeof t === 'number') {
          heightToTimeMs.set(h, t * 1000);
        }
      }
    } catch (err) {
      this.options.log?.(
        `[payout] block-time lookup failed; reward_events will fall back to now() for detected_at: ${(err as Error).message}`,
      );
    }

    // Insert with ON CONFLICT DO NOTHING - migration 0072 promotes
    // (txid, vout) to a UNIQUE index, so the database enforces
    // dedup at write time. No more SELECT-then-filter scan of the
    // whole table per scan, and no race window between SELECT and
    // INSERT if two scans overlap.
    const result_ = await db
      .insertInto('reward_events')
      .values(
        candidateOuts.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          block_height: u.height,
          confirmations: Math.max(0, result.height - u.height + 1),
          value_sat: Math.round(u.amount * SAT_PER_BTC),
          detected_at: heightToTimeMs.get(u.height) ?? fallbackDetectedAt,
        })),
      )
      .onConflict((oc) => oc.columns(['txid', 'vout']).doNothing())
      .executeTakeFirst();
    const inserted = Number(result_.numInsertedOrUpdatedRows ?? 0);
    if (inserted > 0) {
      this.options.log?.(
        `[payout] recorded ${inserted} new reward_event row(s) (scantxoutset returned ${candidateOuts.length} unspents at the payout address)`,
      );
    }
    return inserted;
  }

  start(): void {
    if (this.timer) return;
    const useElectrs = !!(this.options.electrsHost && this.options.electrsPort);
    const defaultInterval = useElectrs ? ELECTRS_INTERVAL_MS : BITCOIND_INTERVAL_MS;
    const interval = this.options.scanIntervalMs ?? defaultInterval;
    setTimeout(() => void this.scanOnce(), 5_000);
    this.timer = setInterval(() => void this.scanOnce(), interval);

    // When electrs is the primary balance source, the snapshot path
    // never touches reward_events - electrs's listunspent doesn't
    // expose a coinbase flag, so we can't tell which UTXOs are pool
    // payouts vs unrelated receipts. The fast-path electrs scan
    // keeps the panel snappy; this side-channel hourly bitcoind
    // scantxoutset writes the per-row reward_events ledger that
    // powers the chart's paid_total_sat series. Without it, electrs
    // setups had a flat-zero "paid earnings (lifetime)" line on the
    // Price chart even with real payouts visible in P&L (incident
    // 2026-05-08).
    if (useElectrs && this.options.db) {
      setTimeout(() => void this.scanRewardsViaBitcoind(), 30_000);
      this.rewardsTimer = setInterval(
        () => void this.scanRewardsViaBitcoind(),
        BITCOIND_INTERVAL_MS,
      );
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rewardsTimer) clearInterval(this.rewardsTimer);
    this.rewardsTimer = null;
  }

  /**
   * Bitcoind-only side scan that ONLY refreshes reward_events. Used
   * when electrs is the primary balance source - electrs's
   * listunspent doesn't expose `coinbase`, so we still need bitcoind
   * to identify which UTXOs are pool payouts vs unrelated receipts
   * for the per-row reward_events ledger.
   */
  private async scanRewardsViaBitcoind(): Promise<void> {
    const address = this.options.getAddress();
    const now = this.options.now ?? Date.now;
    try {
      const descriptor = `addr(${address})`;
      const result: ScanTxoutSetResult = await this.options.client.scanTxoutSet([descriptor]);
      const inserted = await this.recordNewRewardEvents(result, now());
      if (inserted > 0 && this.options.onRewardsChanged) {
        await this.options.onRewardsChanged().catch((err) =>
          this.options.log?.(
            `[payout] onRewardsChanged failed: ${(err as Error).message}`,
          ),
        );
      }
    } catch (err) {
      this.options.log?.(
        `[payout] rewards-only bitcoind scan failed: ${(err as Error).message}`,
      );
    }
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
