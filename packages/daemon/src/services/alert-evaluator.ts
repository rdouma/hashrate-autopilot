/**
 * Per-tick alert evaluator (#100).
 *
 * Inspects the controller's `State` snapshot on every tick and decides
 * which of the 9 event classes have just transitioned into / out of
 * a bad state. On transitions it calls into AlertManager.recordAlert
 * (or pairs a recovery row); steady-state ticks short-circuit.
 *
 * State-tracking lives in instance fields, hydrated from the alerts
 * table on boot via `hydrate()`. The hydrate query looks up the most
 * recent "open" alert per event class (open = no recovery row pairs
 * back to it) and inherits its id as the active_alert_id. Without
 * this, restarting the daemon while a bad state was still active
 * fired a duplicate Telegram alert - even if the operator had already
 * acknowledged the prior one - because the in-memory map was empty
 * and the next tick saw "transition into bad state" from scratch.
 * This was a real complaint from the operator during #100 testing.
 *
 * Detectors wired end-to-end:
 *   - datum_unreachable     LOUD - the 2026-05-06 motivating incident
 *   - hashrate_below_floor  LOUD
 *   - zero_hashrate         LOUD
 *   - api_unreachable       LOUD - Braiins /v1/* down for N minutes
 *   - unknown_bid           LOUD - bid in account that we didn't create
 *   - sustained_paused      LOUD - primary bid stays Paused across the
 *                                  Paused/Active oscillation hazard
 *   - beta_exit             WARN - Braiins fee_rate turned non-zero
 *
 * Two detectors are stubbed for a small follow-up commit because they
 * need data the evaluator doesn't currently see:
 *   - wallet_runway   needs (balance, daily-burn) - daily-burn comes
 *                     from accountSpend or tick_metrics deltas
 *   - low_acceptance  needs an acceptance-ratio time series; not yet
 *                     captured in tick_metrics
 */

import type { AlertManager } from './alert-manager.js';
import type { AlertsRepo } from '../state/repos/alerts.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import type { State } from '../controller/types.js';

const HOURS_3_MS = 3 * 60 * 60 * 1000;
// Ocean's on-chain payout threshold per the TIDES + payouts mechanic.
// Earnings accumulate at the pool until they cross 2^20 sat (=
// 1,048,576 sat = 0.01048576 BTC); the next pool block then settles
// the operator on-chain. Hard-coded constant - Ocean publishes this
// in their docs and it hasn't changed.
const OCEAN_PAYOUT_THRESHOLD_SAT = 1_048_576;
// nearest-tick lookup tolerance for share_log_pct: a block's
// share_log is read from the closest tick within this window. 30 min
// is generous enough for Ocean's 5-min share cadence + occasional
// daemon restarts to still resolve, narrow enough to prefer a recent
// tick over a stale one.
const SHARE_LOG_AT_BLOCK_TOLERANCE_MS = 30 * 60 * 1000;

interface EventState {
  readonly bad_since_ms: number | null;
  /** id of the currently-open alert row, set on the first ping. */
  readonly active_alert_id: number | null;
}

const INITIAL: EventState = { bad_since_ms: null, active_alert_id: null };

export interface AlertEvaluatorOptions {
  readonly alertManager: AlertManager;
  /**
   * Optional. When provided, the wallet_runway detector queries it
   * for the trailing-3h actual-spend total to compute runway days,
   * and the pool_block_credited detector uses
   * `nearestShareLogPct(blockTime)` to estimate our share at the
   * block's moment. Without it both detectors short-circuit safely.
   */
  readonly tickMetricsRepo?: TickMetricsRepo;
  /**
   * Optional. Drives the #117 pool-block-credited celebration: the
   * evaluator hydrates a `lastNotifiedBlockHeight` watermark from
   * `maxHeight()` at boot so the boot-time backfill doesn't fire a
   * Telegram message for every historical block, then fires once
   * per new row above the watermark.
   */
  readonly poolBlocksRepo?: PoolBlocksRepo;
  /** Override clock for tests. */
  readonly now?: () => number;
}

export class AlertEvaluator {
  private datum_unreachable: EventState = INITIAL;
  private hashrate_below_floor: EventState = INITIAL;
  private zero_hashrate: EventState = INITIAL;
  private api_unreachable: EventState = INITIAL;
  private unknown_bid: EventState = INITIAL;
  private sustained_paused: EventState = INITIAL;
  private beta_exit: EventState = INITIAL;
  private wallet_runway: EventState = INITIAL;
  /**
   * #117: highest pool-block height we've already considered for
   * the celebratory Telegram. Hydrated at boot from
   * `poolBlocksRepo.maxHeight()` so the boot-time backfill of
   * historical blocks doesn't fire a flood of "you got paid"
   * messages for past credits. Updated as we walk new rows.
   */
  private lastNotifiedBlockHeight: number | null = null;

  private readonly alertManager: AlertManager;
  private readonly tickMetricsRepo: TickMetricsRepo | null;
  private readonly poolBlocksRepo: PoolBlocksRepo | null;
  private readonly now: () => number;

  constructor(opts: AlertEvaluatorOptions) {
    this.alertManager = opts.alertManager;
    this.tickMetricsRepo = opts.tickMetricsRepo ?? null;
    this.poolBlocksRepo = opts.poolBlocksRepo ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Rebuild the in-memory event-state map from the alerts table on
   * boot. Without this, restarting the daemon while a bad state is
   * still active fires a fresh Telegram alert - even if the operator
   * already acknowledged the previous one, because the in-memory
   * map is empty and the next tick reads "transition into bad
   * state" from scratch.
   *
   * Hydration looks up the most recent "open" alert per event class
   * (open = no later alert row pairs back to it via paired_alert_id)
   * and inherits its id as the active_alert_id, with `bad_since_ms`
   * set to the alert's `created_at`. Subsequent ticks observing
   * isBad=true are now in the "already armed and fired" branch,
   * which short-circuits without recording a new row.
   */
  async hydrate(alertsRepo: AlertsRepo): Promise<void> {
    const classes: Array<[string, (s: EventState) => void]> = [
      ['datum_unreachable', (s) => { this.datum_unreachable = s; }],
      ['hashrate_below_floor', (s) => { this.hashrate_below_floor = s; }],
      ['zero_hashrate', (s) => { this.zero_hashrate = s; }],
      ['api_unreachable', (s) => { this.api_unreachable = s; }],
      ['unknown_bid', (s) => { this.unknown_bid = s; }],
      ['sustained_paused', (s) => { this.sustained_paused = s; }],
      ['beta_exit', (s) => { this.beta_exit = s; }],
      ['wallet_runway', (s) => { this.wallet_runway = s; }],
    ];
    for (const [cls, setter] of classes) {
      const open = await alertsRepo.findOpenAlert(cls);
      if (open) {
        setter({ bad_since_ms: open.created_at, active_alert_id: open.id });
      }
    }
    // #117: silently baseline the pool-block watermark from whatever
    // is currently in the table. Anything below this height is
    // treated as already-known and won't fire a celebration. New
    // rows from the per-tick Ocean poll will exceed this and fire.
    if (this.poolBlocksRepo) {
      this.lastNotifiedBlockHeight = await this.poolBlocksRepo
        .maxHeight()
        .catch(() => null);
    }
  }

  /**
   * Per-tick evaluation. Call once per tick after the controller has
   * produced its TickResult. Order: detectors fire in declaration order;
   * each detector's transition logic is independent.
   */
  async evaluate(state: State): Promise<void> {
    const disabled = new Set(state.config.notification_disabled_event_classes);
    await this.evaluateDatumUnreachable(state, disabled);
    await this.evaluateBelowFloor(state, disabled);
    await this.evaluateZeroHashrate(state, disabled);
    await this.evaluateApiUnreachable(state, disabled);
    await this.evaluateUnknownBid(state, disabled);
    await this.evaluateSustainedPaused(state, disabled);
    await this.evaluateBetaExit(state, disabled);
    await this.evaluateWalletRunway(state, disabled);
    await this.evaluatePoolBlockCredited(state, disabled);
    // TODO(#100): low_acceptance still needs an acceptance-ratio series
    //   in tick_metrics. Scoped for a separate commit.
  }

  private async evaluateDatumUnreachable(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // Skip when Datum integration isn't configured at all.
    if (state.datum === null) {
      this.datum_unreachable = INITIAL;
      return;
    }
    const isBad = !state.datum.reachable;
    const thresholdMs =
      state.config.pool_outage_blip_tolerance_seconds * 5 * 1000;
    this.datum_unreachable = await this.runTransition({
      event_class: 'datum_unreachable',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.datum_unreachable,
      disabledClasses,
      title: 'Datum stratum unreachable',
      bodyForFiring: (durMs) =>
        `Datum gateway has been unreachable for ${formatDuration(durMs)}. Buyer-side hashrate cannot reach Ocean - shares are not crediting.`,
      bodyForRecovery: (durMs) =>
        `Datum gateway reachable again - was down ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateBelowFloor(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    const isBad = state.below_floor_since !== null;
    const thresholdMs = state.config.below_floor_alert_after_minutes * 60_000;
    this.hashrate_below_floor = await this.runTransition({
      event_class: 'hashrate_below_floor',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.hashrate_below_floor,
      disabledClasses,
      title: 'Hashrate below floor',
      bodyForFiring: (durMs) =>
        `Delivered hashrate has been below the configured floor for ${formatDuration(durMs)}. Current: ${state.actual_hashrate.total_ph.toFixed(2)} PH/s; floor: ${state.config.minimum_floor_hashrate_ph.toFixed(2)} PH/s.`,
      bodyForRecovery: (durMs) =>
        `Hashrate back at or above floor - was below for ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateZeroHashrate(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    const isBad = state.actual_hashrate.total_ph < 0.001;
    const thresholdMs =
      state.config.zero_hashrate_loud_alert_after_minutes * 60_000;
    this.zero_hashrate = await this.runTransition({
      event_class: 'zero_hashrate',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.zero_hashrate,
      disabledClasses,
      title: 'Zero hashrate',
      bodyForFiring: (durMs) =>
        `No hashrate delivered for ${formatDuration(durMs)}. Likely the upstream marketplace stopped routing - check the active bid and fee state.`,
      bodyForRecovery: (durMs) =>
        `Hashrate flowing again - was zero for ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateApiUnreachable(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // state.market is null when the Braiins API failed this tick.
    const isBad = state.market === null;
    const thresholdMs = state.config.api_outage_alert_after_minutes * 60_000;
    this.api_unreachable = await this.runTransition({
      event_class: 'api_unreachable',
      severity: 'LOUD',
      isBad,
      thresholdMs,
      currentState: this.api_unreachable,
      disabledClasses,
      title: 'Braiins API unreachable',
      bodyForFiring: (durMs) =>
        `The Braiins marketplace API has been unreachable for ${formatDuration(durMs)}. The autopilot cannot read orderbook / balance / fee data and is making no decisions until it recovers.`,
      bodyForRecovery: (durMs) =>
        `Braiins API reachable again - was down ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateUnknownBid(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // No threshold: an unknown bid is a "PAUSE NOW" condition per
    // SPEC §9, so the alert fires on the first tick we see one.
    const isBad = state.unknown_bids.length > 0;
    this.unknown_bid = await this.runTransition({
      event_class: 'unknown_bid',
      severity: 'LOUD',
      isBad,
      thresholdMs: 0,
      currentState: this.unknown_bid,
      disabledClasses,
      title: 'Unknown bid detected',
      bodyForFiring: () => {
        const ids = state.unknown_bids.map((b) => b.braiins_order_id).join(', ');
        return `${state.unknown_bids.length} bid(s) in the Braiins account that the autopilot did not create: ${ids}. Daemon auto-paused per the unknown-order rule. Inspect via the Braiins dashboard before resuming LIVE.`;
      },
      bodyForRecovery: () =>
        `Account is clean again - no unknown bids visible. Re-enable LIVE on the dashboard when ready.`,
    });
  }

  private async evaluateSustainedPaused(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // Primary owned bid (first non-fulfilled) carries the
    // last_pause_reason flag. We treat "any non-null pause reason"
    // as the bad signal; the threshold is the operator's choice of
    // how long to wait before declaring it sustained. Reuse the
    // pool-outage tolerance as a sensible default proxy.
    const primary = state.owned_bids.find((b) => b.status !== 'CL_ORDER_STATE_FULFILLED');
    const isBad = primary?.last_pause_reason != null && primary.last_pause_reason !== '';
    const thresholdMs =
      state.config.pool_outage_blip_tolerance_seconds * 5 * 1000;
    this.sustained_paused = await this.runTransition({
      event_class: 'sustained_paused',
      severity: 'LOUD',
      isBad: isBad ?? false,
      thresholdMs,
      currentState: this.sustained_paused,
      disabledClasses,
      title: 'Bid sustained-paused by Braiins',
      bodyForFiring: (durMs) =>
        `Primary owned bid has been Paused by Braiins for ${formatDuration(durMs)} (last_pause_reason: ${primary?.last_pause_reason ?? 'unknown'}). Likely the Paused/Active oscillation hazard - check the destination pool / Datum gateway and consider a manual edit.`,
      bodyForRecovery: (durMs) =>
        `Primary bid no longer flagged Paused - was paused for ${formatDuration(durMs)}.`,
    });
  }

  private async evaluateBetaExit(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // Beta-exit signal: Braiins applies a non-zero fee_rate to bids
    // when the marketplace exits beta. Detectable per-bid via
    // owned_bids[].fee_rate_pct. Fires immediately (no threshold) on
    // first observation of a non-zero rate on any active bid.
    const anyFeeBearing = state.owned_bids.some(
      (b) => b.fee_rate_pct !== null && b.fee_rate_pct > 0,
    );
    this.beta_exit = await this.runTransition({
      event_class: 'beta_exit',
      severity: 'WARN',
      isBad: anyFeeBearing,
      thresholdMs: 0,
      currentState: this.beta_exit,
      disabledClasses,
      title: 'Braiins beta-exit fees detected',
      bodyForFiring: () => {
        const sample = state.owned_bids.find((b) => (b.fee_rate_pct ?? 0) > 0);
        return `Braiins is now charging a non-zero fee on at least one active bid (fee_rate_pct: ${sample?.fee_rate_pct ?? 'unknown'}%). The marketplace appears to have exited beta - re-evaluate the cost model and consider the documented beta-exit handling steps.`;
      },
      bodyForRecovery: () =>
        `Active bids are back to fee_rate_pct = 0. Either Braiins reverted, or all fee-bearing bids settled.`,
    });
  }

  /**
   * #116: wallet runway. Fires LOUD when the operator's available
   * Braiins balance, divided by the trailing-3h actual-spend rate
   * (extrapolated to a per-day figure), drops below the configured
   * threshold.
   *
   * Disabled paths - none of these arm a timer or write a row:
   * - `wallet_runway_alert_days = 0` (operator's intent: off).
   * - tickMetricsRepo not injected.
   * - balance unavailable (Braiins API was down this tick).
   * - trailing-3h spend null or 0 (autopilot paused / DRY_RUN /
   *   nothing has been delivered yet, so runway is effectively
   *   infinite). The dashboard already renders "insufficient
   *   history" in this case; the alert mirrors that semantic.
   *
   * Threshold semantics use the same one-tick-debounce shape as
   * unknown_bid / beta_exit: thresholdMs = 0, fires on the first
   * tick where runway < threshold. Recovery fires when runway
   * crosses back above the same threshold.
   */
  private async evaluateWalletRunway(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    const thresholdDays = state.config.wallet_runway_alert_days;
    if (thresholdDays === 0 || !this.tickMetricsRepo) {
      this.wallet_runway = INITIAL;
      return;
    }
    const balanceSat =
      state.balance?.accounts?.[0]?.available_balance_sat ?? null;
    if (balanceSat === null) {
      // Braiins API down this tick - skip; the api_unreachable
      // detector covers the underlying failure already.
      return;
    }
    const sinceMs = this.now() - HOURS_3_MS;
    let spend3hSat: number | null = null;
    try {
      spend3hSat = await this.tickMetricsRepo.actualSpendSatSince(sinceMs);
    } catch {
      // Query failure: fall through; runway treated as unknown.
      spend3hSat = null;
    }
    if (spend3hSat === null || spend3hSat <= 0) {
      // No measurable burn -> runway is effectively infinite. No
      // transition (no firing, no recovery).
      return;
    }
    const burnPerDaySat = spend3hSat * 8; // 3h -> 24h
    const runwayDays = balanceSat / burnPerDaySat;
    const isBad = runwayDays < thresholdDays;

    this.wallet_runway = await this.runTransition({
      event_class: 'wallet_runway',
      severity: 'LOUD',
      isBad,
      thresholdMs: 0,
      currentState: this.wallet_runway,
      disabledClasses,
      title: `Wallet runway ${runwayDays.toFixed(1)} days (below ${thresholdDays.toFixed(1)} day threshold)`,
      bodyForFiring: () =>
        `Available Braiins balance is ${balanceSat.toLocaleString('en-US')} sat; trailing-3h burn is ${Math.round(burnPerDaySat).toLocaleString('en-US')} sat/day. At that rate the wallet hits zero in ${runwayDays.toFixed(1)} days, below the configured ${thresholdDays}-day threshold. Top up the Braiins wallet or lower the bid; without a top-up, bids will start cancelling for insufficient funds.`,
      bodyForRecovery: () =>
        `Wallet runway back above threshold: ${runwayDays.toFixed(1)} days (threshold ${thresholdDays}). Likely a top-up landed or the burn rate dropped.`,
    });
  }

  /**
   * #117: celebratory INFO message at every Ocean pool-block credit.
   * Fires at most once per unique block height. Silently ignores
   * blocks at or below the boot-time watermark - that's the
   * equivalent of the audible cue's silent-baseline pattern, so
   * upgrading a long-running install doesn't replay every
   * historical block as a notification.
   *
   * Disabled paths - all silent, no row written, no Telegram POST:
   * - `notify_on_pool_block_credit === false` (default).
   * - `pool_block_credited` in `notification_disabled_event_classes`
   *   (the per-class master mute, in case the operator wants both
   *   knobs and the per-class is unchecked).
   * - poolBlocksRepo not injected (tests, mostly).
   *
   * Severity = INFO. No retry ladder, no inline buttons - this is
   * a "good news, no action required" message; treating it as a
   * normal alert with retries would be obnoxious if Telegram
   * blipped during a block flurry.
   */
  private async evaluatePoolBlockCredited(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    if (!state.config.notify_on_pool_block_credit) return;
    if (disabledClasses.has('pool_block_credited')) return;
    const repo = this.poolBlocksRepo;
    if (!repo) return;
    // First evaluator pass after a fresh boot where hydrate() didn't
    // run for any reason: baseline silently from the current max
    // before processing. Same intent as hydrate's call - the
    // explicit-baseline guard means a never-hydrated evaluator
    // can't accidentally flood on its first tick.
    if (this.lastNotifiedBlockHeight === null) {
      this.lastNotifiedBlockHeight = await repo.maxHeight().catch(() => null);
      if (this.lastNotifiedBlockHeight === null) {
        // Table genuinely empty - mark with -1 so the first ever
        // block we see fires.
        this.lastNotifiedBlockHeight = -1;
      }
      return;
    }
    const newBlocks = await repo
      .sinceHeight(this.lastNotifiedBlockHeight)
      .catch(() => [] as Awaited<ReturnType<typeof repo.sinceHeight>>);
    if (newBlocks.length === 0) return;

    const unpaidSat = state.ocean_unpaid_sat;
    for (const blk of newBlocks) {
      const sharePct = this.tickMetricsRepo
        ? await this.tickMetricsRepo
            .nearestShareLogPct(blk.timestamp_ms, SHARE_LOG_AT_BLOCK_TOLERANCE_MS)
            .catch(() => null)
        : null;
      const ourCreditSat =
        sharePct !== null && sharePct > 0
          ? Math.round((blk.total_reward_sat * sharePct) / 100)
          : null;
      const heightStr = blk.height.toLocaleString('en-US');
      const rewardBtc = (blk.total_reward_sat / 1e8).toFixed(8);
      const sharePctStr = sharePct !== null ? `${sharePct.toFixed(4)}%` : 'unknown';
      const creditStr =
        ourCreditSat !== null ? `~${ourCreditSat.toLocaleString('en-US')} sat` : 'unknown (no nearby tick captured share_log)';
      const unpaidStr =
        unpaidSat !== null
          ? `${unpaidSat.toLocaleString('en-US')} sat (${((unpaidSat / OCEAN_PAYOUT_THRESHOLD_SAT) * 100).toFixed(1)}% of ${OCEAN_PAYOUT_THRESHOLD_SAT.toLocaleString('en-US')}-sat payout)`
          : 'unknown';
      await this.alertManager.recordAlert({
        severity: 'INFO',
        title: `Pool block credited - #${heightStr}`,
        body: `Ocean found pool block #${heightStr} (reward ${rewardBtc} BTC). Your share: ${sharePctStr} -> ${creditStr}. Unpaid total: ${unpaidStr}.`,
        event_class: 'pool_block_credited',
      });
      this.lastNotifiedBlockHeight = blk.height;
    }
  }

  // ---------------------------------------------------------------
  // Shared transition machinery
  // ---------------------------------------------------------------

  private async runTransition(args: {
    event_class: string;
    severity: 'LOUD' | 'WARN' | 'INFO';
    isBad: boolean;
    thresholdMs: number;
    currentState: EventState;
    title: string;
    bodyForFiring: (durMs: number) => string;
    bodyForRecovery: (durMs: number) => string;
    disabledClasses: ReadonlySet<string>;
  }): Promise<EventState> {
    // #106: per-event-class opt-out. Skip everything for disabled
    // classes - no alert row, no timer arming, no recovery message.
    // Re-enabling mid-outage starts a fresh "bad since now".
    if (args.disabledClasses.has(args.event_class)) {
      return INITIAL;
    }
    const nowMs = this.now();

    if (args.isBad) {
      // Arm the timer on first observation, OR fire immediately if
      // threshold is 0 (event classes like unknown_bid + beta_exit
      // that have no debounce - they're "PAUSE NOW" conditions).
      const armedSince =
        args.currentState.bad_since_ms === null ? nowMs : args.currentState.bad_since_ms;
      if (
        args.currentState.active_alert_id === null &&
        nowMs - armedSince >= args.thresholdMs
      ) {
        const id = await this.alertManager.recordAlert({
          severity: args.severity,
          title: args.title,
          body: args.bodyForFiring(nowMs - armedSince),
          event_class: args.event_class,
        });
        return { bad_since_ms: armedSince, active_alert_id: id };
      }
      // Below threshold but armed - keep counting.
      return { bad_since_ms: armedSince, active_alert_id: args.currentState.active_alert_id };
    }

    // Not bad. If we had armed but never fired, just clear.
    if (args.currentState.active_alert_id === null) {
      return INITIAL;
    }

    // Recovery: pair an INFO row to the previously-fired alert.
    const wasBadFor = nowMs - (args.currentState.bad_since_ms ?? nowMs);
    await this.alertManager.recordAlert({
      severity: 'INFO',
      title: args.title.replace(/^/, '✓ ').replace('Datum stratum unreachable', 'Datum reachable'),
      body: args.bodyForRecovery(wasBadFor),
      event_class: args.event_class + '_recovery',
      paired_alert_id: args.currentState.active_alert_id,
    });
    return INITIAL;
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}
