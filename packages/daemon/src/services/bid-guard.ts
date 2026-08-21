/**
 * #373: bid-churn breaker and marketplace-blacklist hold.
 *
 * Incident (2026-08-21): while the Bitcoin node behind DATUM was hung,
 * the gateway stayed TCP-reachable but had no templates. Every rented
 * bid delivered nothing, Braiins canceled it, and the autopilot
 * immediately re-created a fresh one - a create/cancel cycle every ~5
 * minutes for hours, until Braiins's anti-abuse blacklisted the pool
 * target for 24h ("400 - Target not allowed (blacklisted until ...)").
 *
 * Two protections, both expressed as a persisted CREATE hold that
 * decide() honors:
 *
 * - CHURN BREAKER: a churn cycle is a bid the autopilot created that
 *   later disappears from the bids list without an autopilot CANCEL
 *   and never delivered meaningful hashrate while it lived. Three
 *   consecutive cycles trip a hold. Release is MANUAL ONLY (operator
 *   interview 2026-08-21): the operator clears it from the dashboard
 *   after fixing the cause - zero risk of automated churn re-tripping
 *   the marketplace's anti-abuse.
 *
 * - BLACKLIST HOLD: a CREATE failure carrying the marketplace's
 *   "blacklisted until <timestamp>" error parses the expiry and holds
 *   every CREATE until expiry + margin, then auto-releases. One alert
 *   instead of a failing tick per minute.
 *
 * Holds persist across restarts via `runtime_state` (migration 0124).
 * The churn STREAK itself is memory-only: cycles are minutes apart, so
 * a restart mid-streak just needs fresh evidence - by design the
 * breaker never fires on stale counts.
 */

import type { CreateHold, ExecutionResult } from '../controller/types.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';

export type { CreateHold };

/** Consecutive zero-delivery create→vanish cycles before holding. */
const CHURN_STREAK_THRESHOLD = 3;
/** A departed bid that peaked below this delivered ~nothing. */
const ZERO_DELIVERY_PH = 0.05;
/**
 * How long an autopilot CANCEL execution excuses that bid's later
 * disappearance. Braiins unwinds a DELETE asynchronously (observed ~3
 * min in PENDING_CANCEL, #276); 15 min is comfortably beyond any
 * observed teardown.
 */
const OWN_CANCEL_MEMORY_MS = 15 * 60_000;
/** Safety margin added to a parsed blacklist expiry. */
const BLACKLIST_MARGIN_MS = 5 * 60_000;
/**
 * Matches Braiins's target-blacklist rejection, e.g.
 * "400 - Target not allowed (blacklisted until 2026-08-22T19:01:40.951541240+00:00)".
 * The capture is handed to Date.parse, which copes with the
 * high-precision fraction; an unparseable date falls back to a fixed
 * 24h hold so the protection still engages on a format drift.
 */
const BLACKLIST_RE = /target not allowed \(blacklisted until ([^)]+)\)/i;
const BLACKLIST_FALLBACK_HOLD_MS = 24 * 60 * 60_000;

interface TrackedBid {
  readonly firstSeenMs: number;
  maxDeliveredPh: number;
}

export interface BidGuardOptions {
  readonly runtimeRepo?: Pick<RuntimeStateRepo, 'patch'>;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export class BidGuardService {
  private hold: CreateHold | null = null;
  private churnStreak = 0;
  private readonly tracked = new Map<string, TrackedBid>();
  /** braiins_order_id -> when the autopilot's CANCEL executed. */
  private readonly ownCancels = new Map<string, number>();

  constructor(private readonly options: BidGuardOptions = {}) {}

  private get now(): () => number {
    return this.options.now ?? (() => Date.now());
  }

  private log(msg: string): void {
    this.options.log?.(msg);
  }

  /** Boot-time restore of a persisted hold. */
  hydrate(row: {
    create_hold_kind: string | null;
    create_hold_until_ms: number | null;
    create_hold_detail: string | null;
    create_hold_since_ms: number | null;
  }): void {
    if (row.create_hold_kind === 'churn' || row.create_hold_kind === 'blacklist') {
      this.hold = {
        kind: row.create_hold_kind,
        until_ms: row.create_hold_until_ms,
        detail: row.create_hold_detail ?? '',
        since_ms: row.create_hold_since_ms ?? this.now(),
      };
      // A churn hold survives restarts armed: the streak evidence is
      // gone but the hold itself is the operator-facing fact.
      this.log(
        `[bid-guard] hydrated ${this.hold.kind} hold (until ${this.hold.until_ms ? new Date(this.hold.until_ms).toISOString() : 'manual release'})`,
      );
    }
  }

  /**
   * Current hold, auto-clearing an expired blacklist hold. decide()
   * reads this via State each tick, so expiry is checked at tick
   * cadence - the auto-resume needs no timer.
   */
  getHold(): CreateHold | null {
    if (
      this.hold?.kind === 'blacklist' &&
      this.hold.until_ms !== null &&
      this.now() >= this.hold.until_ms
    ) {
      this.log('[bid-guard] blacklist hold expired - resuming CREATEs');
      this.setHold(null);
    }
    return this.hold;
  }

  /** Operator resume control. Clears any hold kind - operator sovereignty. */
  clearHold(): void {
    if (this.hold) {
      this.log(`[bid-guard] ${this.hold.kind} hold cleared by operator`);
      this.setHold(null);
      this.churnStreak = 0;
    }
  }

  /**
   * Per-tick observation of the owned-bid set (call with every tick's
   * observed bids, AFTER a successful bids fetch only - a failed fetch
   * makes every bid "disappear" spuriously).
   */
  observeBids(
    ownedBids: ReadonlyArray<{ braiins_order_id: string; avg_speed_ph: number }>,
    bidsFetchOk: boolean,
  ): void {
    if (!bidsFetchOk) return;
    const nowMs = this.now();
    const present = new Set<string>();
    for (const b of ownedBids) {
      present.add(b.braiins_order_id);
      const t = this.tracked.get(b.braiins_order_id);
      if (t) {
        t.maxDeliveredPh = Math.max(t.maxDeliveredPh, b.avg_speed_ph);
      } else {
        this.tracked.set(b.braiins_order_id, {
          firstSeenMs: nowMs,
          maxDeliveredPh: b.avg_speed_ph,
        });
      }
    }

    // Departed bids: classify each as churn (vanished without our
    // CANCEL, never delivered) or normal (we canceled it, or it
    // delivered real hashrate - e.g. ran to fulfillment).
    for (const [id, t] of this.tracked) {
      if (present.has(id)) continue;
      this.tracked.delete(id);
      const cancelAt = this.ownCancels.get(id);
      const canceledByUs =
        cancelAt !== undefined && nowMs - cancelAt <= OWN_CANCEL_MEMORY_MS;
      this.ownCancels.delete(id);
      if (canceledByUs) continue; // our own teardown - neutral
      if (t.maxDeliveredPh >= ZERO_DELIVERY_PH) {
        // Delivered for real (fulfilled or market-canceled after
        // honest work) - evidence the pool works; reset the streak.
        this.churnStreak = 0;
        continue;
      }
      this.churnStreak += 1;
      this.log(
        `[bid-guard] churn cycle ${this.churnStreak}/${CHURN_STREAK_THRESHOLD}: bid ${id} vanished without our cancel, peak delivery ${t.maxDeliveredPh} PH/s`,
      );
      if (this.churnStreak >= CHURN_STREAK_THRESHOLD && this.hold === null) {
        this.setHold({
          kind: 'churn',
          until_ms: null,
          detail: `${this.churnStreak} consecutive bids were created and then canceled by the marketplace without delivering hashrate (last: ${id}). Creating is held until you resume it manually - check that your pool endpoint is producing work first.`,
          since_ms: nowMs,
        });
      }
    }

    // Expire stale own-cancel memory so the map can't grow unbounded.
    for (const [id, at] of this.ownCancels) {
      if (nowMs - at > OWN_CANCEL_MEMORY_MS) this.ownCancels.delete(id);
    }
  }

  /**
   * Per-tick observation of execution results: remembers the
   * autopilot's own CANCELs (so their disappearance is not churn) and
   * detects the marketplace's blacklist rejection on failed CREATEs.
   */
  observeExecuted(executed: ReadonlyArray<ExecutionResult>): void {
    const nowMs = this.now();
    for (const r of executed) {
      if (
        r.proposal.kind === 'CANCEL_BID' &&
        r.outcome === 'EXECUTED' &&
        'braiins_order_id' in r.proposal
      ) {
        this.ownCancels.set(r.proposal.braiins_order_id, nowMs);
      }
      if (
        r.proposal.kind === 'CREATE_BID' &&
        r.outcome === 'FAILED' &&
        typeof r.error === 'string'
      ) {
        const m = BLACKLIST_RE.exec(r.error);
        if (m) {
          const parsed = Date.parse(m[1]!.trim());
          const until =
            Number.isFinite(parsed) && parsed > nowMs
              ? parsed + BLACKLIST_MARGIN_MS
              : nowMs + BLACKLIST_FALLBACK_HOLD_MS;
          // Re-arm even if a hold is already active: a fresh rejection
          // means a fresh (possibly extended) expiry.
          if (this.hold?.kind !== 'blacklist' || this.hold.until_ms !== until) {
            this.setHold({
              kind: 'blacklist',
              until_ms: until,
              detail: `The marketplace blacklisted the pool target: ${r.error}. Creating is held until ${new Date(until).toISOString()} and resumes automatically.`,
              since_ms: nowMs,
            });
          }
        }
      }
    }
  }

  private setHold(hold: CreateHold | null): void {
    this.hold = hold;
    void this.options.runtimeRepo
      ?.patch({
        create_hold_kind: hold?.kind ?? null,
        create_hold_until_ms: hold?.until_ms ?? null,
        create_hold_detail: hold?.detail ?? null,
        create_hold_since_ms: hold?.since_ms ?? null,
      })
      .catch((err: unknown) =>
        this.log(`[bid-guard] hold persist failed: ${(err as Error).message}`),
      );
    if (hold) {
      this.log(`[bid-guard] CREATE hold set (${hold.kind}): ${hold.detail}`);
    }
  }
}
