/**
 * Datum Gateway stats poller (issue #19).
 *
 * Polls `{apiUrl}/umbrel-api` once per tick when configured, parses the
 * three-stats JSON response, and exposes connection count + hashrate.
 * Integration is informational only - the control loop does not depend
 * on Datum being reachable. Failures are counted and surfaced as
 * `reachable: false`; they never throw out of `poll()`.
 *
 * `DatumPoller` wraps a `DatumService` and re-reads `datum_api_url`
 * from config on every poll, so config edits take effect on the next
 * tick without a daemon restart. When the URL is empty, it returns
 * null - observe() translates that to `state.datum = null` and the
 * dashboard shows a "not configured" empty state.
 *
 * See docs/setup-datum-api.md for the Umbrel-side port-exposure recipe.
 */

import type { DatumSnapshot } from '../controller/types.js';

export interface DatumPollResult {
  readonly reachable: boolean;
  readonly connections: number | null;
  /** Hashrate in PH/s. Null when the poll failed or Datum reported it missing. */
  readonly hashrate_ph: number | null;
  /** #91 - opportunistic gateway-side rejected-shares counter; null when DATUM does not expose a `/reject/i` tile. */
  readonly rejected_shares_total: number | null;
  readonly checked_at: number;
  readonly error: string | null;
}

export interface DatumServiceOptions {
  readonly apiUrl: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /**
   * #91 - receives `console.log`-style messages. The DATUM service
   * logs every `items[].title` it observes ONCE per service instance
   * (i.e. once per URL change, including initial connect) so the
   * operator can grep the daemon log to see what tiles their build
   * exposes. The log is the scoping data the issue's Step 1 calls
   * for; it tells us whether to expect a reject tile and what its
   * exact title is.
   */
  readonly log?: (msg: string) => void;
}

interface UmbrelApiItem {
  title?: string;
  text?: string;
  subtext?: string;
}

interface UmbrelApiResponse {
  type?: string;
  items?: UmbrelApiItem[];
}

/**
 * Multiplier to convert a Datum-reported hashrate to PH/s, keyed by
 * the unit Datum prints in `subtext`. Datum picks the unit based on
 * magnitude - below ~1 PH/s it reports Th/s, above that it reports
 * Ph/s. Case-insensitive match (observed "Ph/s" in the wild, but the
 * capitalisation is not contractual - `"TH/s"`, `"th/s"`, etc. all
 * seen across similar tools).
 */
const HASHRATE_UNIT_TO_PH: Record<string, number> = {
  'gh/s': 1 / 1_000_000,
  'th/s': 1 / 1_000,
  'ph/s': 1,
  'eh/s': 1_000,
};

export class DatumService {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private lastOkAt: number | null = null;
  private consecutiveFailures = 0;
  private titlesLogged = false;

  constructor(options: DatumServiceOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((msg) => console.log(msg));
  }

  async poll(): Promise<DatumPollResult> {
    const checkedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.apiUrl}/umbrel-api`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.fail(checkedAt, `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as UmbrelApiResponse;
      const connections = extractNumber(payload, 'Connections');
      const hashrate_ph = extractHashratePh(payload);
      const rejected_shares_total = extractRejectedShares(payload);
      // #91 - log observed item titles once per service instance.
      // Operator's DATUM build may or may not expose a reject tile;
      // this is the scoping data the issue's Step 1 calls for.
      if (!this.titlesLogged && payload.items) {
        const titles = payload.items.map((i) => i?.title ?? '<no title>').join(' | ');
        this.log(`[datum] /umbrel-api items observed: ${titles}`);
        this.titlesLogged = true;
      }
      this.lastOkAt = checkedAt;
      this.consecutiveFailures = 0;
      return {
        reachable: true,
        connections,
        hashrate_ph,
        rejected_shares_total,
        checked_at: checkedAt,
        error: null,
      };
    } catch (err) {
      return this.fail(checkedAt, (err as Error).message ?? String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  snapshot(): { last_ok_at: number | null; consecutive_failures: number } {
    return {
      last_ok_at: this.lastOkAt,
      consecutive_failures: this.consecutiveFailures,
    };
  }

  private fail(checkedAt: number, error: string): DatumPollResult {
    this.consecutiveFailures += 1;
    return {
      reachable: false,
      connections: null,
      hashrate_ph: null,
      rejected_shares_total: null,
      checked_at: checkedAt,
      error,
    };
  }
}

/**
 * #91 - heuristic scrape of any tile whose title matches /reject/i.
 *
 * DATUM exposes its UI tiles as a flat `items: { title, text, subtext }`
 * list with no machine-readable schema, so we scan title-strings rather
 * than committing to a specific field name DATUM may or may not adopt.
 * Parses the leading numeric portion of `text` (the rest is usually
 * unit / human label like "rejected shares" or "shares"). Returns null
 * when nothing matches or the value does not parse - which is the
 * common case as of May 2026 because most DATUM builds do not expose
 * a reject tile yet.
 *
 * Match strategy is `/reject/i` substring on title. Future-proof
 * against DATUM choosing "Rejected", "Rejects", "Rejected Shares",
 * "Reject Rate", etc. If the operator sees the wrong tile being
 * picked up the `[datum] /umbrel-api items observed: ...` log line
 * tells them what the daemon saw.
 */
function extractRejectedShares(payload: UmbrelApiResponse): number | null {
  const item = payload.items?.find((i) => typeof i?.title === 'string' && /reject/i.test(i.title));
  if (!item?.text) return null;
  const n = Number.parseFloat(item.text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function extractNumber(payload: UmbrelApiResponse, title: string): number | null {
  const item = payload.items?.find((i) => i?.title === title);
  if (!item?.text) return null;
  const n = Number.parseFloat(item.text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the Hashrate item's text + subtext and convert to PH/s. Datum
 * switches the unit between Th/s and Ph/s based on magnitude - an
 * unconditional ÷ 1000 would silently report a ~1.3 PH/s rig as
 * "0.00 PH/s" once it crosses the boundary.
 */
function extractHashratePh(payload: UmbrelApiResponse): number | null {
  const item = payload.items?.find((i) => i?.title === 'Hashrate');
  if (!item?.text) return null;
  const n = Number.parseFloat(item.text);
  if (!Number.isFinite(n)) return null;
  const unit = item.subtext?.toLowerCase().trim() ?? '';
  const multiplier = HASHRATE_UNIT_TO_PH[unit];
  if (multiplier === undefined) {
    // Unknown unit - fall back to the pre-fix behaviour (assume Th/s)
    // rather than returning null, so a future Datum label change
    // degrades gracefully instead of blanking the field.
    return n / 1_000;
  }
  return n * multiplier;
}

/**
 * Observer-facing wrapper: reads `datum_api_url` at every poll (via the
 * supplied getter), lazily creates a `DatumService` keyed on the URL,
 * and returns a `DatumSnapshot` shaped for `State.datum`. Returns null
 * when the URL is unset - that's the "not configured" signal the
 * dashboard surfaces.
 */
export class DatumPoller {
  private service: DatumService | null = null;
  private currentUrl: string | null = null;

  constructor(
    private readonly getUrl: () => string | null | Promise<string | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async poll(): Promise<DatumSnapshot | null> {
    const url = await this.getUrl();
    if (!url) {
      this.service = null;
      this.currentUrl = null;
      return null;
    }
    if (url !== this.currentUrl || this.service === null) {
      this.service = new DatumService({ apiUrl: url, now: this.now });
      this.currentUrl = url;
    }
    const service = this.service;
    const result = await service.poll();
    const snap = service.snapshot();
    return {
      reachable: result.reachable,
      connections: result.connections,
      hashrate_ph: result.hashrate_ph,
      rejected_shares_total: result.rejected_shares_total,
      last_ok_at: snap.last_ok_at,
      consecutive_failures: snap.consecutive_failures,
    };
  }
}
