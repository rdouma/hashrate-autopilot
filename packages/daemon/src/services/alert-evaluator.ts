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
import type { State } from '../controller/types.js';

interface EventState {
  readonly bad_since_ms: number | null;
  /** id of the currently-open alert row, set on the first ping. */
  readonly active_alert_id: number | null;
}

const INITIAL: EventState = { bad_since_ms: null, active_alert_id: null };

export interface AlertEvaluatorOptions {
  readonly alertManager: AlertManager;
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

  private readonly alertManager: AlertManager;
  private readonly now: () => number;

  constructor(opts: AlertEvaluatorOptions) {
    this.alertManager = opts.alertManager;
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
    ];
    for (const [cls, setter] of classes) {
      const open = await alertsRepo.findOpenAlert(cls);
      if (open) {
        setter({ bad_since_ms: open.created_at, active_alert_id: open.id });
      }
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
    // TODO(#100): wallet_runway needs daily-burn input; low_acceptance
    //   needs an acceptance-ratio series in tick_metrics. Both are
    //   scoped for a small follow-up commit.
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
