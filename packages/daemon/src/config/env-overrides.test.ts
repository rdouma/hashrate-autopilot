import { describe, expect, it } from 'vitest';

import {
  applyEnvOverridesToConfig,
  applyEnvOverridesToSecrets,
  buildSecretsFromEnv,
  KNOWN_ENV_VARS,
} from './env-overrides.js';
import { APP_CONFIG_DEFAULTS, AppConfigSchema, type Secrets } from './schema.js';

// Build a minimum-valid AppConfig from defaults + the three required
// fields setup.ts collects. Tests don't care about most values; they
// just need a valid baseline to overlay env overrides on.
function makeConfig() {
  return AppConfigSchema.parse({
    ...APP_CONFIG_DEFAULTS,
    destination_pool_url: 'stratum+tcp://datum.local:23334',
    destination_pool_worker_name: 'bc1qexample.rig1',
    btc_payout_address: 'bc1qexample',
  });
}

const VALID_SECRETS: Secrets = {
  braiins_owner_token: 'token-owner',
  dashboard_password: 'super-secret-12',
};

describe('applyEnvOverridesToConfig', () => {
  it('returns the input unchanged when no relevant env vars are set', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, {});
    expect(out).toEqual(cfg);
  });

  it('coerces a numeric override and re-validates via schema', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, { BHA_TARGET_HASHRATE_PH: '2.5' });
    expect(out.target_hashrate_ph).toBe(2.5);
  });

  it('coerces an integer override', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, {
      BHA_MAX_BID_SAT_PER_EH_DAY: '50000000',
    });
    expect(out.max_bid_sat_per_eh_day).toBe(50_000_000);
  });

  it('coerces a boolean override', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, {
      BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART: 'true',
    });
    expect(out.show_effective_rate_on_price_chart).toBe(true);
  });

  it('treats "yes/on/1" as true and "no/off/0" as false', () => {
    const cfg = makeConfig();
    expect(
      applyEnvOverridesToConfig(cfg, { BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART: 'yes' })
        .show_effective_rate_on_price_chart,
    ).toBe(true);
    expect(
      applyEnvOverridesToConfig(cfg, { BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART: 'off' })
        .show_effective_rate_on_price_chart,
    ).toBe(false);
  });

  it('throws on a non-numeric value where a number is expected', () => {
    const cfg = makeConfig();
    expect(() =>
      applyEnvOverridesToConfig(cfg, { BHA_TARGET_HASHRATE_PH: 'banana' }),
    ).toThrow(/expected a number/i);
  });

  it('throws on a non-boolean value where a boolean is expected', () => {
    const cfg = makeConfig();
    expect(() =>
      applyEnvOverridesToConfig(cfg, {
        BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART: 'sometimes',
      }),
    ).toThrow(/expected a boolean/i);
  });

  it('coerces empty-string to null on nullable-on-empty fields', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, { BHA_DATUM_API_URL: '' });
    expect(out.datum_api_url).toBeNull();
  });

  it('overlays multiple values atomically', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, {
      BHA_TARGET_HASHRATE_PH: '2.0',
      BHA_MAX_BID_SAT_PER_EH_DAY: '48000000',
      BHA_OVERPAY_SAT_PER_EH_DAY: '500000',
    });
    expect(out.target_hashrate_ph).toBe(2.0);
    expect(out.max_bid_sat_per_eh_day).toBe(48_000_000);
    expect(out.overpay_sat_per_eh_day).toBe(500_000);
  });

  it('cross-field invariants still apply after env overrides', () => {
    // floor > target is rejected by the invariants schema. Setting
    // them via env must surface that, not silently accept it.
    const cfg = makeConfig();
    expect(() =>
      applyEnvOverridesToConfig(cfg, {
        BHA_TARGET_HASHRATE_PH: '1.0',
        BHA_MINIMUM_FLOOR_HASHRATE_PH: '2.0',
      }),
    ).toThrow(/floor must be <= target/i);
  });

  it('ignores unrelated env vars (no BHA_ prefix collision)', () => {
    const cfg = makeConfig();
    const out = applyEnvOverridesToConfig(cfg, {
      PATH: '/usr/bin',
      BITCOIN_RPC_HOST: '10.0.0.1',
      HOME: '/root',
    });
    expect(out).toEqual(cfg);
  });

  it('an env-var set to undefined (i.e. not present) is a no-op', () => {
    const cfg = makeConfig();
    // process.env values are technically string | undefined; verify
    // the absence-treatment matches the documented "leave unchanged."
    const out = applyEnvOverridesToConfig(cfg, {
      BHA_TARGET_HASHRATE_PH: undefined,
    });
    expect(out).toEqual(cfg);
  });
});

describe('applyEnvOverridesToSecrets', () => {
  it('returns the input unchanged when no env vars are set', () => {
    const out = applyEnvOverridesToSecrets(VALID_SECRETS, {});
    expect(out).toEqual(VALID_SECRETS);
  });

  it('overrides the owner token from env', () => {
    const out = applyEnvOverridesToSecrets(VALID_SECRETS, {
      BHA_BRAIINS_OWNER_TOKEN: 'env-owner-token',
    });
    expect(out.braiins_owner_token).toBe('env-owner-token');
    // Other fields are preserved.
    expect(out.dashboard_password).toBe(VALID_SECRETS.dashboard_password);
  });

  it('rejects an empty-string override of a required field via schema validation', () => {
    expect(() =>
      applyEnvOverridesToSecrets(VALID_SECRETS, { BHA_BRAIINS_OWNER_TOKEN: '' }),
    ).toThrow();
  });

  it('overlays optional fields too', () => {
    const out = applyEnvOverridesToSecrets(VALID_SECRETS, {
      BHA_BRAIINS_READ_ONLY_TOKEN: 'reader-tok',
    });
    expect(out.braiins_read_only_token).toBe('reader-tok');
  });
});

describe('buildSecretsFromEnv', () => {
  it('returns null when required fields are absent', () => {
    expect(buildSecretsFromEnv({})).toBeNull();
  });

  it('returns null when only the owner token is set (still missing dashboard_password)', () => {
    expect(
      buildSecretsFromEnv({ BHA_BRAIINS_OWNER_TOKEN: 'tok' }),
    ).toBeNull();
  });

  it('returns a fully-typed Secrets object when both required fields are present', () => {
    const out = buildSecretsFromEnv({
      BHA_BRAIINS_OWNER_TOKEN: 'tok',
      BHA_DASHBOARD_PASSWORD: 'pw-12345678',
    });
    expect(out).not.toBeNull();
    expect(out!.braiins_owner_token).toBe('tok');
    expect(out!.dashboard_password).toBe('pw-12345678');
  });

  it('includes optional fields when set', () => {
    const out = buildSecretsFromEnv({
      BHA_BRAIINS_OWNER_TOKEN: 'tok',
      BHA_DASHBOARD_PASSWORD: 'pw-12345678',
      BHA_BRAIINS_READ_ONLY_TOKEN: 'reader',
    });
    expect(out!.braiins_read_only_token).toBe('reader');
  });
});

describe('KNOWN_ENV_VARS', () => {
  it('exposes a deduplicated list (config + secret-only env vars)', () => {
    const set = new Set(KNOWN_ENV_VARS);
    expect(set.size).toBe(KNOWN_ENV_VARS.length);
  });

  it('includes the obvious ones', () => {
    expect(KNOWN_ENV_VARS).toContain('BHA_TARGET_HASHRATE_PH');
    expect(KNOWN_ENV_VARS).toContain('BHA_BRAIINS_OWNER_TOKEN');
    expect(KNOWN_ENV_VARS).toContain('BHA_DASHBOARD_PASSWORD');
  });

  it('every recognised name is BHA_-prefixed', () => {
    for (const v of KNOWN_ENV_VARS) {
      expect(v).toMatch(/^BHA_/);
    }
  });
});
