import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PoolHealthTracker, parsePoolUrl, probePool } from './pool-health.js';

let server: Server;
let openPort: number;

beforeAll(async () => {
  server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad server address');
  openPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('probePool', () => {
  it('returns reachable=true for a listening port', async () => {
    const result = await probePool({ host: '127.0.0.1', port: openPort });
    expect(result.reachable).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeNull();
  });

  it('returns reachable=false for a closed port', async () => {
    // Port 1 is reserved + unused on loopback.
    const result = await probePool({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('times out on unroutable address', async () => {
    // 240.0.0.0/4 is reserved - the OS refuses immediately on macOS/Linux
    // rather than waiting. Either a refusal or a timeout is acceptable.
    const result = await probePool({ host: '240.0.0.1', port: 80, timeoutMs: 500 });
    expect(result.reachable).toBe(false);
  });
});

describe('parsePoolUrl', () => {
  it('strips stratum+tcp:// and parses host:port', () => {
    expect(parsePoolUrl('stratum+tcp://datum.local:23334')).toEqual({
      host: 'datum.local',
      port: 23334,
    });
  });

  it('accepts bare host:port', () => {
    expect(parsePoolUrl('192.168.1.121:23334')).toEqual({ host: '192.168.1.121', port: 23334 });
  });

  it('defaults to port 23334 when missing', () => {
    expect(parsePoolUrl('datum.local')).toEqual({ host: 'datum.local', port: 23334 });
  });

  it('rejects empty host', () => {
    expect(() => parsePoolUrl(':23334')).toThrow();
  });

  it('rejects garbage port', () => {
    expect(() => parsePoolUrl('host:nope')).toThrow();
  });
});

describe('PoolHealthTracker', () => {
  it('resets failure count on a successful probe', async () => {
    const t = new PoolHealthTracker();
    await t.probe({ host: '127.0.0.1', port: 1, timeoutMs: 200 });
    await t.probe({ host: '127.0.0.1', port: 1, timeoutMs: 200 });
    expect(t.snapshot().consecutive_failures).toBe(2);

    await t.probe({ host: '127.0.0.1', port: openPort });
    const snap = t.snapshot();
    expect(snap.consecutive_failures).toBe(0);
    expect(snap.last_ok_at).not.toBeNull();
  });
});
