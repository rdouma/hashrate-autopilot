import { describe, expect, it } from 'vitest';
import { selectToken } from './auth.js';
import { BraiinsAuthMissingError } from './errors.js';

describe('selectToken', () => {
  const OWNER = 'owner-token';
  const READER = 'reader-token';

  it('returns undefined for PUBLIC regardless of what is configured', () => {
    expect(selectToken('PUBLIC', {})).toBeUndefined();
    expect(selectToken('PUBLIC', { ownerToken: OWNER })).toBeUndefined();
    expect(selectToken('PUBLIC', { readOnlyToken: READER })).toBeUndefined();
    expect(selectToken('PUBLIC', { ownerToken: OWNER, readOnlyToken: READER })).toBeUndefined();
  });

  it('prefers the read-only token for READ_ONLY calls', () => {
    expect(
      selectToken('READ_ONLY', { ownerToken: OWNER, readOnlyToken: READER }),
    ).toBe(READER);
  });

  it('falls back to the owner token when read-only is not configured', () => {
    expect(selectToken('READ_ONLY', { ownerToken: OWNER })).toBe(OWNER);
  });

  it('returns undefined for READ_ONLY when no token is configured', () => {
    expect(selectToken('READ_ONLY', {})).toBeUndefined();
  });

  it('requires the owner token for OWNER calls', () => {
    expect(selectToken('OWNER', { ownerToken: OWNER })).toBe(OWNER);
  });

  it('throws BraiinsAuthMissingError for OWNER without owner token', () => {
    expect(() => selectToken('OWNER', { readOnlyToken: READER })).toThrow(BraiinsAuthMissingError);
    expect(() => selectToken('OWNER', {})).toThrow(BraiinsAuthMissingError);
  });
});
