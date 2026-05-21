/**
 * Daemon-managed Dynamic DNS updater (#111).
 *
 * Reads `ddns_*` fields from the live config snapshot every 5 min
 * and, if a provider is selected, pushes the daemon's current public
 * IP to that provider. v1 supports No-IP only (`provider = 'noip'`)
 * via the dyndns2 protocol on dynupdate.no-ip.com.
 *
 * Behavior:
 *   - Skip the call if the cached public IP equals the last-pushed IP
 *     AND the last successful push was < 1 hour ago. Forces an hourly
 *     heartbeat so providers with "30 days no update = hostname
 *     deactivated" rules (No-IP free tier) stay alive.
 *   - Never crashes the daemon. Failures are recorded in the snapshot
 *     and surfaced via /api/status; the dashboard renders them.
 *   - Honors live edits: changes to ddns_provider / ddns_hostname /
 *     ddns_username / ddns_credential take effect on the next tick
 *     because we read from the cfgRef ref-holder, not a snapshot.
 *
 * Why the daemon and not the router: routers' DDNS clients depend on
 * the vendor's service staying up (mynetgear.com had two outages in
 * one week, motivating this feature) and can't be diagnosed from the
 * dashboard. The daemon already polls api.ipify.org for the public-
 * IP visibility card, so the DDNS push reuses that data with no
 * extra network cost.
 */

import type { AppConfig } from '../config/schema.js';
import type { PublicIpService } from './public-ip.js';
import { USER_AGENT } from '../http/routes/build.js';

const NOIP_UPDATE_URL = 'https://dynupdate.no-ip.com/nic/update';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_MS = 60 * 60_000; // force a push at least hourly

export interface DdnsSnapshot {
  /** True iff a provider is configured. */
  readonly enabled: boolean;
  readonly provider: string;
  readonly hostname: string;
  /** Last response code from the provider (`good`, `nochg`, `nohost`, ...). */
  readonly last_status: string | null;
  /** Last IP we successfully pushed (`good` or `nochg` response). */
  readonly last_pushed_ip: string | null;
  /** When that successful push happened (ms since epoch). */
  readonly last_pushed_at: number | null;
  /** When we last attempted, regardless of outcome. */
  readonly last_attempted_at: number | null;
  /** Human-readable error, when last_status indicates failure. */
  readonly last_error: string | null;
}

export interface DdnsUpdaterOptions {
  /** Live config ref-holder. We read on every tick so edits take effect. */
  readonly cfgRef: { value: AppConfig };
  readonly publicIp: PublicIpService;
  readonly fetcher?: typeof fetch;
  readonly intervalMs?: number;
  readonly userAgent?: string;
  readonly log?: (msg: string) => void;
}

export class DdnsUpdaterService {
  private snapshot: DdnsSnapshot = {
    enabled: false,
    provider: '',
    hostname: '',
    last_status: null,
    last_pushed_ip: null,
    last_pushed_at: null,
    last_attempted_at: null,
    last_error: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetcher: typeof fetch;
  private userAgent: string;

  constructor(private readonly options: DdnsUpdaterOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
  }

  getSnapshot(): DdnsSnapshot {
    return this.snapshot;
  }

  /**
   * Record the result of an out-of-band successful push (e.g. the
   * Test connection button). Without this, the in-memory snapshot
   * keeps showing the previous periodic-tick result, so the operator
   * sees stale "Last successful push: <old IP> 27m ago" right after a
   * successful manual test - which prompted #114.
   *
   * Only call on happy responses (`good` / `nochg` / `OK`). Failures
   * stay invisible to the periodic snapshot - we don't want a
   * misconfigured-test typo to clobber the last known good push
   * history.
   */
  recordExternalPush(args: {
    provider: string;
    hostname: string;
    ip: string;
    status: string;
    now: number;
  }): void {
    const { provider, hostname, ip, status, now } = args;
    this.snapshot = {
      enabled: true,
      provider,
      hostname,
      last_status: status,
      last_pushed_ip: ip,
      last_pushed_at: now,
      last_attempted_at: now,
      last_error: null,
    };
  }

  /**
   * One iteration. Reads live config, decides whether to push, and
   * updates the snapshot. Never throws.
   */
  async tick(): Promise<void> {
    const cfg = this.options.cfgRef.value;
    const provider = cfg.ddns_provider;
    const hostname = cfg.ddns_hostname;
    const username = cfg.ddns_username;
    const credential = cfg.ddns_credential;

    // #150: DuckDNS uses only `credential` (the per-account token);
    // `username` is not part of its wire protocol. The dashboard
    // hides the username field for DuckDNS (Config.tsx
    // `hasUsernameField`), so for a clean DuckDNS setup
    // `cfg.ddns_username` is empty. A blanket `!username` guard would
    // disable auto-push for every DuckDNS install. Match the
    // dashboard's per-provider rule here.
    const requiresUsername = provider === 'noip' || provider === 'dyndns2';
    if (!provider || !hostname || !credential || (requiresUsername && !username)) {
      // Disabled or incompletely configured. Reflect that in the
      // snapshot so the dashboard can render "not configured" cleanly,
      // but don't touch last_pushed_* - that history belongs to the
      // last time it WAS configured and is still informative.
      this.snapshot = {
        ...this.snapshot,
        enabled: false,
        provider,
        hostname,
      };
      return;
    }

    // Public IP must be known before we can push. If the public-ip
    // poll hasn't completed yet, defer - we'll get another shot in
    // 5 min.
    const ipSnap = this.options.publicIp.getSnapshot();
    const ip = ipSnap.ip;
    if (!ip) {
      this.snapshot = {
        ...this.snapshot,
        enabled: true,
        provider,
        hostname,
        last_attempted_at: Date.now(),
        last_error: 'public IP unknown - public-ip poll has not yet succeeded',
      };
      return;
    }

    // Skip the round-trip if the IP is unchanged AND we've pushed
    // recently. The hourly heartbeat keeps the hostname alive on
    // providers with idle-expiry rules.
    const now = Date.now();
    const sameIp = this.snapshot.last_pushed_ip === ip;
    const recent =
      this.snapshot.last_pushed_at !== null &&
      now - this.snapshot.last_pushed_at < HEARTBEAT_MS;
    if (sameIp && recent) {
      this.snapshot = {
        ...this.snapshot,
        enabled: true,
        provider,
        hostname,
      };
      return;
    }

    if (provider === 'noip') {
      await this.pushNoIp({ hostname, username, credential, ip, now });
      return;
    }
    if (provider === 'duckdns') {
      await this.pushDuckDns({ hostname, credential, ip, now });
      return;
    }
    if (provider === 'dyndns2') {
      const updateUrl = cfg.ddns_update_url;
      if (!updateUrl) {
        this.snapshot = {
          enabled: true,
          provider,
          hostname,
          last_status: 'misconfigured',
          last_pushed_ip: this.snapshot.last_pushed_ip,
          last_pushed_at: this.snapshot.last_pushed_at,
          last_attempted_at: now,
          last_error: 'dyndns2 selected but ddns_update_url is empty',
        };
        return;
      }
      await this.pushDyndns2({ updateUrl, hostname, username, credential, ip, now });
      return;
    }
    this.snapshot = {
      enabled: true,
      provider,
      hostname,
      last_status: 'unsupported_provider',
      last_pushed_ip: this.snapshot.last_pushed_ip,
      last_pushed_at: this.snapshot.last_pushed_at,
      last_attempted_at: now,
      last_error: `provider '${provider}' is not supported in this build`,
    };
  }

  private async pushNoIp(args: {
    hostname: string;
    username: string;
    credential: string;
    ip: string;
    now: number;
  }): Promise<void> {
    const { hostname, username, credential, ip, now } = args;
    const url = `${NOIP_UPDATE_URL}?hostname=${encodeURIComponent(hostname)}&myip=${encodeURIComponent(ip)}`;
    const auth = Buffer.from(`${username}:${credential}`).toString('base64');

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5_000);
    try {
      const resp = await this.fetcher(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          'User-Agent': this.userAgent,
        },
        signal: ac.signal,
      });
      const body = (await resp.text()).trim();
      // Dyndns2 response codes - first whitespace-separated token is
      // the status. `good <ip>` and `nochg <ip>` are the happy paths;
      // anything else is an error per provider's spec.
      const status = body.split(/\s+/)[0] ?? '';
      const happy = status === 'good' || status === 'nochg';

      this.snapshot = {
        enabled: true,
        provider: 'noip',
        hostname,
        last_status: status || `HTTP ${resp.status}`,
        last_pushed_ip: happy ? ip : this.snapshot.last_pushed_ip,
        last_pushed_at: happy ? now : this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: happy ? null : body || `HTTP ${resp.status}`,
      };

      this.options.log?.(
        happy
          ? `[ddns] noip push: ${status} ${ip} -> ${hostname}`
          : `[ddns] noip push failed: ${body}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        enabled: true,
        provider: 'noip',
        hostname,
        last_status: 'network_error',
        last_pushed_ip: this.snapshot.last_pushed_ip,
        last_pushed_at: this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: msg,
      };
      this.options.log?.(`[ddns] noip push errored: ${msg}`);
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * DuckDNS update protocol: GET https://www.duckdns.org/update with
   * `domains`, `token`, `ip` query params. The hostname stored in
   * `ddns_hostname` here is the full `<sub>.duckdns.org` form; we
   * strip the `.duckdns.org` suffix before sending because DuckDNS's
   * `domains=` param expects bare subdomains. Token is the
   * per-account bearer string DuckDNS hands out at sign-up; we store
   * it in `ddns_credential`. Username field is unused for this
   * provider (left empty in the dashboard / ignored here).
   *
   * Response: literal "OK" or "KO" on its own line. KO has no error
   * detail per their spec, so we surface the body verbatim.
   */
  private async pushDuckDns(args: {
    hostname: string;
    credential: string;
    ip: string;
    now: number;
  }): Promise<void> {
    const { hostname, credential, ip, now } = args;
    const sub = hostname.replace(/\.duckdns\.org$/i, '');
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(credential)}&ip=${encodeURIComponent(ip)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5_000);
    try {
      const resp = await this.fetcher(url, {
        headers: { 'User-Agent': this.userAgent },
        signal: ac.signal,
      });
      const body = (await resp.text()).trim();
      const happy = body === 'OK';
      this.snapshot = {
        enabled: true,
        provider: 'duckdns',
        hostname,
        last_status: happy ? 'good' : body || `HTTP ${resp.status}`,
        last_pushed_ip: happy ? ip : this.snapshot.last_pushed_ip,
        last_pushed_at: happy ? now : this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: happy ? null : body || `HTTP ${resp.status}`,
      };
      this.options.log?.(
        happy
          ? `[ddns] duckdns push: OK ${ip} -> ${hostname}`
          : `[ddns] duckdns push failed: ${body}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        enabled: true,
        provider: 'duckdns',
        hostname,
        last_status: 'network_error',
        last_pushed_ip: this.snapshot.last_pushed_ip,
        last_pushed_at: this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: msg,
      };
      this.options.log?.(`[ddns] duckdns push errored: ${msg}`);
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Generic dyndns2 push. The protocol shape:
   *   GET <updateUrl>?hostname=<host>&myip=<ip>
   *   Authorization: Basic base64(user:pass)
   *   Body: `<status> <ip>` first whitespace token = status code.
   * Same response semantics as No-IP, since No-IP IS a dyndns2
   * implementation - but we keep them as separate provider names so
   * the operator's intent is clear in the config + UI.
   */
  private async pushDyndns2(args: {
    updateUrl: string;
    hostname: string;
    username: string;
    credential: string;
    ip: string;
    now: number;
  }): Promise<void> {
    const { updateUrl, hostname, username, credential, ip, now } = args;
    const sep = updateUrl.includes('?') ? '&' : '?';
    const url = `${updateUrl}${sep}hostname=${encodeURIComponent(hostname)}&myip=${encodeURIComponent(ip)}`;
    const auth = Buffer.from(`${username}:${credential}`).toString('base64');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5_000);
    try {
      const resp = await this.fetcher(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          'User-Agent': this.userAgent,
        },
        signal: ac.signal,
      });
      const body = (await resp.text()).trim();
      const status = body.split(/\s+/)[0] ?? '';
      const happy = status === 'good' || status === 'nochg';
      this.snapshot = {
        enabled: true,
        provider: 'dyndns2',
        hostname,
        last_status: status || `HTTP ${resp.status}`,
        last_pushed_ip: happy ? ip : this.snapshot.last_pushed_ip,
        last_pushed_at: happy ? now : this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: happy ? null : body || `HTTP ${resp.status}`,
      };
      this.options.log?.(
        happy
          ? `[ddns] dyndns2 push: ${status} ${ip} -> ${hostname}`
          : `[ddns] dyndns2 push failed: ${body}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        enabled: true,
        provider: 'dyndns2',
        hostname,
        last_status: 'network_error',
        last_pushed_ip: this.snapshot.last_pushed_ip,
        last_pushed_at: this.snapshot.last_pushed_at,
        last_attempted_at: now,
        last_error: msg,
      };
      this.options.log?.(`[ddns] dyndns2 push errored: ${msg}`);
    } finally {
      clearTimeout(t);
    }
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Defer the first tick a few seconds so the public-ip poll has a
    // chance to complete first.
    setTimeout(() => void this.tick(), 8_000);
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
