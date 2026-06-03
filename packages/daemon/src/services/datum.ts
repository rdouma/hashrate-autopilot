/**
 * Datum Gateway stats poller (issue #19).
 *
 * Polls Datum Gateway once per tick when configured, exposes connection
 * count + hashrate, and supports both shipped stats surfaces:
 *   - `{apiUrl}/umbrel-api` JSON when Datum is built with DATUM_API_FOR_UMBREL.
 *   - `{apiUrl}/` dashboard HTML fallback used by the StartOS package.
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
  readonly checked_at: number;
  readonly error: string | null;
}

export interface DatumServiceOptions {
  readonly apiUrl: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
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

function hashrateUnitMultiplier(unit: string): number | undefined {
  const normalized = unit
    .toLowerCase()
    .trim()
    .replace('/sec', '/s');
  return HASHRATE_UNIT_TO_PH[normalized];
}

export class DatumService {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private lastOkAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(options: DatumServiceOptions) {
    let url = options.apiUrl;
    while (url.endsWith('/')) url = url.slice(0, -1);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Datum API URL must use http or https, got ${parsed.protocol}`);
    }
    this.apiUrl = url;
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
      if (response.status === 404) {
        return await this.pollStartosDashboard(checkedAt, controller.signal);
      }
      if (!response.ok) {
        return this.fail(checkedAt, `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as UmbrelApiResponse;
      const connections = extractNumber(payload, 'Connections');
      const hashrate_ph = extractHashratePh(payload);
      this.lastOkAt = checkedAt;
      this.consecutiveFailures = 0;
      return {
        reachable: true,
        connections,
        hashrate_ph,
        checked_at: checkedAt,
        error: null,
      };
    } catch (err) {
      return this.fail(checkedAt, (err as Error).message ?? String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async pollStartosDashboard(
    checkedAt: number,
    signal: AbortSignal,
  ): Promise<DatumPollResult> {
    const response = await fetch(`${this.apiUrl}/`, { signal });
    if (!response.ok) {
      return this.fail(checkedAt, `HTTP ${response.status}`);
    }
    const html = await response.text();
    const connections =
      extractDashboardNumber(html, 'Total Work Subscriptions') ??
      extractDashboardNumber(html, 'Total Connections');
    const hashrate_ph = extractDashboardHashratePh(html);

    if (connections === null && hashrate_ph === null) {
      return this.fail(checkedAt, 'Datum dashboard stats not found');
    }

    this.lastOkAt = checkedAt;
    this.consecutiveFailures = 0;
    return {
      reachable: true,
      connections,
      hashrate_ph,
      checked_at: checkedAt,
      error: null,
    };
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
      checked_at: checkedAt,
      error,
    };
  }
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
  const multiplier = hashrateUnitMultiplier(unit);
  if (multiplier === undefined) {
    // Unknown unit - fall back to the pre-fix behaviour (assume Th/s)
    // rather than returning null, so a future Datum label change
    // degrades gracefully instead of blanking the field.
    return n / 1_000;
  }
  return n * multiplier;
}

function extractDashboardNumber(html: string, label: string): number | null {
  const lower = html.toLowerCase();
  const start = lower.indexOf(label.toLowerCase());
  if (start < 0) return null;
  const afterLabel = html.slice(start + label.length);
  const textAfterLabel = afterLabel.replace(/<[^>]*>/g, ' ');
  const match = textAfterLabel.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

function extractDashboardHashratePh(html: string): number | null {
  const lower = html.toLowerCase();
  const start = lower.indexOf('estimated hashrate');
  if (start < 0) return null;
  const afterLabel = html.slice(start + 'estimated hashrate'.length);
  const textAfterLabel = afterLabel.replace(/<[^>]*>/g, ' ');
  const match = textAfterLabel.match(/([-+]?\d+(?:\.\d+)?)\s*([a-z]+\/(?:s|sec))/i);
  if (!match) return null;
  const amount = match[1];
  const unit = match[2];
  if (!amount || !unit) return null;
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return null;
  const multiplier = hashrateUnitMultiplier(unit) ?? (1 / 1_000);
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
      last_ok_at: snap.last_ok_at,
      consecutive_failures: snap.consecutive_failures,
    };
  }
}
