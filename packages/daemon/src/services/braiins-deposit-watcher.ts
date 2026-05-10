/**
 * Braiins on-chain deposit lifecycle watcher (#141, restoration of
 * #130 - retired in #132 on the empirically-falsified assumption
 * that `total_deposited_sat` and "available" were the same moment).
 *
 * Polls `/v1/account/transaction/on-chain` on its own cadence,
 * upserts each deposit into `braiins_deposits`, and fires three
 * lifecycle Telegram notifications:
 *
 *   - **Detected**  - first time a tx_id appears in the API. INFO.
 *   - **Available** - status crosses the "completed" threshold AND
 *     `return_tx_id` is null. INFO.
 *   - **Returned**  - `return_tx_id` is non-null. IMPORTANT (real
 *     money on the line; Braiins compliance bounced it back).
 *
 * Per-row `notified_*` flags ensure every event fires exactly once,
 * even if the deposit sits in a state for hours across many polls.
 *
 * Disabled paths (master toggle off, per-class disabled in #106):
 * still poll, still upsert, still flip `notified_*` flags so a
 * future toggle-on does NOT replay backlog.
 *
 * Locale-aware: messages pull from `getAlertCopy(notification_locale)`
 * the same way the AlertEvaluator detectors do.
 *
 * DepositStatus enum (Braiins): undocumented in the OpenAPI. Empirical
 * mapping pending; #141 starts with `>= 3 = available` (the original
 * #130 guess) and a one-line log on every status transition so the
 * operator can confirm or correct against real behaviour.
 */

import type { BraiinsClient } from '@braiins-hashrate/braiins-client';

import type { AppConfig } from '../config/schema.js';
import { getAlertCopy } from '../i18n/alert-copy.js';
import type {
  BraiinsDepositsRepo,
  DepositNotificationKind,
} from '../state/repos/braiins_deposits.js';
import type { AlertManager } from './alert-manager.js';

const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_LIMIT = 100;
/**
 * #141 placeholder: Braiins's `DepositStatus` enum is 0..5 with no
 * published mapping. The original #130 used `>= 3` as the "completed"
 * threshold. After the watcher is live we log every observed status
 * transition so the operator can confirm/correct the threshold against
 * real Braiins behaviour. Single point of update.
 */
const AVAILABLE_STATUS_MIN = 3;

const SAT_PER_BTC = 100_000_000;

/** OnChainTransactionType: 0 = deposit per the assumed enum order. */
const TX_TYPE_DEPOSIT = 0;

export interface BraiinsDepositWatcherOptions {
  readonly cfgRef: { value: AppConfig };
  readonly braiinsClient: BraiinsClient;
  readonly depositsRepo: BraiinsDepositsRepo;
  readonly alertManager: AlertManager;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export class BraiinsDepositWatcherService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  /**
   * #141: silent-baseline guard. When the `braiins_deposits` table is
   * empty at boot AND the API returns a non-empty page on the first
   * successful poll, treat that page as historical backlog: upsert
   * every row with all `notified_*` flags pre-flipped to 1, no
   * Telegram POSTs. Without this, a daemon coming up after #132's
   * retirement era (when the table was unused, hence empty) would
   * fire one Telegram per existing deposit on its first tick.
   *
   * `null` = haven't polled yet; `true` = first poll completed
   * (further ticks behave normally).
   */
  private hydrated: boolean = false;

  constructor(private readonly options: BraiinsDepositWatcherOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    setTimeout(() => void this.tick(), 5_000);
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One iteration. Never throws - any Braiins API failure is logged
   * and skipped; the next tick retries from scratch (the table is
   * idempotent so a partial walk that crashed mid-loop just resumes).
   */
  async tick(): Promise<void> {
    let response;
    try {
      response = await this.options.braiinsClient.getOnChainTransactions({ limit: FETCH_LIMIT });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.log?.(`[deposits] poll failed: ${msg}`);
      return;
    }

    const transactions = response?.transactions ?? [];
    const cfg = this.options.cfgRef.value;
    let notifyOn = cfg.notify_on_braiins_deposit === true;

    // #141 silent-baseline: on the very first poll, if the local
    // table is empty AND the API gives us deposits, treat them as
    // backlog. Force notifyOn = false for this single tick so the
    // handleEvent path silently flips notified_* and skips the
    // Telegram POST. After this tick we set hydrated=true and the
    // suppression lifts.
    if (!this.hydrated) {
      const existingCount = await this.options.depositsRepo.countAll().catch(() => 0);
      if (existingCount === 0 && transactions.length > 0) {
        this.options.log?.(
          `[deposits] silent baseline: ${transactions.length} historical deposit(s) absorbed without notification`,
        );
        notifyOn = false;
      }
      this.hydrated = true;
    }

    let depositsSeen = 0;
    for (const tx of transactions) {
      if (tx.tx_type !== TX_TYPE_DEPOSIT) continue;
      const tx_id = typeof tx.tx_id === 'string' ? tx.tx_id : '';
      if (!tx_id) continue;
      depositsSeen++;

      const amount_sat = Number(tx.amount_sat ?? 0);
      const status = Number(tx.deposit_status ?? 0);
      const return_tx_id =
        typeof tx.return_tx_id === 'string' && tx.return_tx_id.length > 0
          ? tx.return_tx_id
          : null;
      const address = typeof tx.address === 'string' ? tx.address : null;

      const prev = await this.options.depositsRepo.findByTxId(tx_id);
      const prevStatus = prev?.last_seen_status ?? null;

      const observed = await this.options.depositsRepo.upsertSeen({
        tx_id,
        amount_sat,
        address,
        status,
        return_tx_id,
        observed_at_ms: this.now(),
      });

      // #141: surface every status transition for empirical mapping.
      if (prevStatus === null) {
        this.options.log?.(
          `[deposits] ${shortenTxId(tx_id)} first-seen: status=${status} amount=${amount_sat.toLocaleString('en-US')} sat return_tx_id=${return_tx_id ?? 'null'}`,
        );
      } else if (prevStatus !== status) {
        this.options.log?.(
          `[deposits] ${shortenTxId(tx_id)} status ${prevStatus} -> ${status}`,
        );
      }

      if (!observed.notified_detected) {
        await this.handleEvent({
          kind: 'detected',
          notifyOn,
          tx_id,
          payload: { amount_sat, address },
          severity: 'INFO',
        });
      }

      if (return_tx_id !== null && !observed.notified_returned) {
        await this.handleEvent({
          kind: 'returned',
          notifyOn,
          tx_id,
          payload: { amount_sat, return_tx_id },
          severity: 'IMPORTANT',
        });
        // Returned cancels the available path.
        if (!observed.notified_available) {
          await this.options.depositsRepo.markNotified(tx_id, 'available');
        }
        continue;
      }

      if (
        return_tx_id === null &&
        status >= AVAILABLE_STATUS_MIN &&
        !observed.notified_available
      ) {
        await this.handleEvent({
          kind: 'available',
          notifyOn,
          tx_id,
          payload: { amount_sat },
          severity: 'INFO',
        });
      }
    }

    this.options.log?.(`[deposits] poll: ${depositsSeen} deposit(s) walked`);
  }

  private async handleEvent(args: {
    kind: DepositNotificationKind;
    notifyOn: boolean;
    tx_id: string;
    payload:
      | { amount_sat: number; address: string | null }
      | { amount_sat: number; return_tx_id: string }
      | { amount_sat: number };
    severity: 'INFO' | 'IMPORTANT';
  }): Promise<void> {
    const { kind, notifyOn, tx_id, payload, severity } = args;

    if (!notifyOn) {
      await this.options.depositsRepo.markNotified(tx_id, kind);
      return;
    }

    const event_class = kindToEventClass(kind);
    const cfg = this.options.cfgRef.value;
    const disabled = new Set(cfg.notification_disabled_event_classes);
    if (disabled.has(event_class)) {
      await this.options.depositsRepo.markNotified(tx_id, kind);
      return;
    }

    const { title, body } = renderMessage(cfg.notification_locale, kind, payload);
    try {
      await this.options.alertManager.recordAlert({
        severity,
        title,
        body,
        event_class,
      });
      await this.options.depositsRepo.markNotified(tx_id, kind);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.log?.(
        `[deposits] recordAlert(${kind} ${shortenTxId(tx_id)}) failed: ${msg}`,
      );
      // Don't mark notified - retry on next poll.
    }
  }
}

function kindToEventClass(kind: DepositNotificationKind): string {
  switch (kind) {
    case 'detected':
      return 'braiins_deposit_detected';
    case 'available':
      return 'braiins_deposit_available';
    case 'returned':
      return 'braiins_deposit_returned';
  }
}

function formatSatAsBtc(sat: number): string {
  if (sat >= SAT_PER_BTC) {
    return `${(sat / SAT_PER_BTC).toFixed(8)} BTC (${sat.toLocaleString('en-US')} sat)`;
  }
  return `${sat.toLocaleString('en-US')} sat`;
}

function shortenTxId(tx_id: string): string {
  if (tx_id.length <= 16) return tx_id;
  return `${tx_id.slice(0, 8)}...${tx_id.slice(-8)}`;
}

function renderMessage(
  locale: string,
  kind: DepositNotificationKind,
  payload: { amount_sat: number; address?: string | null; return_tx_id?: string },
): { title: string; body: string } {
  const copy = getAlertCopy(locale);
  const amount = formatSatAsBtc(payload.amount_sat);
  switch (kind) {
    case 'detected': {
      const address_short = payload.address
        ? payload.address.slice(0, 12)
        : null;
      return {
        title: copy.braiins_deposit_detected_title(),
        body: copy.braiins_deposit_detected_body({ amount, address_short }),
      };
    }
    case 'available':
      return {
        title: copy.braiins_deposit_available_title(),
        body: copy.braiins_deposit_available_body({ amount }),
      };
    case 'returned':
      return {
        title: copy.braiins_deposit_returned_title(),
        body: copy.braiins_deposit_returned_body({
          amount,
          return_tx_short: shortenTxId(payload.return_tx_id ?? 'unknown'),
        }),
      };
  }
}
