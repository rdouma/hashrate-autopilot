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

import type { BitcoindClient, ScanTxoutSetResult } from '@hashrate-autopilot/bitcoind-client';
import type { Kysely } from 'kysely';

import type { Database } from '../state/types.js';
import {
  addressToScriptPubKeyHex,
  createElectrsClient,
  type ElectrsClient,
} from './electrs-client.js';

const ELECTRS_INTERVAL_MS = 60 * 1000;
const BITCOIND_INTERVAL_MS = 60 * 60 * 1000;
// #170: historical-coinbase backfill runs at startup and then on
// this slow cadence afterwards. Six hours is well below the typical
// payout interval at any realistic hashrate level, so we always
// catch newly-swept coinbase txs that listunspent stopped seeing.
const HISTORICAL_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
  /**
   * Bitcoind RPC client. Optional - when null, the observer only
   * runs the electrs path (host + port required below). The
   * bitcoind-driven scantxoutset path + the bitcoind side-scan
   * for reward_events are skipped when client is null. This
   * matters for Umbrel installs that haven't declared bitcoind as
   * a dependency: on those setups bitcoindClient is null but
   * electrs is still reachable, so the observer should still run.
   */
  readonly client: BitcoindClient | null;
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
  /**
   * #170: live-read accessor for the `include_historical_payouts`
   * config flag. When `true`, the observer's auto-backfill loop walks
   * the full address history via electrs's `get_history` and folds
   * every coinbase tx it finds into `reward_events` - even those
   * whose outputs have been swept off-address. When `false`, only the
   * `listUnspent`-based pre-#170 behaviour runs. The manual
   * "Backfill now" button (HTTP route) ignores this flag and always
   * runs - it's an explicit operator action.
   */
  readonly getHistoricalEnabled?: () => boolean;
}

export interface HistoricalBackfillResult {
  /** Number of new reward_events rows the backfill inserted. */
  inserted: number;
  /**
   * Number of transactions whose vout set contains at least one
   * output paying the configured address (i.e. transactions that
   * could have contributed a reward event - past or current). Used
   * to be `coinbaseSeen` and gated by a strict `vin[0].coinbase`
   * check; #240 reframed this because Ocean's batched-sweep payout
   * model surfaces non-coinbase payments that the strict filter
   * silently dropped.
   */
  withMatchingOutputs: number;
  /** Number of transactions in the address history (all kinds). */
  txSeen: number;
  /** Wall-clock duration of the backfill in milliseconds. */
  durationMs: number;
  /** Non-fatal error message, when the backfill couldn't complete. Null otherwise. */
  error: string | null;
}

export class PayoutObserver {
  private lastSnapshot: PayoutSnapshot | null = null;
  private lastError: string | null = null;
  private running: Promise<void> | null = null;
  private backfillRunning: Promise<HistoricalBackfillResult> | null = null;
  private lastBackfill: HistoricalBackfillResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rewardsTimer: NodeJS.Timeout | null = null;
  private backfillTimer: NodeJS.Timeout | null = null;

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
        } else if (this.options.client) {
          await this.scanViaBitcoind(address, now, start);
        } else {
          // Neither path is wired - construction-time guard in
          // main.ts should have prevented this, but log defensively.
          this.options.log?.('[payout] scan skipped: no electrs and no bitcoind client');
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
    const client = this.options.client;
    if (!client) {
      throw new Error('scanViaBitcoind called with no bitcoind client - misconfiguration');
    }
    const descriptor = `addr(${address})`;
    const result: ScanTxoutSetResult = await client.scanTxoutSet([descriptor]);
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
    const client = this.options.client;
    try {
      if (!client) throw new Error('no bitcoind client for block-time lookup');
      const hashes = await client.batch<string>(
        uniqueHeights.map((h) => ({ method: 'getblockhash', params: [h] })),
      );
      const headers = await client.batch<{ time: number }>(
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

    // Defensive belt-and-braces: when both electrs AND bitcoind are
    // wired, the electrs path writes reward_events natively (v1.5.2)
    // AND a parallel hourly bitcoind scantxoutset side-scan does the
    // same. Both go through INSERT...ON CONFLICT DO NOTHING so the
    // second one is a no-op on rows the first already covered. Worth
    // keeping as a fallback in case electrs's listunspent ever
    // misbehaves. Skipped entirely on electrs-only (no bitcoind
    // client) or bitcoind-only (no electrs - the primary scan
    // already does this work) setups.
    if (useElectrs && this.options.db && this.options.client) {
      setTimeout(() => void this.scanRewardsViaBitcoind(), 30_000);
      this.rewardsTimer = setInterval(
        () => void this.scanRewardsViaBitcoind(),
        BITCOIND_INTERVAL_MS,
      );
    }

    // #170: historical-coinbase backfill on the electrs path. First
    // run shortly after boot (45 s, after the unspent-only scan has
    // populated the snapshot card and the typical pool-luck-recompute
    // chain has settled), then every HISTORICAL_BACKFILL_INTERVAL_MS.
    // No-op on bitcoind-only setups (electrs is the only path that
    // exposes get_history cheaply).
    if (useElectrs && this.options.db) {
      setTimeout(() => {
        if (this.options.getHistoricalEnabled?.() !== false) {
          void this.runHistoricalBackfill();
        }
      }, 45_000);
      this.backfillTimer = setInterval(() => {
        if (this.options.getHistoricalEnabled?.() !== false) {
          void this.runHistoricalBackfill();
        }
      }, HISTORICAL_BACKFILL_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rewardsTimer) clearInterval(this.rewardsTimer);
    this.rewardsTimer = null;
    if (this.backfillTimer) clearInterval(this.backfillTimer);
    this.backfillTimer = null;
    await this.running?.catch(() => {});
    await this.backfillRunning?.catch(() => {});
  }

  /**
   * #170 / #240: walk the full address history via electrs's
   * `get_history` and insert every previously-unseen output paying
   * the configured payout address into `reward_events`. Used by:
   *   - the periodic auto-loop (gated by `include_historical_payouts`)
   *   - the dashboard "Backfill now" button (ignores the gate; explicit
   *     operator action)
   *
   * #240 dropped the original coinbase-only filter. Empirical case
   * that surfaced the gap: Ocean payout to bc1qd4glstkn… on
   * 2026-05-25 (tx 784542e9…) arrived as a 170-output BATCHED SWEEP
   * from Ocean's pool wallet (P2SH 37dvwZZoT3D7RXpTCpN2yKzMmNs2i2Fd1n)
   * - not a coinbase transaction. The upstream P2SH wallet IS funded
   * by Ocean's coinbase outputs, but the payment to the operator's
   * address is one hop further. Strict `vin[0].coinbase` filtering
   * silently rejected the user's payout from both live and backfill
   * paths. New behavior: any output at the configured address counts
   * as a reward event. Edge cases (operator self-send, exchange
   * withdrawal, swap change) get folded into the count too - the
   * operator can correct via `historical_payouts_offset_sat`.
   *
   * The output match is on scriptPubKey hex - we compute the
   * expected hex from the configured address once and compare
   * byte-for-byte against each vout, which is invariant to each
   * electrs build's choice of `vout.scriptPubKey.address` vs
   * `addresses` vs nothing-at-all.
   *
   * Idempotent: the `(txid, vout)` UNIQUE index on `reward_events`
   * (migration 0072) means re-runs are cheap - INSERT ... ON CONFLICT
   * DO NOTHING drops duplicates at write time.
   *
   * Returns counts so the HTTP route and operator log can report
   * "scanned N txs, M matching, inserted K".
   */
  async runHistoricalBackfill(): Promise<HistoricalBackfillResult> {
    if (this.backfillRunning) {
      return this.backfillRunning;
    }
    const promise = this._runHistoricalBackfill();
    this.backfillRunning = promise;
    try {
      const result = await promise;
      this.lastBackfill = result;
      return result;
    } finally {
      this.backfillRunning = null;
    }
  }

  private async _runHistoricalBackfill(): Promise<HistoricalBackfillResult> {
    const now = this.options.now ?? Date.now;
    const start = now();
    const baseResult: Omit<HistoricalBackfillResult, 'durationMs' | 'error'> = {
      inserted: 0,
      withMatchingOutputs: 0,
      txSeen: 0,
    };

    if (!this.options.db) {
      return { ...baseResult, durationMs: now() - start, error: 'no database wired' };
    }
    if (!this.options.electrsHost || !this.options.electrsPort) {
      return {
        ...baseResult,
        durationMs: now() - start,
        error: 'electrs not configured (historical backfill requires electrs)',
      };
    }

    const address = this.options.getAddress();
    let scriptPubKeyHex: string;
    try {
      scriptPubKeyHex = addressToScriptPubKeyHex(address);
    } catch (err) {
      return { ...baseResult, durationMs: now() - start, error: (err as Error).message };
    }

    let client: ElectrsClient | null = null;
    try {
      client = await createElectrsClient({
        host: this.options.electrsHost,
        port: this.options.electrsPort,
        // Backfill walks the entire address history one tx at a time;
        // bump the per-call timeout so a slow electrs run doesn't kill
        // the loop midway. The default 10 s is calibrated for snappy
        // single-shot balance lookups, not bulk enumeration.
        timeoutMs: 30_000,
      });
      const history = await client.getHistory(address);
      const txSeen = history.length;
      if (txSeen === 0) {
        return { ...baseResult, durationMs: now() - start, error: null };
      }

      // Skip txs whose (txid, *) rows already exist - the chart only
      // cares whether SOME row from this tx has been recorded, and
      // re-fetching to discover a second vout to the same address is
      // vanishingly rare for Ocean payouts (which always credit to a
      // single output per address). This cuts the network-bound
      // `transaction.get` call count to ~zero on steady-state re-runs.
      const knownRows = await this.options.db
        .selectFrom('reward_events')
        .select('txid')
        .where(
          'txid',
          'in',
          history.map((h) => h.tx_hash),
        )
        .execute();
      const knownTxids = new Set(knownRows.map((r) => r.txid));

      const candidates = history.filter((h) => !knownTxids.has(h.tx_hash));
      this.options.log?.(
        `[payout] historical backfill: ${txSeen} txs at address, ${candidates.length} new to inspect`,
      );

      let withMatchingOutputs = 0;
      let inserted = 0;
      const heightToTimeMs = new Map<number, number>();

      for (const item of candidates) {
        // Mempool-only entries can't be classified yet - height <= 0.
        // Skip; the next scan picks them up after confirmation.
        if (item.height <= 0) continue;
        let tx;
        try {
          tx = await client.getTransaction(item.tx_hash);
        } catch (err) {
          this.options.log?.(
            `[payout] historical backfill: transaction.get(${item.tx_hash.slice(0, 12)}…) failed: ${(err as Error).message}`,
          );
          continue;
        }
        // #240: no longer gate on `vin[0].coinbase === string`. Ocean's
        // batched-sweep payouts are not coinbase but they ARE the
        // operator's pool payouts, and the strict filter silently
        // dropped them. Anything paying our address counts.
        const matchingVouts = tx.vout.filter(
          (v) => v.scriptPubKey?.hex?.toLowerCase() === scriptPubKeyHex.toLowerCase(),
        );
        if (matchingVouts.length === 0) continue;
        withMatchingOutputs += 1;

        // Resolve block time once per height (cache survives all txs
        // in the same block). Falls back to wall-clock if electrs
        // can't return the header - keeps the row valid, just stamps
        // it with the scan time instead of the on-chain time.
        let blockTimeMs = heightToTimeMs.get(item.height);
        if (blockTimeMs === undefined) {
          try {
            blockTimeMs = (await client.getBlockTimeByHeight(item.height)) * 1000;
            heightToTimeMs.set(item.height, blockTimeMs);
          } catch (err) {
            this.options.log?.(
              `[payout] historical backfill: block-time #${item.height} failed: ${(err as Error).message}`,
            );
            blockTimeMs = now();
          }
        }

        // Confirmations field is cosmetic for the chart. Compute it
        // from the highest height in the history scan as a rough tip
        // estimate (history is already sorted by height ascending in
        // practice; take max defensively).
        const tipHeight = Math.max(...history.map((h) => h.height), item.height);
        const confirmations = Math.max(0, tipHeight - item.height + 1);

        const writeResult = await this.options.db
          .insertInto('reward_events')
          .values(
            matchingVouts.map((v) => ({
              txid: tx.txid,
              vout: v.n,
              block_height: item.height,
              confirmations,
              value_sat: Math.round(v.value * SAT_PER_BTC),
              detected_at: blockTimeMs ?? now(),
            })),
          )
          .onConflict((oc) => oc.columns(['txid', 'vout']).doNothing())
          .executeTakeFirst();
        inserted += Number(writeResult.numInsertedOrUpdatedRows ?? 0);
      }

      if (inserted > 0 && this.options.onRewardsChanged) {
        await this.options.onRewardsChanged().catch((err) =>
          this.options.log?.(
            `[payout] onRewardsChanged (post-backfill) failed: ${(err as Error).message}`,
          ),
        );
      }

      this.options.log?.(
        `[payout] historical backfill done: ${txSeen} txs scanned, ${withMatchingOutputs} with matching outputs, ${inserted} new reward_events row(s) in ${now() - start}ms`,
      );
      return {
        inserted,
        withMatchingOutputs,
        txSeen,
        durationMs: now() - start,
        error: null,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.options.log?.(`[payout] historical backfill failed: ${msg}`);
      return { ...baseResult, durationMs: now() - start, error: msg };
    } finally {
      client?.close();
    }
  }

  getLastBackfill(): HistoricalBackfillResult | null {
    return this.lastBackfill;
  }

  /**
   * Bitcoind-only side scan that ONLY refreshes reward_events. Used
   * when electrs is the primary balance source - electrs's
   * listunspent doesn't expose `coinbase`, so we still need bitcoind
   * to identify which UTXOs are pool payouts vs unrelated receipts
   * for the per-row reward_events ledger.
   */
  private async scanRewardsViaBitcoind(): Promise<void> {
    const client = this.options.client;
    if (!client) return; // no bitcoind, side-scan is a no-op
    const address = this.options.getAddress();
    const now = this.options.now ?? Date.now;
    try {
      const descriptor = `addr(${address})`;
      const result: ScanTxoutSetResult = await client.scanTxoutSet([descriptor]);
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
   * #240 follow-up: drop the in-memory snapshot. After a payout-
   * address change we want the dashboard's "collected (on-chain)"
   * tile to render as 'computing' (spinner) until the next scan
   * lands - otherwise the operator sees the *old* address's total
   * for up to one poll interval after switching addresses, which
   * looks identical to "the address change didn't work".
   *
   * Pairs with calling `scanOnce()` straight after so the rescan
   * is queued behind the reset.
   */
  resetSnapshot(): void {
    this.lastSnapshot = null;
    this.lastError = null;
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
