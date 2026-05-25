/**
 * Braiins on-chain deposit lifecycle watcher (#143, corrected #210).
 *
 * Polls `/v1/account/transaction/on-chain` every 60s. The endpoint
 * returns deposits across their full lifecycle, including the early
 * `DEPOSIT_STATUS_DETECTED` state (empirically verified 2026-05-25).
 * This watcher is the single source of truth for all three deposit
 * notification events:
 *
 *   - **Detected** (INFO) -- first time a tx_id appears in the
 *     response, regardless of status. The deposit has been seen by
 *     Braiins (mempool / first confirmation) but not yet credited.
 *   - **Available** (INFO) -- the deposit reaches
 *     `DEPOSIT_STATUS_CREDITED` with no `return_tx_id`. Compliance
 *     cleared; funds spendable.
 *   - **Returned**  (IMPORTANT) -- `return_tx_id` is non-empty.
 *     Compliance bounced it back; real money on the line.
 *
 * Per-row `notified_detected` / `notified_available` /
 * `notified_returned` flags ensure each event fires exactly once.
 *
 * Disabled paths (master toggle off, per-class disabled in #106):
 * still poll, still upsert, still flip `notified_*` flags so a
 * future toggle-on does NOT replay backlog.
 *
 * API shape note (#143): the OpenAPI generator declared `tx_type` and
 * `deposit_status` as integer enums, but the live response carries
 * the string names (`ONCHAIN_TRANSACTION_TYPE_DEPOSIT`,
 * `DEPOSIT_STATUS_CREDITED`, ...). The watcher coerces to String at
 * the call site rather than fighting the generated types.
 */

import type { BraiinsClient } from '@hashrate-autopilot/braiins-client';

import type { AppConfig } from '../config/schema.js';
import { getAlertCopy } from '../i18n/alert-copy.js';
import type {
  BraiinsDepositsRepo,
  DepositNotificationKind,
} from '../state/repos/braiins_deposits.js';
import type { AlertManager } from './alert-manager.js';

const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_LIMIT = 100;

const SAT_PER_BTC = 100_000_000;

/**
 * Live response carries the string name, not the OpenAPI-declared
 * integer enum. See module JSDoc note (#143).
 */
const TX_TYPE_DEPOSIT = 'ONCHAIN_TRANSACTION_TYPE_DEPOSIT';
const DEPOSIT_STATUS_CREDITED = 'DEPOSIT_STATUS_CREDITED';

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
      // OpenAPI declares tx_type as an int enum but the live response
      // is a string. See module JSDoc.
      const tx_type = String(tx.tx_type ?? '');
      if (tx_type !== TX_TYPE_DEPOSIT) continue;
      const tx_id = typeof tx.tx_id === 'string' ? tx.tx_id : '';
      if (!tx_id) continue;
      depositsSeen++;

      const amount_sat = Number(tx.amount_sat ?? 0);
      const deposit_status = String(tx.deposit_status ?? '');
      const return_tx_id =
        typeof tx.return_tx_id === 'string' && tx.return_tx_id.length > 0
          ? tx.return_tx_id
          : null;
      const address = typeof tx.address === 'string' ? tx.address : null;

      // status field is now a string. The legacy `last_seen_status`
      // column in braiins_deposits is INTEGER (from #130); we store
      // a sentinel 0/1 derived from the live status so the column
      // stays useful without a schema migration. 1 = CREDITED.
      const statusSentinel = deposit_status === DEPOSIT_STATUS_CREDITED ? 1 : 0;
      const observed = await this.options.depositsRepo.upsertSeen({
        tx_id,
        amount_sat,
        address,
        status: statusSentinel,
        return_tx_id,
        observed_at_ms: this.now(),
      });

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
        deposit_status === DEPOSIT_STATUS_CREDITED &&
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
