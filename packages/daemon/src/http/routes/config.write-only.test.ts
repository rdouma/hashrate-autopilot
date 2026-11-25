import { describe, expect, it } from 'vitest';

import { maskCredentials, keepCredentials, credentialsNeedingReentry } from './config.js';
import type { AppConfig } from '../../config/schema.js';

// A minimal-but-typed config stub; only the fields under test matter.
const base = {
  telegram_bot_token: 'bot:SECRET',
  bitcoind_rpc_password: 'rpcpass',
  ddns_credential: 'ddns-secret',
  bitcoind_rpc_user: 'rpcuser',
  btc_payout_address: 'bc1qexample',
  target_hashrate_ph: 3,
} as unknown as AppConfig;

describe('config write-only credentials (#331)', () => {
  it('GET masks the true secrets and reports which are set', () => {
    const { config, credentials_set } = maskCredentials(base);
    expect((config as Record<string, unknown>).telegram_bot_token).toBe('');
    expect((config as Record<string, unknown>).bitcoind_rpc_password).toBe('');
    expect((config as Record<string, unknown>).ddns_credential).toBe('');
    // Username stays visible - it's not a secret.
    expect((config as Record<string, unknown>).bitcoind_rpc_user).toBe('rpcuser');
    expect((config as Record<string, unknown>).btc_payout_address).toBe('bc1qexample');
    expect(credentials_set).toMatchObject({
      telegram_bot_token: true,
      bitcoind_rpc_password: true,
      ddns_credential: true,
    });
  });

  it('reports a not-configured secret as false', () => {
    const { credentials_set } = maskCredentials({
      ...base,
      telegram_bot_token: '',
    } as AppConfig);
    expect(credentials_set.telegram_bot_token).toBe(false);
  });

  it('PUT keeps a set secret when the incoming value is blank', () => {
    const incoming = {
      ...base,
      telegram_bot_token: '', // left blank = keep
      bitcoind_rpc_password: 'newpass', // changed
      ddns_credential: '', // left blank = keep
    } as AppConfig;
    const merged = keepCredentials(incoming, base) as Record<string, unknown>;
    expect(merged.telegram_bot_token).toBe('bot:SECRET'); // kept
    expect(merged.bitcoind_rpc_password).toBe('newpass'); // updated
    expect(merged.ddns_credential).toBe('ddns-secret'); // kept
  });

  it('PUT does not resurrect a value when there was none to keep', () => {
    const prev = { ...base, telegram_bot_token: '' } as AppConfig;
    const incoming = { ...base, telegram_bot_token: '' } as AppConfig;
    const merged = keepCredentials(incoming, prev) as Record<string, unknown>;
    expect(merged.telegram_bot_token).toBe('');
  });
});

describe('credential re-entry when its address changes (GHSA-35jm-xg76-3hh4)', () => {
  const prev = {
    bitcoind_rpc_url: 'http://umbrel.local:8332',
    bitcoind_rpc_password: 'rpcpass',
    ddns_provider: 'dyndns2',
    ddns_update_url: 'https://members.dyndns.org/nic/update',
    ddns_credential: 'ddns-secret',
    telegram_bot_token: 'bot:SECRET',
    telegram_chat_id: '1',
  } as unknown as AppConfig;

  it('nothing to re-enter when no address changes', () => {
    const next = { ...prev, bitcoind_rpc_password: '', ddns_credential: '', telegram_bot_token: '' } as AppConfig;
    expect(credentialsNeedingReentry(next, prev)).toEqual([]);
  });

  it('a changed RPC URL with a blank password needs the password again', () => {
    const next = { ...prev, bitcoind_rpc_url: 'http://evil.example:8332', bitcoind_rpc_password: '' } as AppConfig;
    expect(credentialsNeedingReentry(next, prev)).toEqual(['bitcoind_rpc_password']);
  });

  it('a changed RPC URL with the password typed in is fine', () => {
    const next = { ...prev, bitcoind_rpc_url: 'http://other.local:8332', bitcoind_rpc_password: 'new' } as AppConfig;
    expect(credentialsNeedingReentry(next, prev)).toEqual([]);
  });

  it('applies even when the config holds no password (secrets-file fallback)', () => {
    const p = { ...prev, bitcoind_rpc_password: '' } as AppConfig;
    const next = { ...p, bitcoind_rpc_url: 'http://evil.example:8332' } as AppConfig;
    expect(credentialsNeedingReentry(next, p)).toEqual(['bitcoind_rpc_password']);
  });

  it('a changed DDNS update URL or provider with a blank credential needs it again', () => {
    expect(
      credentialsNeedingReentry({ ...prev, ddns_update_url: 'https://evil.example/u', ddns_credential: '' } as AppConfig, prev),
    ).toEqual(['ddns_credential']);
    expect(
      credentialsNeedingReentry({ ...prev, ddns_provider: 'duckdns', ddns_credential: '' } as AppConfig, prev),
    ).toEqual(['ddns_credential']);
  });

  it('clearing an address (turning the feature off) does not need the credential', () => {
    const next = { ...prev, bitcoind_rpc_url: '', bitcoind_rpc_password: '', ddns_provider: '', ddns_credential: '' } as AppConfig;
    expect(credentialsNeedingReentry(next, prev)).toEqual([]);
  });

  it('the Telegram token is never tied to an address (fixed Telegram API)', () => {
    const next = { ...prev, telegram_chat_id: '2', telegram_bot_token: '' } as AppConfig;
    expect(credentialsNeedingReentry(next, prev)).toEqual([]);
  });
});
