/**
 * Pool-health probe - opens a TCP connection to the Datum Gateway and
 * tracks consecutive failures. SPEC §9 "Datum pool unreachable" uses this
 * to distinguish a transient blip from a sustained outage.
 */

import { Socket } from 'node:net';

export interface PoolProbeResult {
  readonly reachable: boolean;
  readonly checked_at: number;
  readonly latency_ms: number | null;
  readonly error: string | null;
}

export interface PoolProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

/**
 * One-shot TCP probe. Resolves quickly for happy-path, or within
 * `timeoutMs` (default 2500ms) on failure. Never throws - failures are
 * encoded in the result.
 */
export function probePool(options: PoolProbeOptions): Promise<PoolProbeResult> {
  const { host, port, timeoutMs = 2500 } = options;
  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const done = (result: PoolProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      done({
        reachable: true,
        checked_at: start,
        latency_ms: Date.now() - start,
        error: null,
      });
    });

    socket.once('timeout', () => {
      done({
        reachable: false,
        checked_at: start,
        latency_ms: null,
        error: `timeout after ${timeoutMs}ms`,
      });
    });

    socket.once('error', (err) => {
      done({
        reachable: false,
        checked_at: start,
        latency_ms: null,
        error: err.message,
      });
    });

    socket.connect(port, host);
  });
}

/**
 * Parse a `stratum+tcp://host:port` URL (or plain host:port) into
 * { host, port }. Defaults port to 23334 (Datum Gateway) when missing.
 */
export function parsePoolUrl(url: string): { host: string; port: number } {
  const stripped = url.replace(/^stratum\+tcp:\/\//, '').replace(/^stratum:\/\//, '');
  const [host, portStr] = stripped.split(':');
  if (!host) throw new Error(`cannot parse pool URL: ${url}`);
  const port = portStr ? Number.parseInt(portStr, 10) : 23334;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port in pool URL: ${url}`);
  }
  return { host, port };
}

/**
 * Stateful wrapper that counts consecutive failures across probes, so the
 * controller can apply `pool_outage_blip_tolerance_seconds` before acting.
 */
export class PoolHealthTracker {
  private lastOkAt: number | null = null;
  private consecutiveFailures = 0;

  async probe(options: PoolProbeOptions): Promise<PoolProbeResult> {
    const result = await probePool(options);
    if (result.reachable) {
      this.lastOkAt = result.checked_at;
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
    return result;
  }

  snapshot(): { last_ok_at: number | null; consecutive_failures: number } {
    return {
      last_ok_at: this.lastOkAt,
      consecutive_failures: this.consecutiveFailures,
    };
  }
}
