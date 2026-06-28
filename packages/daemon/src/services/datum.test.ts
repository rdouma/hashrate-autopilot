import { describe, it, expect, vi, afterEach } from 'vitest';

import { DatumService } from './datum.js';

function mockFetch(impl: () => unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.stubGlobal('fetch', vi.fn(impl as any));
}

const service = () =>
  new DatumService({ apiUrl: 'http://umbrel:21000', timeoutMs: 1000, now: () => 1000, log: () => {} });

afterEach(() => vi.unstubAllGlobals());

describe('DatumService.poll error hints (#310)', () => {
  it('parses the happy-path three-stats JSON', async () => {
    mockFetch(() => ({
      type: 'basic',
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          items: [
            { title: 'Connections', text: '3' },
            { title: 'Hashrate', text: '2.50', subtext: 'Ph/s' },
          ],
        }),
    }));
    const r = await service().poll();
    expect(r.reachable).toBe(true);
    expect(r.connections).toBe(3);
    expect(r.error).toBeNull();
  });

  it('flags an auth-proxy redirect (opaqueredirect) and points at the doc', async () => {
    mockFetch(() => ({ type: 'opaqueredirect', status: 0, ok: false, text: async () => '' }));
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/auth proxy/i);
    expect(r.error).toMatch(/setup-datum-api/);
  });

  it('flags an HTML login page returned with 200', async () => {
    mockFetch(() => ({
      type: 'basic',
      status: 200,
      ok: true,
      text: async () => '<!doctype html><html>login</html>',
    }));
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/HTML/i);
    expect(r.error).toMatch(/setup-datum-api/);
  });

  it('rewrites a bare "fetch failed" into a connection-refused hint with the URL', async () => {
    mockFetch(() => {
      throw new Error('fetch failed');
    });
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/connection refused/i);
    expect(r.error).toMatch(/http:\/\/umbrel:21000/);
    expect(r.error).toMatch(/setup-datum-api/);
  });
});
