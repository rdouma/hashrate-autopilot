/**
 * #318 follow-up: the log-drawer "View on chart" routing. Each jumpable
 * kind must jump the chart to the event time AND pulse a sonar beacon on
 * its marker (blocks via focus_block, the others via a generic
 * focus_marker=<kind>:<key>); config / daemon-start have no chart marker
 * so they return null (no jump button). This locks the URL contract that
 * Status.tsx + the chart marker beacons consume.
 */
import { describe, expect, it } from 'vitest';

import { logExtraJumpUrl, type LogExtraItem } from './logExtra';

function item(over: Partial<LogExtraItem> & Pick<LogExtraItem, 'kind' | 'key' | 'ts'>): LogExtraItem {
  return { summary: '', ...over };
}

describe('logExtraJumpUrl', () => {
  it('blocks jump with focus_block on the hash', () => {
    expect(
      logExtraJumpUrl(item({ kind: 'block', key: 'block:abc', ts: 100, blockHash: 'abc' })),
    ).toBe('/?at=100&focus_block=abc');
  });

  it('blocks without a hash fall back to a plain pan', () => {
    expect(logExtraJumpUrl(item({ kind: 'block', key: 'block:x', ts: 100 }))).toBe('/?at=100');
  });

  it('payout / deposit / ip / retarget use focus_marker = the row key', () => {
    expect(logExtraJumpUrl(item({ kind: 'payout', key: 'payout:7', ts: 100 }))).toBe(
      '/?at=100&focus_marker=payout:7',
    );
    expect(logExtraJumpUrl(item({ kind: 'deposit', key: 'deposit:tx9', ts: 100 }))).toBe(
      '/?at=100&focus_marker=deposit:tx9',
    );
    expect(logExtraJumpUrl(item({ kind: 'ip', key: 'ip:3', ts: 100 }))).toBe(
      '/?at=100&focus_marker=ip:3',
    );
    expect(logExtraJumpUrl(item({ kind: 'retarget', key: 'retarget:12345', ts: 100 }))).toBe(
      '/?at=100&focus_marker=retarget:12345',
    );
  });

  it('payout_initiated alert targets the unpaid-drop marker by timestamp', () => {
    expect(
      logExtraJumpUrl(
        item({ kind: 'alert', key: 'alert:42', ts: 9000, eventClass: 'payout_initiated' }),
      ),
    ).toBe('/?at=9000&focus_marker=unpaid:9000');
  });

  it('other point alerts pan only (no chart marker to beacon)', () => {
    expect(
      logExtraJumpUrl(item({ kind: 'alert', key: 'alert:43', ts: 9000, eventClass: 'beta_exit' })),
    ).toBe('/?at=9000');
  });

  it('config and daemon-start rows have no chart marker (null = no jump button)', () => {
    expect(logExtraJumpUrl(item({ kind: 'config', key: 'config:1', ts: 1 }))).toBeNull();
    expect(logExtraJumpUrl(item({ kind: 'boot', key: 'boot:1', ts: 1 }))).toBeNull();
  });
});
