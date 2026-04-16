import { describe, expect, it } from 'vitest';

import { createOceanClient } from './ocean.js';

// Real HTML fragments captured 2026-04-16 against ocean.xyz/template/...
// Trimmed to the relevant blocks; full files were a few hundred bytes
// each. Embedded as fixtures so tests don't need network access.

const PAYOUT_FRAGMENT = `
<div class="blocks dashboard-container">
  <div class="blocks-label">Unpaid Earnings
      <div class="tooltip tooltip-info">
        <span class="tooltiptext">Earnings below threshold pending payment</span>
      </div>
  </div>
    <span>0.00356948 BTC</span>
</div>
<div class="blocks dashboard-container">
  <div class="blocks-label">Estimated Payout Next Block
      <div class="tooltip tooltip-info">
        <span class="tooltiptext">The on-chain payout threshold is 0.01048576 BTC</span>
      </div>
  </div>
    <span><a class="undecorated text-dark" href="/#faq-threshold">Below threshold</a></span>
</div>
<div class="blocks dashboard-container">
  <div class="blocks-label">Estimated Time Until Minimum Payout
  </div>
    <span>11 days</span>
</div>
`;

const LIFETIME_FRAGMENT = `
<div class="blocks dashboard-container">
  <div class="blocks-label">Share Log %
  </div>
    <span>0.009%</span>
</div>
<div class="blocks dashboard-container">
  <div class="blocks-label">Estimated Earnings Per Day
  </div>
    <span>0.00058339 BTC</span>
</div>
<div class="blocks dashboard-container">
  <div class="blocks-label">Lifetime Earnings
  </div>
    <span>0.00356948 BTC</span>
</div>
`;

const EARNINGS_FRAGMENT = `
<div class="blocks dashboard-container">
  <div class="blocks-label">Estimated Rewards In Window
  </div>
    <span>0.00226499 BTC</span>
</div>
<div class="blocks dashboard-container">
  <div class="blocks-label">Estimated Earnings Next Block
  </div>
    <span>0.00028374 BTC</span>
</div>
`;

function fakeFetch(map: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    for (const [path, body] of Object.entries(map)) {
      if (url.includes(path)) {
        return {
          ok: true,
          status: 200,
          text: async () => body,
        } as Response;
      }
    }
    return { ok: false, status: 404, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

describe('OceanClient', () => {
  it('parses all four BTC fields + the time-to-payout text', async () => {
    const client = createOceanClient({
      fetch: fakeFetch({
        '/template/workers/payoutcards': PAYOUT_FRAGMENT,
        '/template/workers/lifetimecards': LIFETIME_FRAGMENT,
        '/template/workers/earningscards': EARNINGS_FRAGMENT,
      }),
    });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats).not.toBeNull();
    expect(stats!.unpaid_sat).toBe(356_948);
    expect(stats!.lifetime_sat).toBe(356_948);
    expect(stats!.daily_estimate_sat).toBe(58_339);
    expect(stats!.rewards_in_window_sat).toBe(226_499);
    expect(stats!.next_block_sat).toBe(28_374);
    expect(stats!.share_log_pct).toBeCloseTo(0.009, 5);
    // "Estimated Time Until Minimum Payout" wins over the
    // "Estimated Payout Next Block" branch when both are present.
    expect(stats!.time_to_payout_text).toBe('11 days');
    expect(stats!.payout_threshold_sat).toBe(1_048_576);
  });

  it('returns null on any HTTP failure', async () => {
    const client = createOceanClient({
      fetch: (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch,
    });
    expect(await client.fetchStats('bc1qaddress')).toBeNull();
  });

  it('caches results within the TTL', async () => {
    let calls = 0;
    const client = createOceanClient({
      fetch: (async (url: string) => {
        calls++;
        if (url.includes('/payoutcards')) return resp(PAYOUT_FRAGMENT);
        if (url.includes('/lifetimecards')) return resp(LIFETIME_FRAGMENT);
        if (url.includes('/earningscards')) return resp(EARNINGS_FRAGMENT);
        return { ok: false, status: 404, text: async () => '' } as Response;
      }) as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      now: () => 1_700_000_000_000,
    });
    await client.fetchStats('bc1qaddress');
    const callsAfterFirst = calls;
    await client.fetchStats('bc1qaddress');
    expect(calls).toBe(callsAfterFirst); // no extra fetches
  });

  it('returns "Below threshold" branch when the time-text is missing', async () => {
    const payoutWithoutTime = `
      <div class="blocks dashboard-container">
        <div class="blocks-label">Unpaid Earnings
        </div>
          <span>0.00100000 BTC</span>
      </div>
      <div class="blocks dashboard-container">
        <div class="blocks-label">Estimated Payout Next Block
        </div>
          <span><a class="undecorated text-dark" href="/x">Below threshold</a></span>
      </div>
    `;
    const client = createOceanClient({
      fetch: fakeFetch({
        '/template/workers/payoutcards': payoutWithoutTime,
        '/template/workers/lifetimecards': LIFETIME_FRAGMENT,
        '/template/workers/earningscards': EARNINGS_FRAGMENT,
      }),
    });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.time_to_payout_text).toBe('Below threshold');
  });
});

function resp(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}
