/**
 * #230: boot-time backfill of NULL tick_metrics.network_difficulty
 * from bitcoind. Pure-mocking unit tests - the better-sqlite3 ABI
 * mismatch on local Node 25 means real DB tests would skip anyway.
 *
 * Cases pinned:
 *   1. Zero NULL ticks → bitcoind is never touched (cheap no-op).
 *   2. Bitcoind unreachable → silent skip, no throw.
 *   3. Happy path → batches fired, UPDATEs grouped per epoch.
 *   4. Empty epoch list (range collapses) → no UPDATEs.
 */

import { describe, expect, it, vi } from 'vitest';

import { runNetworkDifficultyBackfill } from './network-difficulty-backfill.js';

function buildBitcoindMock(opts: {
  tipHeight?: number;
  tipTimeSecs?: number;
  unreachable?: boolean;
  batchOutputs?: unknown[][];
}) {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    client: {
      getBlockchainInfo: vi.fn(async () => {
        calls.push({ method: 'getBlockchainInfo', args: [] });
        if (opts.unreachable) throw new Error('ECONNREFUSED');
        return {
          chain: 'main',
          blocks: opts.tipHeight ?? 951_700,
          headers: opts.tipHeight ?? 951_700,
          bestblockhash: 'tip-hash',
          verificationprogress: 1,
          pruned: false,
        };
      }),
      getBlockHeader: vi.fn(async (hash: string) => {
        calls.push({ method: 'getBlockHeader', args: [hash] });
        return {
          version: 0x20000000,
          hash,
          height: opts.tipHeight ?? 951_700,
          time: opts.tipTimeSecs ?? Math.floor(Date.now() / 1000),
          previousblockhash: null,
          difficulty: 1e14,
        };
      }),
      getDeploymentInfo: vi.fn(),
      scanTxoutSet: vi.fn(),
      batch: vi.fn(async <T,>(reqs: readonly { method: string }[]): Promise<T[]> => {
        calls.push({ method: 'batch', args: [reqs] });
        const next = opts.batchOutputs?.shift();
        if (!next) throw new Error('mock batch ran out of outputs');
        return next as T[];
      }),
    },
  };
}

function buildRepoMock(range: {
  earliest_tick_at: number | null;
  latest_tick_at: number | null;
  count: number;
}) {
  const updates: { from: number; to: number; difficulty: number; updated: number }[] = [];
  return {
    updates,
    repo: {
      nullDifficultyRange: vi.fn(async () => range),
      updateDifficultyForNullRange: vi.fn(
        async (from: number, to: number, difficulty: number) => {
          const u = { from, to, difficulty, updated: 100 };
          updates.push(u);
          return u.updated;
        },
      ),
    } as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['tickMetricsRepo'],
  };
}

describe('runNetworkDifficultyBackfill', () => {
  it('skips entirely when no NULL ticks exist', async () => {
    const bc = buildBitcoindMock({});
    const repo = buildRepoMock({ earliest_tick_at: null, latest_tick_at: null, count: 0 });
    await runNetworkDifficultyBackfill({
      bitcoindClient: bc.client as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['bitcoindClient'],
      tickMetricsRepo: repo.repo,
    });
    expect(bc.calls).toHaveLength(0);
    expect(repo.updates).toHaveLength(0);
  });

  it('silently skips when bitcoind is unreachable', async () => {
    const logs: string[] = [];
    const bc = buildBitcoindMock({ unreachable: true });
    const repo = buildRepoMock({
      earliest_tick_at: Date.now() - 86400_000,
      latest_tick_at: Date.now(),
      count: 500,
    });
    await expect(
      runNetworkDifficultyBackfill({
        bitcoindClient: bc.client as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['bitcoindClient'],
        tickMetricsRepo: repo.repo,
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs.join('\n')).toMatch(/bitcoind unreachable/);
    expect(repo.updates).toHaveLength(0);
  });

  it('happy path: batches hashes then headers, UPDATEs per epoch', async () => {
    const tipSecs = Math.floor(Date.now() / 1000);
    const earliestSecs = tipSecs - 7 * 86400; // 7 days ago
    const latestSecs = tipSecs - 6 * 86400; // 6 days ago
    const bc = buildBitcoindMock({
      tipHeight: 951_700,
      tipTimeSecs: tipSecs,
      // First batch returns 2 hashes; second returns 2 verbose headers.
      batchOutputs: [
        ['hash-a', 'hash-b'],
        [
          { difficulty: 1.1e14, time: earliestSecs - 3600 },
          { difficulty: 1.2e14, time: latestSecs + 3600 },
        ],
      ],
    });
    const repo = buildRepoMock({
      earliest_tick_at: earliestSecs * 1000,
      latest_tick_at: latestSecs * 1000,
      count: 1000,
    });
    await runNetworkDifficultyBackfill({
      bitcoindClient: bc.client as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['bitcoindClient'],
      tickMetricsRepo: repo.repo,
    });
    const batchCalls = bc.calls.filter((c) => c.method === 'batch');
    expect(batchCalls).toHaveLength(2);
    // Two boundaries → two UPDATEs (one per epoch).
    expect(repo.updates).toHaveLength(2);
    expect(repo.updates[0]!.difficulty).toBe(1.1e14);
    expect(repo.updates[1]!.difficulty).toBe(1.2e14);
  });

  it('logs and skips when range scan throws', async () => {
    const logs: string[] = [];
    const bc = buildBitcoindMock({});
    const badRepo = {
      nullDifficultyRange: vi.fn(async () => {
        throw new Error('db corruption');
      }),
      updateDifficultyForNullRange: vi.fn(),
    } as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['tickMetricsRepo'];
    await runNetworkDifficultyBackfill({
      bitcoindClient: bc.client as unknown as Parameters<typeof runNetworkDifficultyBackfill>[0]['bitcoindClient'],
      tickMetricsRepo: badRepo,
      log: (m) => logs.push(m),
    });
    expect(logs.join('\n')).toMatch(/range scan failed/);
    expect(bc.calls).toHaveLength(0);
  });
});
