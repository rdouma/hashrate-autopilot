/**
 * #272: redaction is the safety-critical part of the support bundle -
 * a leaked token in a public GitHub paste is unrecoverable. These
 * tests pin the redaction contract: every secret-bearing key renders
 * the loud marker, empty secrets stay empty (so "not configured" is
 * distinguishable), and non-secret values pass through untouched.
 */
import { describe, expect, it } from 'vitest';

import { maskPublicIpv4, REDACTED, redactConfig } from './diagnostics.js';

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

  it('passes non-secret values through untouched - LAN addresses are deliberate', () => {
    const out = redactConfig({
      datum_api_url: 'http://192.168.1.121:7152',
      electrs_host: '10.21.21.5',
      target_hashrate_ph: 1,
      btc_price_source: 'coingecko',
      solo_mining_enabled: true,
      electrs_port: null,
      ddns_update_url: 'https://update.dedyn.io/',
      telegram_chat_id: '942606673',
    });
    expect(out['datum_api_url']).toBe('http://192.168.1.121:7152');
    expect(out['electrs_host']).toBe('10.21.21.5');
    expect(out['target_hashrate_ph']).toBe(1);
    expect(out['btc_price_source']).toBe('coingecko');
    expect(out['solo_mining_enabled']).toBe(true);
    expect(out['electrs_port']).toBeNull();
    // Explicitly NOT private per operator review (#272).
    expect(out['ddns_update_url']).toBe('https://update.dedyn.io/');
    expect(out['telegram_chat_id']).toBe('942606673');
  });

  it('redacts personal-but-not-credential fields (operator review of the first real bundle)', () => {
    const out = redactConfig({
      btc_payout_address: 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg',
      ddns_hostname: 'myhost.dedyn.io',
      ddns_username: 'myhost.dedyn.io',
      telegram_instance_label: 'taliesin',
    });
    expect(out['btc_payout_address']).toBe(REDACTED);
    expect(out['ddns_hostname']).toBe(REDACTED);
    expect(out['ddns_username']).toBe(REDACTED);
    expect(out['telegram_instance_label']).toBe(REDACTED);
  });

  it('partially redacts the pool URL and worker name, keeping the diagnostic shape', () => {
    const out = redactConfig({
      destination_pool_url: 'stratum+tcp://myhost.dedyn.io:23334',
      destination_pool_worker_name: 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg.autopilot',
    });
    expect(out['destination_pool_url']).toBe(`stratum+tcp://${REDACTED}:23334`);
    expect(out['destination_pool_worker_name']).toBe(`${REDACTED}.autopilot`);
    // No identifying part survives.
    const json = JSON.stringify(out);
    expect(json).not.toContain('myhost');
    expect(json).not.toContain('bc1q');
  });

  it('fully redacts a bare worker name with no label suffix', () => {
    const out = redactConfig({
      destination_pool_worker_name: 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg',
    });
    expect(out['destination_pool_worker_name']).toBe(REDACTED);
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


describe('maskPublicIpv4', () => {
  it('keeps only the first octet, visibly redacted', () => {
    expect(maskPublicIpv4('179.25.240.12')).toBe('179.*.*.* [redacted]');
  });

  it('fully redacts anything that does not look like IPv4', () => {
    expect(maskPublicIpv4('2001:db8::1')).toBe(REDACTED);
    expect(maskPublicIpv4('garbage')).toBe(REDACTED);
  });
});
