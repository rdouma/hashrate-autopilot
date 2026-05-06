/**
 * Token roles for the Braiins Hashpower API. See SPEC §13 and RESEARCH.md §2.
 *
 * Auth is a single `apikey:` header carrying one of two tokens the user has
 * provisioned:
 *
 * - **OWNER** - can issue mutations (POST/PUT/DELETE on /spot/bid) and read
 *   account-scoped data.
 * - **READ_ONLY** - read-only access to user-scoped data.
 *
 * Public endpoints (market stats, orderbook) need no token.
 */

import { BraiinsAuthMissingError } from './errors.js';

export type AuthRole = 'PUBLIC' | 'READ_ONLY' | 'OWNER';

export interface BraiinsTokens {
  readonly ownerToken?: string | undefined;
  readonly readOnlyToken?: string | undefined;
}

/**
 * Pick the token to send for a call with the given required role.
 *
 * Role hierarchy: OWNER > READ_ONLY > PUBLIC. A higher-privilege token may
 * substitute for a lower-privilege one, but not the other way around.
 *
 * - PUBLIC: prefers no token (keeps public calls anonymous even if tokens are
 *   configured), which avoids accidental quota usage against authed limits.
 * - READ_ONLY: prefers read-only, falls back to owner if the read-only token
 *   isn't configured.
 * - OWNER: requires the owner token; throws `BraiinsAuthMissingError` if not
 *   configured.
 */
export function selectToken(role: AuthRole, tokens: BraiinsTokens): string | undefined {
  if (role === 'PUBLIC') return undefined;
  if (role === 'READ_ONLY') return tokens.readOnlyToken ?? tokens.ownerToken;
  if (role === 'OWNER') {
    if (!tokens.ownerToken) throw new BraiinsAuthMissingError('OWNER');
    return tokens.ownerToken;
  }
  // Exhaustiveness guard:
  const _exhaustive: never = role;
  throw new Error(`Unhandled AuthRole: ${String(_exhaustive)}`);
}
