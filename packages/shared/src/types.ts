/**
 * Domain types shared across the autopilot packages.
 */

// Branded numeric primitives — prevent mixing sat-budget with sat-per-EH-per-day at the type level.
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Sats = Brand<number, 'Sats'>;
export type SatsPerEHPerDay = Brand<number, 'SatsPerEHPerDay'>;
export type HashrateHs = Brand<number, 'HashrateHs'>;

export const asSats = (n: number): Sats => n as Sats;
export const asSatsPerEHPerDay = (n: number): SatsPerEHPerDay => n as SatsPerEHPerDay;
export const asHashrateHs = (n: number): HashrateHs => n as HashrateHs;

// Run mode — operator-controlled; SPEC §7.1.
export type RunMode = 'DRY_RUN' | 'LIVE' | 'PAUSED';

// Action mode — autopilot-controlled; SPEC §7.2.
export type ActionMode =
  | 'NORMAL'
  | 'QUIET_HOURS'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMATION_TIMEOUT';

// Mutating actions against the marketplace; SPEC §7.3 gates these.
export type MutationAction = 'create' | 'edit' | 'cancel';

export interface GateInputs {
  readonly runMode: RunMode;
  readonly actionMode: ActionMode;
  readonly action: MutationAction;
}
