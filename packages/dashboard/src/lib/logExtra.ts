/**
 * #317/#318: shared types + jump routing for the History "extra" log
 * rows (payout / deposit / pool block / IP change / retarget /
 * point-alert / config change / daemon start). Kept dependency-free
 * (no lingui / react) so the URL contract can be unit-tested in
 * isolation - the beacon wiring in Status.tsx and the chart marker
 * components all consume the strings this module produces.
 */

import type {
  DepositView,
  IpChangeEvent,
  OurBlockMarker,
  RetargetView,
  RewardEventView,
  SystemEventView,
} from './api';

export type LogExtraKind =
  | 'payout'
  | 'deposit'
  | 'block'
  | 'ip'
  | 'retarget'
  | 'alert'
  | 'config'
  | 'boot';

/**
 * #318: pool-block row variant. Mirrors the chart's marker semantics
 * (HashrateChart precedence): our own block reads as a crown, a
 * BIP-110-signalling block as a yellow cube, everything else as the
 * default blue cube. Drives both the row glyph and its color.
 */
export type BlockVariant = 'ours' | 'others' | 'bip110';

/** A merged log entry for one of the extra event types. */
export interface LogExtraItem {
  kind: LogExtraKind;
  /** Stable per-type key (numeric id or hash/txid). */
  key: string;
  ts: number;
  summary: string;
  /** Overrides the kind's generic label (used for point alerts / config). */
  label?: string;
  /** #318: for `kind === 'block'`, which marker variant to render. */
  blockVariant?: BlockVariant;
  /** #318: block hash for `kind === 'block'`, so the row can reveal the
   *  matching cube on the chart with a sonar beacon. */
  blockHash?: string;
  /** #318 follow-up: for `kind === 'alert'`, the raw event_class, so the
   *  drawer can route point alerts that map to a chart marker (e.g.
   *  `payout_initiated` -> the unpaid-drop marker). */
  eventClass?: string;
  /**
   * #318 follow-up: the raw source record for this row, so the detail
   * drawer can show the same fields as the event's chart tooltip
   * (operator: the side panel should mirror the graph tooltip). Exactly
   * one is set, matching `kind`; alert/config/boot rely on `summary`.
   */
  block?: OurBlockMarker;
  payout?: RewardEventView;
  deposit?: DepositView;
  ip?: IpChangeEvent;
  retarget?: RetargetView;
  /** #318 follow-up: raw config-change / daemon-start system event, so
   *  the drawer can render a human-readable field change. */
  system?: SystemEventView;
}

/**
 * #318 follow-up: nav URL that jumps the chart to an extra log entry's
 * marker, or null when the kind has no chart representation (config /
 * daemon-started). Each jumpable kind pulses a sonar beacon on its
 * marker: blocks via `focus_block`, the others via a generic
 * `focus_marker=<kind>:<key>`. The payout / deposit / IP / retarget keys
 * are exactly the row's own `key`; the `payout_initiated` point alert
 * maps to the tick-derived unpaid-drop marker (`unpaid:<ts>`), and other
 * point alerts have no marker so they pan only.
 */
export function logExtraJumpUrl(extra: LogExtraItem): string | null {
  switch (extra.kind) {
    case 'block':
      return extra.blockHash
        ? `/?at=${extra.ts}&focus_block=${extra.blockHash}`
        : `/?at=${extra.ts}`;
    case 'payout':
    case 'deposit':
    case 'ip':
    case 'retarget':
      // The row key is already `<kind>:<marker-id>`.
      return `/?at=${extra.ts}&focus_marker=${extra.key}`;
    case 'alert':
      return extra.eventClass === 'payout_initiated'
        ? `/?at=${extra.ts}&focus_marker=unpaid:${extra.ts}`
        : `/?at=${extra.ts}`;
    case 'config':
    case 'boot':
      return null;
  }
}
