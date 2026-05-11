/**
 * Telegram getUpdates long-poll worker (#109).
 *
 * Receives callback_query events when the operator taps the
 * "Mark as seen" button on an alert message and dispatches them
 * back to the alerts table. Without this the buttons render but
 * tapping does nothing - Telegram has no way to deliver the tap to
 * a daemon behind home NAT short of a webhook.
 *
 * Long-poll model: a single persistent HTTPS connection to
 * /getUpdates with a 30s timeout. Telegram's API handles the actual
 * "stream of events" semantics; we just maintain the offset cursor
 * across calls. Survives transient API failures via exponential
 * backoff; permanent failures (bad token / chat blocked) are logged
 * but don't crash the daemon.
 *
 * Read-side only: the bot doesn't accept free-text commands. The
 * only callback_data shape it acts on is `ack:<id>`. Snooze was
 * retired in cc62951; legacy `snooze:<id>:<minutes>` callbacks are
 * silently dropped (the buttons no longer render).
 *
 * After dispatching the action, the bot calls editMessageText to
 * append a "✓ acknowledged at <time>" footer and remove the keyboard,
 * so the operator gets visual confirmation in the same chat.
 */

import type { AlertsRepo } from '../state/repos/alerts.js';

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
}

export interface TelegramReceiverOptions {
  /**
   * Reads the latest credentials on every poll. Returning null/empty
   * pauses the receiver loop (no token/chat configured -> nothing
   * to listen on); the receiver wakes back up when credentials are
   * filled in via the dashboard.
   */
  readonly getCredentials: () => { bot_token: string; chat_id: string } | null;
  readonly alertsRepo: AlertsRepo;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (msg: string) => void;
  readonly now?: () => number;
}

const POLL_TIMEOUT_S = 30;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

export class TelegramReceiver {
  private readonly opts: TelegramReceiverOptions;
  private offset = 0;
  private running = false;
  private stopRequested = false;

  constructor(opts: TelegramReceiverOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
  }

  private log(msg: string): void {
    this.opts.log?.(`[telegram-rx] ${msg}`);
  }

  private async loop(): Promise<void> {
    let backoffMs = BACKOFF_INITIAL_MS;
    while (!this.stopRequested) {
      const creds = this.opts.getCredentials();
      if (!creds || !creds.bot_token || !creds.chat_id) {
        // Nothing to listen for. Sleep briefly and check again so
        // dashboard saves take effect without a daemon restart.
        await sleep(15_000);
        continue;
      }
      try {
        const updates = await this.fetchUpdates(creds.bot_token);
        for (const update of updates) {
          await this.handle(update, creds);
          this.offset = update.update_id + 1;
        }
        backoffMs = BACKOFF_INITIAL_MS;
      } catch (err) {
        this.log(`poll error: ${(err as Error).message} - backoff ${backoffMs}ms`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  private async fetchUpdates(bot_token: string): Promise<TelegramUpdate[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = `${TELEGRAM_API_BASE}/bot${bot_token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["callback_query"]')}`;
    const ctl = new AbortController();
    // Slightly larger than POLL_TIMEOUT_S so we don't beat Telegram
    // to the punch when no events are pending.
    const timer = setTimeout(() => ctl.abort(), (POLL_TIMEOUT_S + 5) * 1000);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
      const json = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
      if (!json.ok || !Array.isArray(json.result)) return [];
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handle(
    update: TelegramUpdate,
    creds: { bot_token: string; chat_id: string },
  ): Promise<void> {
    const cb = update.callback_query;
    if (!cb || !cb.data) return;

    // Reject taps from any chat that isn't the configured one. The
    // bot is a single-operator install; routing a different chat's
    // callbacks would let anyone with the bot's @-handle ack alerts.
    if (
      cb.message?.chat?.id !== undefined &&
      String(cb.message.chat.id) !== creds.chat_id
    ) {
      this.log(`callback from foreign chat ${cb.message.chat.id} - ignored`);
      await this.answerCallback(creds.bot_token, cb.id, 'unauthorised chat');
      return;
    }

    const action = parseCallbackData(cb.data);
    if (!action) {
      this.log(`unrecognised callback_data: ${cb.data}`);
      await this.answerCallback(creds.bot_token, cb.id, 'unknown action');
      return;
    }

    const now = (this.opts.now ?? (() => Date.now()))();
    let confirmation = '';
    try {
      // ack is the only supported callback now - snooze was removed
      // 2026-05-09 per operator request. parseCallbackData rejects
      // anything else; the type narrows to ack here.
      if (action.kind !== 'ack') {
        this.log(`unsupported callback kind: ${action.kind}`);
        await this.answerCallback(creds.bot_token, cb.id, 'unsupported');
        return;
      }
      await this.opts.alertsRepo.markAcknowledged(action.alert_id, now);
      // Diagnostic: operator wanted a trace they could grep when
      // verifying that a Telegram-side ack made it to the DB.
      this.log(`ack from Telegram: alert_id=${action.alert_id} acknowledged_at=${now}`);
      confirmation = '✓ acknowledged';
    } catch (err) {
      this.log(`action ack failed: ${(err as Error).message}`);
      await this.answerCallback(creds.bot_token, cb.id, 'failed');
      return;
    }

    await this.answerCallback(creds.bot_token, cb.id, confirmation);
    if (cb.message) {
      await this.editMessageText(creds.bot_token, {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `${cb.message.text ?? ''}\n\n<i>${confirmation} · ${formatTime(now)}</i>`,
      });
    }
  }

  private async answerCallback(
    bot_token: string,
    callback_query_id: string,
    text: string,
  ): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      await fetchImpl(`${TELEGRAM_API_BASE}/bot${bot_token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id, text }),
      });
    } catch (err) {
      this.log(`answerCallbackQuery: ${(err as Error).message}`);
    }
  }

  private async editMessageText(
    bot_token: string,
    args: { chat_id: number; message_id: number; text: string },
  ): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      await fetchImpl(`${TELEGRAM_API_BASE}/bot${bot_token}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: args.chat_id,
          message_id: args.message_id,
          text: args.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          // No reply_markup -> keyboard removed. Operator can't
          // double-tap an action that's already been processed.
        }),
      });
    } catch (err) {
      this.log(`editMessageText: ${(err as Error).message}`);
    }
  }
}

type CallbackAction = { kind: 'ack'; alert_id: number };

function parseCallbackData(data: string): CallbackAction | null {
  const parts = data.split(':');
  if (parts.length === 2 && parts[0] === 'ack') {
    const id = Number(parts[1]);
    if (Number.isInteger(id) && id > 0) return { kind: 'ack', alert_id: id };
  }
  // Legacy `snooze:<id>:<minutes>` callbacks from messages sent by
  // older daemon builds still arrive here; ignore them rather than
  // erroring loudly. The snooze concept was removed 2026-05-09.
  return null;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
