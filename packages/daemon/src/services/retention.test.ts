import { describe, expect, it, vi } from 'vitest';

import { RetentionService } from './retention.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { DecisionsRepo } from '../state/repos/decisions.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeConfig(overrides: Record<string, number> = {}) {
  return {
    tick_metrics_retention_days: 7,
    decisions_uneventful_retention_days: 7,
    decisions_eventful_retention_days: 90,
    ...overrides,
  };
}

function makeRepos({
  cfg = makeConfig(),
}: {
  cfg?: Record<string, number>;
} = {}) {
  const configRepo = { get: vi.fn(async () => cfg) } as unknown as ConfigRepo;
  const tickMetricsRepo = {
    pruneOlderThan: vi.fn(async () => undefined),
  } as unknown as TickMetricsRepo;
  const decisionsRepo = {
    pruneUneventfulOlderThan: vi.fn(async () => 0),
    pruneEventfulOlderThan: vi.fn(async () => 0),
  } as unknown as DecisionsRepo;
  return { configRepo, tickMetricsRepo, decisionsRepo };
}

describe('RetentionService', () => {
  it('invokes each prune with the correct cutoff from config', async () => {
    const now = 1_700_000_000_000;
    const { configRepo, tickMetricsRepo, decisionsRepo } = makeRepos();
    const svc = new RetentionService(configRepo, tickMetricsRepo, decisionsRepo, {
      now: () => now,
    });
    await svc.runOnce();

    expect(tickMetricsRepo.pruneOlderThan).toHaveBeenCalledWith(now - 7 * DAY_MS);
    expect(decisionsRepo.pruneUneventfulOlderThan).toHaveBeenCalledWith(now - 7 * DAY_MS);
    expect(decisionsRepo.pruneEventfulOlderThan).toHaveBeenCalledWith(now - 90 * DAY_MS);
  });

  it('skips a prune when its retention is 0 (keep forever)', async () => {
    const now = 1_700_000_000_000;
    const { configRepo, tickMetricsRepo, decisionsRepo } = makeRepos({
      cfg: makeConfig({
        tick_metrics_retention_days: 0,
        decisions_eventful_retention_days: 0,
      }),
    });
    const svc = new RetentionService(configRepo, tickMetricsRepo, decisionsRepo, {
      now: () => now,
    });
    await svc.runOnce();

    expect(tickMetricsRepo.pruneOlderThan).not.toHaveBeenCalled();
    expect(decisionsRepo.pruneEventfulOlderThan).not.toHaveBeenCalled();
    // Uneventful retention wasn't zeroed; its prune should still run.
    expect(decisionsRepo.pruneUneventfulOlderThan).toHaveBeenCalled();
  });

  it('survives an individual prune throwing (keeps pruning the other tables)', async () => {
    const { configRepo, tickMetricsRepo, decisionsRepo } = makeRepos();
    (tickMetricsRepo.pruneOlderThan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    const logs: string[] = [];
    const svc = new RetentionService(configRepo, tickMetricsRepo, decisionsRepo, {
      now: () => 1_700_000_000_000,
      log: (m) => logs.push(m),
    });
    const result = await svc.runOnce();
    expect(result.decisions_uneventful_deleted).toBe(0);
    expect(logs.some((l) => l.includes('tick_metrics prune failed'))).toBe(true);
    // Other prunes should still have been called.
    expect(decisionsRepo.pruneUneventfulOlderThan).toHaveBeenCalled();
    expect(decisionsRepo.pruneEventfulOlderThan).toHaveBeenCalled();
  });

  it('returns zeros without crashing when config row is missing', async () => {
    const configRepo = { get: vi.fn(async () => null) } as unknown as ConfigRepo;
    const tickMetricsRepo = {
      pruneOlderThan: vi.fn(),
    } as unknown as TickMetricsRepo;
    const decisionsRepo = {
      pruneUneventfulOlderThan: vi.fn(),
      pruneEventfulOlderThan: vi.fn(),
    } as unknown as DecisionsRepo;
    const svc = new RetentionService(configRepo, tickMetricsRepo, decisionsRepo);
    const r = await svc.runOnce();
    expect(r.tick_metrics_deleted).toBe(0);
    expect(tickMetricsRepo.pruneOlderThan).not.toHaveBeenCalled();
  });
});
