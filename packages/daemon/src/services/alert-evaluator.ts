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
 *   - datum_unreachable     ERROR - the 2026-05-06 motivating incident
 *   - hashrate_below_floor  ERROR
 *   - zero_hashrate         ERROR
 *   - api_unreachable       ERROR - Braiins /v1/* down for N minutes
 *   - unknown_bid           ERROR - bid in account that we didn't create
 *   - sustained_paused      ERROR - primary bid stays Paused across the
 *                                   Paused/Active oscillation hazard
 *   - beta_exit             WARNING - Braiins fee_rate turned non-zero
 *   - wallet_runway         ERROR - balance / 3h-burn drops below threshold
 *   - pool_block_credited   INFO  - operator-celebratory TIDES credit notice
 *
 * One detector remains stubbed pending a data dependency:
 *   - low_acceptance  needs an acceptance-ratio time series; not yet
 *                     captured in tick_metrics. (wallet_runway shipped
 *                     in #116.)
 */

import type { AlertManager } from './alert-manager.js';
import type { AlertsRepo } from '../state/repos/alerts.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import type { State } from '../controller/types.js';
import { getAlertCopy } from '../i18n/alert-copy.js';

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

/**
 * #131: convenience to read the locale-aware alert copy from the
 * tick's State snapshot. Falls back to English when the operator
 * has not picked a locale or has set a value outside the supported
 * set.
 */
function copyFor(state: State): ReturnType<typeof getAlertCopy> {
  return getAlertCopy(state.config.notification_locale);
}

/**
 * Render a sat amount in the same "0.01000000 BTC (1,000,000 sat)"
 * shape the deposit watcher uses. Above 1 BTC the BTC value leads
 * for ergonomics; below it stays in sat for legibility on small
 * deposits.
 */
const SAT_PER_BTC = 100_000_000;
function formatSatAsBtc(sat: number): string {
  if (sat >= SAT_PER_BTC) {
    return `${(sat / SAT_PER_BTC).toFixed(8)} BTC (${sat.toLocaleString('en-US')} sat)`;
  }
  return `${sat.toLocaleString('en-US')} sat`;
}

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
  /**
   * Optional positive-success logger (#133). When set, the deposit
   * detector emits a one-line summary per tick so silence is
   * diagnosable on the daemon log. Other detectors don't need it -
   * they already log on transition via the alert manager.
   */
  readonly log?: (msg: string) => void;
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
  /**
   * #143: baseline for `state.braiins_total_deposited_sat`. Fires
   * `braiins_deposit_detected` whenever the live value exceeds the
   * baseline. Hydrated lazily from `tickMetricsRepo.latestBraiinsTotalDeposited()`
   * on the first tick so a daemon restart doesn't replay historical
   * deposits, while still catching deposits that landed during a
   * daemon-offline gap. `_available` lives in BraiinsDepositWatcherService
   * (on-chain endpoint poll); the two detectors share no state.
   */
  private lastNotifiedTotalDepositedSat: number | null = null;

  private readonly alertManager: AlertManager;
  private readonly tickMetricsRepo: TickMetricsRepo | null;
  private readonly poolBlocksRepo: PoolBlocksRepo | null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: AlertEvaluatorOptions) {
    this.alertManager = opts.alertManager;
    this.tickMetricsRepo = opts.tickMetricsRepo ?? null;
    this.poolBlocksRepo = opts.poolBlocksRepo ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
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
    await this.evaluateBraiinsDepositDetected(state, disabled);
    // _available + _returned live in BraiinsDepositWatcherService
    // (on-chain-endpoint poll). The endpoint only exposes already-
    // CREDITED deposits, so it can't see the pre-credited "first-seen"
    // state - that comes from the balance-delta detector above.
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
    // #135: dedicated alert threshold (was
    // pool_outage_blip_tolerance_seconds × 5).
    const thresholdMs = state.config.datum_unreachable_alert_after_minutes * 60_000;
    this.datum_unreachable = await this.runTransition({
      event_class: 'datum_unreachable',
      severity: 'IMPORTANT',
      isBad,
      thresholdMs,
      currentState: this.datum_unreachable,
      disabledClasses,
      title: copyFor(state).datum_unreachable_title(),
      titleForRecovery: copyFor(state).datum_unreachable_title_recovery(),
      bodyForFiring: (durMs) =>
        copyFor(state).datum_unreachable_body({ duration: formatDuration(durMs) }),
      bodyForRecovery: (durMs) =>
        copyFor(state).datum_unreachable_body_recovery({ duration: formatDuration(durMs) }),
    });
  }

  private async evaluateBelowFloor(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    const isBad = state.below_floor_since !== null;
    const thresholdMs = state.config.below_floor_alert_after_minutes * 60_000;
    this.hashrate_below_floor = await this.runTransition({
      event_class: 'hashrate_below_floor',
      severity: 'IMPORTANT',
      isBad,
      thresholdMs,
      currentState: this.hashrate_below_floor,
      disabledClasses,
      title: copyFor(state).hashrate_below_floor_title(),
      titleForRecovery: copyFor(state).hashrate_below_floor_title_recovery(),
      bodyForFiring: (durMs) =>
        copyFor(state).hashrate_below_floor_body({
          duration: formatDuration(durMs),
          actual_ph: state.actual_hashrate.total_ph.toFixed(2),
          floor_ph: state.config.minimum_floor_hashrate_ph.toFixed(2),
        }),
      bodyForRecovery: (durMs) =>
        copyFor(state).hashrate_below_floor_body_recovery({ duration: formatDuration(durMs) }),
    });
  }

  private async evaluateZeroHashrate(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    const isBad = state.actual_hashrate.total_ph < 0.001;
    const thresholdMs =
      state.config.zero_hashrate_loud_alert_after_minutes * 60_000;
    this.zero_hashrate = await this.runTransition({
      event_class: 'zero_hashrate',
      severity: 'IMPORTANT',
      isBad,
      thresholdMs,
      currentState: this.zero_hashrate,
      disabledClasses,
      title: copyFor(state).zero_hashrate_title(),
      titleForRecovery: copyFor(state).zero_hashrate_title_recovery(),
      bodyForFiring: (durMs) =>
        copyFor(state).zero_hashrate_body({ duration: formatDuration(durMs) }),
      bodyForRecovery: (durMs) =>
        copyFor(state).zero_hashrate_body_recovery({ duration: formatDuration(durMs) }),
    });
  }

  private async evaluateApiUnreachable(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // state.market is null when the Braiins API failed this tick.
    const isBad = state.market === null;
    const thresholdMs = state.config.api_outage_alert_after_minutes * 60_000;
    this.api_unreachable = await this.runTransition({
      event_class: 'api_unreachable',
      severity: 'IMPORTANT',
      isBad,
      thresholdMs,
      currentState: this.api_unreachable,
      disabledClasses,
      title: copyFor(state).api_unreachable_title(),
      titleForRecovery: copyFor(state).api_unreachable_title_recovery(),
      bodyForFiring: (durMs) =>
        copyFor(state).api_unreachable_body({ duration: formatDuration(durMs) }),
      bodyForRecovery: (durMs) =>
        copyFor(state).api_unreachable_body_recovery({ duration: formatDuration(durMs) }),
    });
  }

  private async evaluateUnknownBid(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // No threshold: an unknown bid is a "PAUSE NOW" condition per
    // SPEC §9, so the alert fires on the first tick we see one.
    const isBad = state.unknown_bids.length > 0;
    this.unknown_bid = await this.runTransition({
      event_class: 'unknown_bid',
      severity: 'IMPORTANT',
      isBad,
      thresholdMs: 0,
      currentState: this.unknown_bid,
      disabledClasses,
      title: copyFor(state).unknown_bid_title(),
      titleForRecovery: copyFor(state).unknown_bid_title_recovery(),
      bodyForFiring: () => {
        const ids = state.unknown_bids.map((b) => b.braiins_order_id).join(', ');
        return copyFor(state).unknown_bid_body({
          count: state.unknown_bids.length,
          ids,
        });
      },
      bodyForRecovery: () => copyFor(state).unknown_bid_body_recovery(),
    });
  }

  private async evaluateSustainedPaused(state: State, disabledClasses: ReadonlySet<string>): Promise<void> {
    // Primary owned bid: skip fulfilled bids (they're spent).
    // Bug 2026-05-09: the previous version read `last_pause_reason`
    // as the "currently paused" signal, but Braiins keeps that
    // field populated as a historical record even after the bid
    // returns to Active - so the detector saw isBad=true for the
    // entire 10-minute threshold window AFTER an unrelated prior
    // pause cleared, then fired at the threshold mark with a body
    // claiming "for 10m" while the bid was actually Active. Read
    // the live status enum instead. The pre-existing
    // CL_ORDER_STATE_FULFILLED predicate also never matched the
    // real BID_STATUS_FULFILLED enum values - innocuous (it just
    // meant the find returned the first bid unconditionally) but
    // tightened here too.
    const primary = state.owned_bids.find((b) => b.status !== 'BID_STATUS_FULFILLED');
    const isBad = primary?.status === 'BID_STATUS_PAUSED';
    // #135: dedicated alert threshold (was
    // pool_outage_blip_tolerance_seconds × 5).
    const thresholdMs = state.config.sustained_paused_alert_after_minutes * 60_000;
    this.sustained_paused = await this.runTransition({
      event_class: 'sustained_paused',
      severity: 'IMPORTANT',
      isBad: isBad ?? false,
      thresholdMs,
      currentState: this.sustained_paused,
      disabledClasses,
      title: copyFor(state).sustained_paused_title(),
      titleForRecovery: copyFor(state).sustained_paused_title_recovery(),
      bodyForFiring: (durMs) =>
        copyFor(state).sustained_paused_body({
          duration: formatDuration(durMs),
          reason: primary?.last_pause_reason ?? 'unknown',
        }),
      bodyForRecovery: (durMs) =>
        copyFor(state).sustained_paused_body_recovery({ duration: formatDuration(durMs) }),
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
      severity: 'WARNING',
      isBad: anyFeeBearing,
      thresholdMs: 0,
      currentState: this.beta_exit,
      disabledClasses,
      title: copyFor(state).beta_exit_title(),
      titleForRecovery: copyFor(state).beta_exit_title_recovery(),
      bodyForFiring: () => {
        const sample = state.owned_bids.find((b) => (b.fee_rate_pct ?? 0) > 0);
        return copyFor(state).beta_exit_body({
          fee_pct: String(sample?.fee_rate_pct ?? 'unknown'),
        });
      },
      bodyForRecovery: () => copyFor(state).beta_exit_body_recovery(),
    });
  }

  /**
   * #116: wallet runway. Fires IMPORTANT when the operator's available
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
    // Use total_balance_sat (= available + blocked) to match the
    // Status-page runway readout. available_balance_sat alone reads
    // 0 whenever every sat is committed to a live bid - which is the
    // steady state in a healthy autopilot - and would fire IMPORTANT
    // on every tick even with months of runway in the bid escrow.
    const balanceSat =
      state.balance?.accounts?.[0]?.total_balance_sat ?? null;
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
      severity: 'IMPORTANT',
      isBad,
      thresholdMs: 0,
      currentState: this.wallet_runway,
      disabledClasses,
      title: copyFor(state).wallet_runway_title({
        runway_days: runwayDays.toFixed(1),
        threshold_days: thresholdDays.toFixed(1),
      }),
      titleForRecovery: copyFor(state).wallet_runway_title_recovery({
        runway_days: runwayDays.toFixed(1),
        threshold_days: thresholdDays.toFixed(1),
      }),
      bodyForFiring: () =>
        copyFor(state).wallet_runway_body({
          balance_sat: balanceSat.toLocaleString('en-US'),
          burn_per_day_sat: Math.round(burnPerDaySat).toLocaleString('en-US'),
          runway_days: runwayDays.toFixed(1),
          threshold_days: thresholdDays,
        }),
      bodyForRecovery: () =>
        copyFor(state).wallet_runway_body_recovery({
          runway_days: runwayDays.toFixed(1),
          threshold_days: thresholdDays,
        }),
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
        title: copyFor(state).pool_block_credited_title({ height: heightStr }),
        body: copyFor(state).pool_block_credited_body({
          height: heightStr,
          reward_btc: rewardBtc,
          share_pct: sharePctStr,
          credit: creditStr,
          unpaid: unpaidStr,
        }),
        event_class: 'pool_block_credited',
      });
      this.lastNotifiedBlockHeight = blk.height;
    }
  }

  /**
   * #143: per-tick `_detected` detector via `state.braiins_total_deposited_sat`
   * deltas. The Braiins API field ticks up as soon as Braiins observes
   * the on-chain deposit (typically mempool / first-confirmation),
   * 6-12 min before the deposit is `DEPOSIT_STATUS_CREDITED` and shows
   * up in the on-chain-endpoint feed that `BraiinsDepositWatcherService`
   * polls. So this detector is the only signal source for the
   * pre-credited "first-seen" moment.
   *
   * Disabled paths - all silent, no row, no Telegram:
   *   - `notify_on_braiins_deposit === false` (master toggle).
   *   - `braiins_deposit_detected` in `notification_disabled_event_classes`.
   *   - `state.braiins_total_deposited_sat` is null (Braiins API
   *     unreachable this tick).
   *   - First post-boot tick: silently baseline from the latest
   *     persisted tick_metrics row.
   *
   * Severity = INFO. Deposits are good news, no retry ladder.
   *
   * Decreasing balance is logged (forensic visibility) but does not
   * fire. Withdrawals aren't currently a Braiins-supported feature,
   * so a drop is unusual; if it happens we just rebaseline so the
   * next real increment fires correctly.
   */
  private async evaluateBraiinsDepositDetected(
    state: State,
    disabledClasses: ReadonlySet<string>,
  ): Promise<void> {
    const total = state.braiins_total_deposited_sat;
    if (total == null) {
      this.log('[deposits] tick: balance=null (Braiins API unavailable); skipping detected');
      return;
    }
    const muted = !state.config.notify_on_braiins_deposit;
    const classDisabled = disabledClasses.has('braiins_deposit_detected');

    if (this.lastNotifiedTotalDepositedSat === null) {
      const persisted = this.tickMetricsRepo
        ? await this.tickMetricsRepo
            .latestBraiinsTotalDeposited()
            .catch(() => null)
        : null;
      this.lastNotifiedTotalDepositedSat = persisted ?? total;
      this.log(
        `[deposits] tick: baseline=${this.lastNotifiedTotalDepositedSat.toLocaleString('en-US')} sat (${persisted === null ? 'fresh install' : 'from tick_metrics'}); current=${total.toLocaleString('en-US')}`,
      );
      return;
    }

    const baseline = this.lastNotifiedTotalDepositedSat;
    if (total === baseline) {
      this.log(`[deposits] tick: balance=${total.toLocaleString('en-US')} sat (no change)`);
      return;
    }
    if (total < baseline) {
      const dec = baseline - total;
      this.log(
        `[deposits] tick: balance=${total.toLocaleString('en-US')} sat (DECREASED by ${dec.toLocaleString('en-US')} sat from ${baseline.toLocaleString('en-US')}; rebaselining, not firing)`,
      );
      this.lastNotifiedTotalDepositedSat = total;
      return;
    }

    const deltaSat = total - baseline;
    this.lastNotifiedTotalDepositedSat = total;

    if (muted || classDisabled) {
      this.log(
        `[deposits] tick: +${deltaSat.toLocaleString('en-US')} sat (${muted ? 'master-toggle off' : 'class-disabled'} - silent absorb)`,
      );
      return;
    }
    this.log(
      `[deposits] tick: +${deltaSat.toLocaleString('en-US')} sat - firing braiins_deposit_detected`,
    );

    const amount = formatSatAsBtc(deltaSat);
    const copy = copyFor(state);
    await this.alertManager.recordAlert({
      severity: 'INFO',
      title: copy.braiins_deposit_detected_title(),
      body: copy.braiins_deposit_detected_body({ amount, address_short: null }),
      event_class: 'braiins_deposit_detected',
    });
  }

  // ---------------------------------------------------------------
  // Shared transition machinery
  // ---------------------------------------------------------------

  private async runTransition(args: {
    event_class: string;
    severity: 'IMPORTANT' | 'WARNING' | 'INFO';
    isBad: boolean;
    thresholdMs: number;
    currentState: EventState;
    title: string;
    /**
     * Optional. If set, the recovery message uses this title verbatim
     * instead of the default "✓ <firing title>" with the Datum
     * special-case. Detectors whose firing title carries parametric
     * copy (e.g. "below N days") need this so the recovery title can
     * say "above N days" instead of contradicting itself.
     */
    titleForRecovery?: string;
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
    // Recovery title MUST be a positive statement of the new state
    // (e.g. "Bid active again"), NOT the firing title with a tick
    // mark in front of it. Operator was specific: "the title should
    // be immediately clear what it is, not a negation of what it was."
    // Every caller now provides `titleForRecovery`; the legacy
    // prepend-and-replace fallback is gone.
    if (!args.titleForRecovery) {
      throw new Error(
        `recoverable detector "${args.event_class}" must supply titleForRecovery`,
      );
    }
    const wasBadFor = nowMs - (args.currentState.bad_since_ms ?? nowMs);
    await this.alertManager.recordAlert({
      severity: 'INFO',
      title: args.titleForRecovery,
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
