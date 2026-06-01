/**
 * #231: range-by-epoch helpers for the BIP 110 scanner.
 *
 * Bucketing and range alignment are the load-bearing bits of the
 * epoch redesign - they're what guarantee the per-bucket percentage
 * is directly comparable to the 55% MASF threshold. Test them
 * in isolation; the full route is integration-tested elsewhere.
 */

import { describe, expect, it } from 'vitest';

import {
  BIP110_FIRST_SIGNALING_BLOCK_HEIGHT,
  bucketByEpoch,
  computeScanRange,
  extractMinerTag,
  forecastEpochEnd,
} from './bip110-scan.js';

const EPOCH = 2016;

describe('computeScanRange', () => {
  it('range=current: startHeight equals the current epoch start (floor of tip)', () => {
    const r = computeScanRange(951_700, 'current');
    const expectedCurrent = Math.floor(951_700 / EPOCH) * EPOCH;
    expect(r.currentEpochStart).toBe(expectedCurrent);
    expect(r.startHeight).toBe(expectedCurrent);
  });

  it('range=all: startHeight snaps to the epoch boundary at or below the first BIP 110 block', () => {
    const r = computeScanRange(951_700, 'all');
    const expectedStart = Math.floor(BIP110_FIRST_SIGNALING_BLOCK_HEIGHT / EPOCH) * EPOCH;
    expect(r.startHeight).toBe(expectedStart);
    expect(r.startHeight % EPOCH).toBe(0);
    // currentEpochStart unaffected by the range - always the floor of tip.
    expect(r.currentEpochStart).toBe(Math.floor(951_700 / EPOCH) * EPOCH);
  });

  it('range=all spans many epochs (sanity check on bucket count)', () => {
    const tip = 951_700;
    const r = computeScanRange(tip, 'all');
    const epochsCovered = (r.currentEpochStart - r.startHeight) / EPOCH + 1;
    // ~6-7 epochs from BIP110_FIRST_SIGNALING_BLOCK_HEIGHT (938_903)
    // through current as of the spec date. The exact count depends
    // on tip - just confirm we're in the right order of magnitude.
    expect(epochsCovered).toBeGreaterThanOrEqual(5);
    expect(epochsCovered).toBeLessThanOrEqual(20);
  });

  it('tip exactly on an epoch boundary: current epoch starts at the new boundary', () => {
    const tip = (BIP110_FIRST_SIGNALING_BLOCK_HEIGHT + 10 * EPOCH); // pick a far-enough tip
    const epochStart = Math.floor(tip / EPOCH) * EPOCH;
    const r = computeScanRange(epochStart, 'current');
    expect(r.currentEpochStart).toBe(epochStart);
    expect(r.startHeight).toBe(epochStart);
  });
});

describe('bucketByEpoch', () => {
  // Timestamps are seconds-since-epoch in bitcoind block headers.
  // We pick a reasonable base time so the assertions on `_time_ms`
  // are easy to read.
  const BASE = 1_700_000_000; // 2023-11-14T22:13:20Z, doesn't matter
  const sig = (height: number, time = BASE + height * 600) => ({
    height,
    version: 0x20000010,
    time,
  });
  const nosig = (height: number, time = BASE + height * 600) => ({
    height,
    version: 0x20000000,
    time,
  });

  it('puts each height into the right epoch bucket and computes pct', () => {
    const start = 4 * EPOCH;
    const tip = 5 * EPOCH + 100;
    const currentEpochStart = 5 * EPOCH;
    const headers = [
      // Epoch 4: 2 signaling out of 4 scanned (50%)
      sig(4 * EPOCH), sig(4 * EPOCH + 1), nosig(4 * EPOCH + 2), nosig(4 * EPOCH + 3),
      // Epoch 5 (in progress): 3 signaling out of 4 scanned (75%)
      sig(5 * EPOCH), sig(5 * EPOCH + 1), sig(5 * EPOCH + 2), nosig(5 * EPOCH + 3),
    ];
    const buckets = bucketByEpoch(headers, start, currentEpochStart, tip);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      start_height: 4 * EPOCH,
      end_height: 4 * EPOCH + EPOCH - 1,
      scanned: 4,
      signaling_count: 2,
      signaling_pct: 50,
      in_progress: false,
    });
    expect(buckets[1]).toMatchObject({
      start_height: 5 * EPOCH,
      end_height: tip,
      scanned: 4,
      signaling_count: 3,
      signaling_pct: 75,
      in_progress: true,
    });
  });

  it('captures start_time_ms / end_time_ms from min / max scanned header times', () => {
    const start = 4 * EPOCH;
    const tip = 5 * EPOCH + 100;
    const currentEpochStart = 5 * EPOCH;
    const headers = [
      // Epoch 4 - three headers with deliberately non-monotone times
      // (block time isn't strictly monotonic in Bitcoin; min/max
      // tracking has to handle that).
      sig(4 * EPOCH, BASE + 100),
      nosig(4 * EPOCH + 1, BASE + 50),
      sig(4 * EPOCH + 2, BASE + 200),
      // Epoch 5 - one header
      nosig(5 * EPOCH, BASE + 500),
    ];
    const buckets = bucketByEpoch(headers, start, currentEpochStart, tip);
    expect(buckets[0]!.start_time_ms).toBe((BASE + 50) * 1000);
    expect(buckets[0]!.end_time_ms).toBe((BASE + 200) * 1000);
    expect(buckets[1]!.start_time_ms).toBe((BASE + 500) * 1000);
    expect(buckets[1]!.end_time_ms).toBe((BASE + 500) * 1000);
  });

  it('seeds empty buckets when no header lands in an epoch - timestamps are null', () => {
    const start = 3 * EPOCH;
    const tip = 5 * EPOCH + 50;
    const currentEpochStart = 5 * EPOCH;
    // Only epoch 5 has headers; 3 and 4 should still appear as empty buckets.
    const headers = [sig(5 * EPOCH), nosig(5 * EPOCH + 1)];
    const buckets = bucketByEpoch(headers, start, currentEpochStart, tip);
    expect(buckets.map((b) => b.start_height)).toEqual([3 * EPOCH, 4 * EPOCH, 5 * EPOCH]);
    expect(buckets[0]!.scanned).toBe(0);
    expect(buckets[0]!.signaling_pct).toBe(0);
    expect(buckets[0]!.start_time_ms).toBeNull();
    expect(buckets[0]!.end_time_ms).toBeNull();
    expect(buckets[2]!.in_progress).toBe(true);
    expect(buckets[2]!.start_time_ms).not.toBeNull();
  });

  it('in-progress bucket carries expected_end_time_ms; completed buckets do not', () => {
    const start = 4 * EPOCH;
    const tip = 5 * EPOCH + 100;
    const currentEpochStart = 5 * EPOCH;
    const headers = [
      // Epoch 4 (completed): two headers with constant 600s spacing.
      sig(4 * EPOCH, BASE),
      sig(4 * EPOCH + 1, BASE + 600),
      // Epoch 5 (in-progress): 101 headers (heights 5*EPOCH..5*EPOCH+100),
      // each ~600s apart.
      ...Array.from({ length: 101 }, (_, i) => sig(5 * EPOCH + i, BASE + 1_000_000 + i * 600)),
    ];
    const buckets = bucketByEpoch(headers, start, currentEpochStart, tip);
    expect(buckets[0]!.expected_end_time_ms).toBeNull();
    expect(buckets[1]!.expected_end_time_ms).not.toBeNull();
    // 101 scanned out of 2016 → 1915 blocks remaining at ~600s each
    // → forecast ≈ last observed + 1915 × 600s.
    const lastObservedMs = (BASE + 1_000_000 + 100 * 600) * 1000;
    const expected = lastObservedMs + (2016 - 101) * 600 * 1000;
    expect(buckets[1]!.expected_end_time_ms).toBeCloseTo(expected, -3);
  });

  it('current-epoch-only scan reflects in-progress signaling pct (comparable to 55% MASF)', () => {
    const tip = 5 * EPOCH + 999; // halfway through epoch 5
    const start = 5 * EPOCH;
    const currentEpochStart = 5 * EPOCH;
    // 600 of 1000 scanned signal → 60% (over MASF threshold)
    const headers = Array.from({ length: 1000 }, (_, i) =>
      i < 600 ? sig(5 * EPOCH + i) : nosig(5 * EPOCH + i),
    );
    const buckets = bucketByEpoch(headers, start, currentEpochStart, tip);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.scanned).toBe(1000);
    expect(buckets[0]!.signaling_count).toBe(600);
    expect(buckets[0]!.signaling_pct).toBe(60);
    expect(buckets[0]!.in_progress).toBe(true);
    expect(buckets[0]!.end_height).toBe(tip);
  });
});

describe('forecastEpochEnd', () => {
  it('linear extrapolation: end + (2016 - scanned) × avg_block_time', () => {
    const startMs = 1_000_000_000_000;
    const endMs = startMs + 100 * 600_000; // 100 ticks at 600s each
    const result = forecastEpochEnd(startMs, endMs, 101);
    // avg = (endMs - startMs) / 100 = 600_000ms
    // forecast = endMs + (2016 - 101) * 600_000ms
    expect(result).toBe(endMs + (2016 - 101) * 600_000);
  });

  it('falls back to 600s × 2016 from start when only 1 block scanned (can\'t average)', () => {
    const startMs = 1_000_000_000_000;
    const endMs = startMs; // single block
    expect(forecastEpochEnd(startMs, endMs, 1)).toBe(startMs + 2016 * 600_000);
  });

  it('returns null when inputs are missing', () => {
    expect(forecastEpochEnd(null, 1, 5)).toBeNull();
    expect(forecastEpochEnd(1, null, 5)).toBeNull();
    expect(forecastEpochEnd(1, 1, 0)).toBeNull();
  });

  it('degrades to target-time fallback when computed average is non-positive (clock skew)', () => {
    const startMs = 1_000_000_000_000;
    // end < start across two blocks - defensive against header
    // time non-monotonicity / clock skew.
    const endMs = startMs - 1000;
    const result = forecastEpochEnd(startMs, endMs, 2);
    expect(result).toBe(startMs + 2016 * 600_000);
  });
});

/**
 * #234: miner-tag extraction. The two cases below are real Ocean
 * coinbases pulled from mempool.space's API for blocks 951929
 * (mempool labels: Roughnecks) and 951972 (Peer to Peer Money).
 * Before #234 the longest-printable-run heuristic mis-picked the
 * Ocean wrapper "<OCEAN.XYZ>" for block 951929 because it was
 * longer than "Roughnecks"; the new filter drops the wrapper and
 * the inner tag wins.
 */
describe('extractMinerTag', () => {
  it('picks the inner miner tag over the Ocean wrapper (block 951929: Roughnecks)', () => {
    // Coinbase scriptSig segment for block 951929. Both runs
    // present: "< OCEAN.XYZ >" (13 chars) + "Roughnecks" (10).
    const hex =
      '0379860e193c204f4345414e2e58595a203e0f526f7567686e65636b73000000';
    expect(extractMinerTag(hex)).toBe('Roughnecks');
  });

  it('still picks the longer non-wrapper run when both exist (block 951972: Peer to Peer Money)', () => {
    // Coinbase: "!< OCEAN.XYZ >" (14) + "Peer to Peer Money" (18).
    const hex =
      '0364860e1921213c204f4345414e2e58595a203e125065657220746f20506565722' +
      '04d6f6e6579';
    expect(extractMinerTag(hex)).toBe('Peer to Peer Money');
  });

  it('returns null when the coinbase has no printable run ≥3 chars', () => {
    expect(extractMinerTag('00000000000000000000')).toBeNull();
  });

  it('falls back to the unfiltered list when the Ocean wrapper is the only run', () => {
    // Pathological: only the Ocean wrapper, no inner tag. Render
    // the wrapper rather than nothing.
    const hex = '003c204f4345414e2e58595a203e00';
    expect(extractMinerTag(hex)).toBe('< OCEAN.XYZ >');
  });

  it('non-Ocean blocks behave like the old heuristic (longest run)', () => {
    // "Foundry USA Pool #" - a typical Foundry tag, no Ocean wrapper.
    const hex = '00466f756e6472792055534120506f6f6c202300';
    expect(extractMinerTag(hex)).toBe('Foundry USA Pool #');
  });
});
