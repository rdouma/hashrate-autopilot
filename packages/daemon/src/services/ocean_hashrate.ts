/**
 * Thin per-tick poller for Ocean's `user_hashrate` endpoint — just
 * the `hashrate_300s` field (5-minute sliding window). Split out
 * from the main OceanClient because that one caches all its stats
 * for 5 minutes to be polite; the chart needs a fresh sample every
 * tick to draw a responsive line (issue #36).
 *
 * Only this one field is polled; blocks + pool_stat + statsnap
 * continue to go through the cached OceanClient.
 */

const OCEAN_API_BASE = 'https://api.ocean.xyz/v1';
const DEFAULT_TIMEOUT_MS = 3_000;

export interface OceanHashrateService {
  /**
   * Returns the operator's current 5-minute-window hashrate in PH/s,
   * or null when Ocean was unreachable / the field was missing / the
   * response wasn't parseable. Never throws.
   */
  fetchHashratePh(address: string): Promise<number | null>;
}

export function createOceanHashrateService(opts?: {
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OceanHashrateService {
  const fetchImpl = opts?.fetch ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetchHashratePh(address: string): Promise<number | null> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(
          `${OCEAN_API_BASE}/user_hashrate/${address}`,
          { signal: controller.signal },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as {
          result?: { hashrate_300s?: string | number };
        };
        const raw = payload.result?.hashrate_300s;
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
        // Ocean returns H/s (e.g. 3.12e15 for 3.12 PH/s). Convert to PH/s.
        if (!Number.isFinite(n) || n <= 0) return null;
        return n / 1e15;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
