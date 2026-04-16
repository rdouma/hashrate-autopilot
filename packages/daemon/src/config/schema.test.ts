import { describe, expect, it } from 'vitest';
import {
  APP_CONFIG_DEFAULTS,
  AppConfigInvariantsSchema,
  AppConfigSchema,
  SecretsSchema,
} from './schema.js';

const VALID_SECRETS = {
  braiins_owner_token: 'owner_xyz',
  braiins_read_only_token: 'reader_xyz',
  telegram_bot_token: '123:bot-token',
  telegram_webhook_secret: 'webhook-secret',
  bitcoind_rpc_url: 'http://127.0.0.1:8332',
  bitcoind_rpc_user: 'rpcuser',
  bitcoind_rpc_password: 'rpcpass',
  dashboard_password: 'hunter2',
};

const VALID_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://datum.local:23334',
  destination_pool_worker_name: 'remco.rig1',
  btc_payout_address: 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxx',
  telegram_chat_id: '123456789',
};

describe('SecretsSchema', () => {
  it('accepts a complete, valid secrets object', () => {
    expect(SecretsSchema.parse(VALID_SECRETS)).toEqual(VALID_SECRETS);
  });

  it('allows omitting the optional read-only token', () => {
    const { braiins_read_only_token: _, ...rest } = VALID_SECRETS;
    expect(SecretsSchema.parse(rest)).toEqual(rest);
  });

  it('rejects empty required strings', () => {
    expect(() =>
      SecretsSchema.parse({ ...VALID_SECRETS, braiins_owner_token: '' }),
    ).toThrow(/non-empty/i);
  });

  it('rejects malformed bitcoind URL', () => {
    expect(() =>
      SecretsSchema.parse({ ...VALID_SECRETS, bitcoind_rpc_url: 'not-a-url' }),
    ).toThrow();
  });
});

describe('AppConfigSchema', () => {
  it('accepts a valid config', () => {
    expect(AppConfigSchema.parse(VALID_CONFIG)).toMatchObject(VALID_CONFIG);
  });

  it('rejects non-positive hashrate targets', () => {
    expect(() => AppConfigSchema.parse({ ...VALID_CONFIG, target_hashrate_ph: 0 })).toThrow();
    expect(() => AppConfigSchema.parse({ ...VALID_CONFIG, target_hashrate_ph: -1 })).toThrow();
  });

  it('rejects malformed quiet hours', () => {
    expect(() =>
      AppConfigSchema.parse({ ...VALID_CONFIG, quiet_hours_start: '24:00' }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({ ...VALID_CONFIG, quiet_hours_end: '7:30' }),
    ).toThrow();
  });

  it('rejects non-integer budgets', () => {
    expect(() =>
      AppConfigSchema.parse({ ...VALID_CONFIG, bid_budget_sat: 50_000.5 }),
    ).toThrow();
  });
});

describe('AppConfigInvariantsSchema', () => {
  it('passes on a valid config', () => {
    expect(AppConfigInvariantsSchema.parse(VALID_CONFIG)).toMatchObject(VALID_CONFIG);
  });

  it('rejects floor > target', () => {
    expect(() =>
      AppConfigInvariantsSchema.parse({
        ...VALID_CONFIG,
        target_hashrate_ph: 0.5,
        minimum_floor_hashrate_ph: 1.0,
      }),
    ).toThrow(/floor must be <= target/);
  });

});
