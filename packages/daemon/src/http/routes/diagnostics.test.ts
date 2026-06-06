/**
 * #272: redaction is the safety-critical part of the support bundle -
 * a leaked token in a public GitHub paste is unrecoverable. These
 * tests pin the redaction contract: every secret-bearing key renders
 * the loud marker, empty secrets stay empty (so "not configured" is
 * distinguishable), and non-secret values pass through untouched.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED, redactConfig } from './diagnostics.js';

describe('redactConfig', () => {
  it('replaces populated secret fields with the loud marker', () => {
    const out = redactConfig({
      telegram_bot_token: '7212345678:AAHsecretsecret',
      bitcoind_rpc_password: 'hunter2',
      bitcoind_rpc_user: 'rpcuser',
      ddns_credential: 'abc-123-def',
    });
    expect(out['telegram_bot_token']).toBe(REDACTED);
    expect(out['bitcoind_rpc_password']).toBe(REDACTED);
    expect(out['bitcoind_rpc_user']).toBe(REDACTED);
    expect(out['ddns_credential']).toBe(REDACTED);
  });

  it('keeps empty secrets empty so not-configured stays visible', () => {
    const out = redactConfig({ telegram_bot_token: '', ddns_credential: '' });
    expect(out['telegram_bot_token']).toBe('');
    expect(out['ddns_credential']).toBe('');
  });

  it('passes non-secret values through untouched - full values are deliberate', () => {
    const out = redactConfig({
      datum_api_url: 'http://192.168.1.121:7152',
      electrs_host: '10.21.21.5',
      btc_payout_address: 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg',
      target_hashrate_ph: 1,
      btc_price_source: 'coingecko',
      solo_mining_enabled: true,
      electrs_port: null,
    });
    expect(out['datum_api_url']).toBe('http://192.168.1.121:7152');
    expect(out['electrs_host']).toBe('10.21.21.5');
    expect(out['btc_payout_address']).toBe('bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg');
    expect(out['target_hashrate_ph']).toBe(1);
    expect(out['btc_price_source']).toBe('coingecko');
    expect(out['solo_mining_enabled']).toBe(true);
    expect(out['electrs_port']).toBeNull();
  });

  it('catches future secret fields by key pattern', () => {
    const out = redactConfig({
      some_future_api_key: 'k-123',
      another_secret_thing: 'shh',
      new_provider_token: 'tok',
      new_provider_password: 'pw',
      harmless_count: 5,
    });
    expect(out['some_future_api_key']).toBe(REDACTED);
    expect(out['another_secret_thing']).toBe(REDACTED);
    expect(out['new_provider_token']).toBe(REDACTED);
    expect(out['new_provider_password']).toBe(REDACTED);
    expect(out['harmless_count']).toBe(5);
  });

  it('never leaves a populated token-like value in the output', () => {
    const input = {
      telegram_bot_token: 'tg-secret',
      ddns_credential: 'ddns-secret',
      bitcoind_rpc_password: 'rpc-secret',
      label: 'just a label',
    };
    const json = JSON.stringify(redactConfig(input));
    expect(json).not.toContain('tg-secret');
    expect(json).not.toContain('ddns-secret');
    expect(json).not.toContain('rpc-secret');
    expect(json).toContain('just a label');
  });
});
