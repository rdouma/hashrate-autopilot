/**
 * Datum Gateway stats poller (issue #19).
 *
 * Polls `{apiUrl}/umbrel-api` once per tick when configured, parses the
 * three-stats JSON response, and exposes connection count + hashrate.
 * Integration is informational only — the control loop does not depend
 * on Datum being reachable. Failures are counted and surfaced as
 * `reachable: false`; they never throw out of `poll()`.
 *
 * `DatumPoller` wraps a `DatumService` and re-reads `datum_api_url`
 * from config on every poll, so config edits take effect on the next
 * tick without a daemon restart. When the URL is empty, it returns
 * null — observe() translates that to `state.datum = null` and the
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

export class DatumService {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private lastOkAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(options: DatumServiceOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
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
      const hashrateThs = extractNumber(payload, 'Hashrate');
      const hashrate_ph = hashrateThs !== null ? hashrateThs / 1000 : null;
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
 * Observer-facing wrapper: reads `datum_api_url` at every poll (via the
 * supplied getter), lazily creates a `DatumService` keyed on the URL,
 * and returns a `DatumSnapshot` shaped for `State.datum`. Returns null
 * when the URL is unset — that's the "not configured" signal the
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
