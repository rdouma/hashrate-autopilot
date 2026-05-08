/**
 * Notification sink interface + Telegram implementation.
 *
 * The daemon's alert-manager records `alerts` rows on every
 * transition into / out of bad state and asks a NotificationSink to
 * actually deliver them. The sink is intentionally narrow (one
 * `send` method, one `verify` method) so a future second backend -
 * Nostr DMs, ntfy, email - can be plugged in without touching the
 * alert-manager. See spec.md §9.
 *
 * Why Telegram over Nostr for v1: setup friction + push reliability.
 * @BotFather is a 60-second flow; Nostr requires picking a client +
 * relay + key management. And for "stratum died at 3am" the
 * centralised-but-battle-tested Apple/Google push beats relay-hop
 * delivery on reliability. If push reliability proves flaky in
 * practice the modular sink lets us swap backends without re-emitting
 * alerts. See #100 for the full design rationale.
 */

export interface NotificationDeliveryResult {
  /** True iff the upstream API accepted the message. */
  readonly ok: boolean;
  /**
   * Channel-specific identifier for the delivered message, JSON-stringified
   * for storage in `alerts.delivery_meta_json`. Telegram's API returns a
   * numeric `message_id`; future channels can return whatever they need.
   */
  readonly delivery_meta_json: string | null;
  /**
   * Human-readable error string when `ok` is false. Already includes
   * the underlying network-error code (ENOTFOUND / ECONNREFUSED /
   * ETIMEDOUT) and the HTTP status if the response was non-2xx, so
   * the operator can copy the message into a bug report unchanged.
   */
  readonly error: string | null;
}

export interface NotificationSink {
  /**
   * Deliver a single alert payload. The body is plain UTF-8; sinks
   * are responsible for any per-channel escaping. Should not throw -
   * network failures surface as `{ ok: false, error: '...' }` so the
   * alert-manager can record the failure and schedule a retry.
   */
  send(body: string): Promise<NotificationDeliveryResult>;

  /**
   * Test connectivity with a fresh (unsaved) credential set. Used by
   * the Config-page "Test connection" button. Sends a hello-world
   * style probe and reports the result inline. Same return shape as
   * `send` so the route handler can dump it back to the dashboard.
   */
  verify(): Promise<NotificationDeliveryResult>;
}

// ---------------------------------------------------------------------------
// TelegramSink
// ---------------------------------------------------------------------------

export interface TelegramSinkOptions {
  readonly bot_token: string;
  readonly chat_id: string;
  /** Override the global fetch (test seam). */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout, ms. */
  readonly timeoutMs?: number;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

export class TelegramSink implements NotificationSink {
  private readonly bot_token: string;
  private readonly chat_id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: TelegramSinkOptions) {
    this.bot_token = opts.bot_token;
    this.chat_id = opts.chat_id;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(body: string): Promise<NotificationDeliveryResult> {
    return this.post(body);
  }

  async verify(): Promise<NotificationDeliveryResult> {
    return this.post(
      'Hashrate Autopilot test message. If you see this, your bot token + chat id are wired correctly.',
    );
  }

  private async post(body: string): Promise<NotificationDeliveryResult> {
    if (!this.bot_token || !this.chat_id) {
      return {
        ok: false,
        delivery_meta_json: null,
        error: 'bot token and chat id are both required',
      };
    }

    const url = `${TELEGRAM_API_BASE}/bot${this.bot_token}/sendMessage`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chat_id,
          text: body,
          // HTML mode supports a small whitelist of tags (<b> / <i> /
          // <code> etc) used by alert-manager to bold the title.
          // Forgiving compared to MarkdownV2 (only <, >, & need
          // escaping); the alert-manager handles that escaping
          // before passing the body in.
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: ctl.signal,
      });

      const json = (await res.json().catch(() => null)) as
        | TelegramSendMessageResponse
        | null;

      if (!res.ok || !json?.ok) {
        const desc = json?.description ?? `HTTP ${res.status}`;
        return {
          ok: false,
          delivery_meta_json: null,
          error: `Telegram API rejected: ${desc}`,
        };
      }

      const messageId = json.result?.message_id ?? null;
      return {
        ok: true,
        delivery_meta_json: messageId === null ? null : JSON.stringify({ message_id: messageId }),
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        delivery_meta_json: null,
        error: describeFetchFailure(err, url),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Translate a fetch-time exception into a one-line operator-facing
 * string. Mirrors the bitcoind-client's helper of the same name so
 * the dashboard's error UX is consistent across Test buttons.
 */
function describeFetchFailure(err: unknown, url: string): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return `request to ${url} timed out`;
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${cause.code} reaching ${url}`;
    return `${err.message} (${url})`;
  }
  return `unknown error reaching ${url}`;
}
