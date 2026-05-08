/**
 * Polls a free, unauthenticated "what is my IP" service so the daemon
 * always has a current view of the box's public IPv4 address. Used by:
 *
 *   - The DDNS updater service (decides whether to push a fresh A
 *     record to the configured provider).
 *   - The dashboard's Pool & Payout diagnostics card (operator can
 *     compare current public IP against what the configured pool
 *     hostname resolves to, catching DDNS drift visually).
 *
 * Source: api.ipify.org. Plaintext, no auth, no body parsing - just
 * the IP as a string. If it ever goes away, swap for ifconfig.me /
 * icanhazip.com / similar; the comparison logic doesn't care.
 *
 * Failures are tolerated silently and surfaced as `null`. The daemon
 * never depends on this for control decisions; it's purely a
 * visibility / DDNS-drive signal.
 */

const IPIFY_URL = 'https://api.ipify.org';
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000; // 5 min

export interface PublicIpSnapshot {
  readonly ip: string | null;
  readonly checked_at: number | null;
  readonly error: string | null;
}

export interface PublicIpServiceOptions {
  /** Override for tests. */
  readonly fetcher?: typeof fetch;
  /** Poll interval. Defaults to 5 min. */
  readonly intervalMs?: number;
  /** Per-request timeout. Defaults to 5 s. */
  readonly timeoutMs?: number;
  readonly log?: (msg: string) => void;
  /**
   * Fires when a refresh observes the public IP rotating from one
   * non-null value to a different non-null value. Initial detection
   * (null -> first IP) does NOT fire - that's not a rotation, and the
   * DDNS updater's first tick is already scheduled separately. Lets
   * downstream services (DDNS updater) react immediately to ISP IP
   * rotation rather than waiting up to 5 min for their next tick.
   */
  readonly onIpChange?: (newIp: string, oldIp: string) => void;
}

export class PublicIpService {
  private snapshot: PublicIpSnapshot = {
    ip: null,
    checked_at: null,
    error: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetcher: typeof fetch;
  private timeoutMs: number;

  constructor(private readonly options: PublicIpServiceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  getSnapshot(): PublicIpSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<PublicIpSnapshot> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await this.fetcher(IPIFY_URL, { signal: ac.signal });
      if (!resp.ok) {
        this.snapshot = {
          ip: this.snapshot.ip,
          checked_at: Date.now(),
          error: `HTTP ${resp.status}`,
        };
        return this.snapshot;
      }
      const text = (await resp.text()).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
        this.snapshot = {
          ip: this.snapshot.ip,
          checked_at: Date.now(),
          error: `unexpected response: ${text.slice(0, 40)}`,
        };
        return this.snapshot;
      }
      const previousIp = this.snapshot.ip;
      this.snapshot = { ip: text, checked_at: Date.now(), error: null };
      if (previousIp !== null && previousIp !== text) {
        this.options.log?.(`[public-ip] IP changed: ${previousIp} -> ${text}`);
        try {
          this.options.onIpChange?.(text, previousIp);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.options.log?.(`[public-ip] onIpChange handler errored: ${msg}`);
        }
      }
      return this.snapshot;
    } catch (err) {
      this.snapshot = {
        ip: this.snapshot.ip,
        checked_at: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
      this.options.log?.(`[public-ip] refresh failed: ${this.snapshot.error}`);
      return this.snapshot;
    } finally {
      clearTimeout(t);
    }
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    setTimeout(() => void this.refresh(), 2_000);
    this.timer = setInterval(() => void this.refresh(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
