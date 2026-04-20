/**
 * First-run setup CLI for the Braiins Hashrate autopilot.
 *
 * Walks the operator through: installing the age key, seeding the sops
 * encryption policy, prompting for secrets + core config, and initialising
 * the SQLite database. Idempotent — refuses to overwrite an existing
 * setup without --force.
 *
 * Usage:
 *   pnpm setup                    # interactive, refuses to overwrite
 *   pnpm setup -- --force         # interactive, will overwrite
 *   pnpm setup -- --print-paths   # print resolved paths and exit
 */

import { chmod, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { confirm, input, number, password } from '@inquirer/prompts';

import {
  APP_CONFIG_DEFAULTS,
  AppConfigInvariantsSchema,
  ConfigRepo,
  RuntimeStateRepo,
  SecretsSchema,
  closeDatabase,
  openDatabase,
  type AppConfig,
  type Secrets,
} from '@braiins-hashrate/daemon';
import { stringify as stringifyYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Paths & args
// ---------------------------------------------------------------------------

interface SetupPaths {
  readonly projectRoot: string;
  readonly ageKey: string;
  readonly sopsPolicy: string;
  readonly secretsFile: string;
  readonly dbFile: string;
}

function resolvePaths(projectRoot: string): SetupPaths {
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? `${homedir()}/.config`;
  return {
    projectRoot,
    ageKey: `${xdgConfig}/braiins-hashrate/age.key`,
    sopsPolicy: resolve(projectRoot, '.sops.yaml'),
    secretsFile: resolve(projectRoot, '.env.sops.yaml'),
    dbFile: resolve(projectRoot, 'data/state.db'),
  };
}

interface Args {
  readonly force: boolean;
  readonly printPaths: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    force: argv.includes('--force'),
    printPaths: argv.includes('--print-paths'),
  };
}

// ---------------------------------------------------------------------------
// Tool checks
// ---------------------------------------------------------------------------

function requireBinary(name: string, installHint: string): void {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`${name} not found on PATH. Install with: ${installHint}`);
  }
}

// ---------------------------------------------------------------------------
// Age key
// ---------------------------------------------------------------------------

async function ensureAgeKey(path: string): Promise<string> {
  try {
    await stat(path);
    const existing = await readFile(path, 'utf8');
    const pub = extractAgePublicKey(existing);
    console.log(`→ using existing age key at ${path}`);
    return pub;
  } catch {
    // keep going
  }
  console.log(`→ generating new age key at ${path}`);
  await mkdir(dirname(path), { recursive: true });
  const gen = spawnSync('age-keygen', ['-o', path], { encoding: 'utf8' });
  if (gen.status !== 0) {
    throw new Error(`age-keygen failed: ${gen.stderr || gen.stdout}`);
  }
  await chmod(path, 0o600);
  const contents = await readFile(path, 'utf8');
  return extractAgePublicKey(contents);
}

function extractAgePublicKey(keyFile: string): string {
  const match = keyFile.match(/^#\s*public key:\s*(age1[0-9a-z]+)/m);
  if (!match || !match[1]) {
    throw new Error('Could not find the "# public key:" line in the age key file.');
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// sops policy
// ---------------------------------------------------------------------------

async function writeSopsPolicy(policyPath: string, agePublicKey: string): Promise<void> {
  const policy = `creation_rules:
  - path_regex: \\.env\\.sops\\.ya?ml$
    age: ${agePublicKey}
`;
  await writeFile(policyPath, policy, 'utf8');
}

// ---------------------------------------------------------------------------
// Encrypt + write secrets
// ---------------------------------------------------------------------------

async function writeEncryptedSecrets(
  secretsFile: string,
  secrets: Secrets,
  ageKeyPath: string,
): Promise<void> {
  const yamlText = stringifyYaml(secrets);
  await writeFile(secretsFile, yamlText, 'utf8');
  const env = { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath };
  const res = spawnSync('sops', ['-e', '-i', secretsFile], { encoding: 'utf8', env });
  if (res.status !== 0) {
    throw new Error(`sops -e -i failed: ${res.stderr || res.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

async function promptSecrets(): Promise<Secrets> {
  console.log('\n═══ Secrets ═══');
  const owner = await password({
    message: 'Braiins Hashpower owner token:',
    mask: true,
    validate: (v) => (v.trim().length > 0 ? true : 'required'),
  });

  const hasReader = await confirm({
    message: 'Do you also have a read-only Braiins token?',
    default: true,
  });
  const reader = hasReader
    ? await password({ message: 'Braiins read-only token:', mask: true })
    : undefined;

  const dashPass = await password({
    message: 'Password for the dashboard (minimum 8 characters):',
    mask: true,
    validate: (v) => (v.length >= 8 ? true : 'at least 8 characters'),
  });

  // bitcoind RPC credentials are edited from the dashboard Config page and
  // only matter when the operator picks `bitcoind` as the payout source —
  // Electrs is the default and has its own host/port fields. Not prompted
  // here to keep the first-run wizard short.
  const parsed = SecretsSchema.parse({
    braiins_owner_token: owner,
    ...(reader ? { braiins_read_only_token: reader } : {}),
    dashboard_password: dashPass,
  });
  return parsed;
}

async function promptConfig(): Promise<AppConfig> {
  console.log('\n═══ Core config ═══ (defaults are tunable later from the dashboard)');

  const target = await number({
    message: 'Target sustained hashrate (PH/s):',
    default: APP_CONFIG_DEFAULTS.target_hashrate_ph,
    step: 'any',
    min: 0.001,
    required: true,
  });
  const floor = await number({
    message: 'Minimum-floor hashrate (PH/s):',
    default: APP_CONFIG_DEFAULTS.minimum_floor_hashrate_ph,
    step: 'any',
    min: 0.001,
    required: true,
  });
  const pool = await input({
    message: 'Destination pool URL (Datum Gateway; must be public-routable):',
    default: 'stratum+tcp://datum.local:23334',
    validate: validUrl,
  });
  const payout = await input({
    message: 'BTC payout address to observe via bitcoind:',
    validate: nonEmpty,
  });
  console.log(
    '\n  Ocean TIDES credits hashrate to the address in the worker identity.',
  );
  console.log(
    `  Format: <btc address>.<label> — e.g. ${payout.slice(0, 10)}….rig1\n`,
  );
  const worker = await input({
    message: 'Worker identity (btc_address.label):',
    default: `${payout}.autopilot`,
    validate: (v) => {
      if (!v.includes('.')) {
        return 'must contain a period — "<btc address>.<label>"; without it, shares are uncredited on Ocean';
      }
      return true;
    },
  });
  return AppConfigInvariantsSchema.parse({
    ...APP_CONFIG_DEFAULTS,
    target_hashrate_ph: target,
    minimum_floor_hashrate_ph: floor,
    destination_pool_url: pool,
    destination_pool_worker_name: worker,
    btc_payout_address: payout,
  });
}

function nonEmpty(v: string): true | string {
  return v.trim().length > 0 ? true : 'required';
}

function validUrl(v: string): true | string {
  try {
    new URL(v);
    return true;
  } catch {
    return 'must be a valid URL';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = process.cwd();
  const paths = resolvePaths(projectRoot);

  if (args.printPaths) {
    console.log(JSON.stringify(paths, null, 2));
    return;
  }

  requireBinary('age-keygen', 'brew install age');
  requireBinary('sops', 'brew install sops');

  const secretsExists = await fileExists(paths.secretsFile);
  const dbExists = await fileExists(paths.dbFile);
  if ((secretsExists || dbExists) && !args.force) {
    console.error(
      `Existing setup found (secrets=${secretsExists}, db=${dbExists}). Re-run with --force to overwrite.`,
    );
    process.exit(1);
  }
  if (args.force) {
    if (secretsExists) await rm(paths.secretsFile);
    if (dbExists) await rm(paths.dbFile);
  }

  const agePubKey = await ensureAgeKey(paths.ageKey);
  await writeSopsPolicy(paths.sopsPolicy, agePubKey);

  const secrets = await promptSecrets();
  const appConfig = await promptConfig();

  console.log('\n→ encrypting secrets file');
  await writeEncryptedSecrets(paths.secretsFile, secrets, paths.ageKey);

  console.log('→ initialising database');
  await mkdir(dirname(paths.dbFile), { recursive: true });
  const handle = await openDatabase({ path: paths.dbFile });
  try {
    const configRepo = new ConfigRepo(handle.db);
    await configRepo.upsert(appConfig);
    const runtimeRepo = new RuntimeStateRepo(handle.db);
    await runtimeRepo.initializeIfMissing();
  } finally {
    await closeDatabase(handle);
  }

  console.log('\n✔ Setup complete.');
  console.log(`  age key:     ${paths.ageKey}   (chmod 600 — back this up!)`);
  console.log(`  sops policy: ${paths.sopsPolicy}`);
  console.log(`  secrets:     ${paths.secretsFile}`);
  console.log(`  database:    ${paths.dbFile}`);

  console.log('\nNext steps:');
  console.log('  • Start the daemon:   pnpm --filter @braiins-hashrate/daemon start');
  console.log('  • Dashboard URL:      http://<this-host>:3010 (binds to 0.0.0.0 by default)');
  console.log('  • If accessing from another machine on the LAN, allow port 3010 on the');
  console.log('    host firewall. On Ubuntu with ufw active:  sudo ufw allow 3010/tcp');
  console.log('  • Edit secrets later with:  sops .env.sops.yaml');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('\nSetup failed:');
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  }
  process.exit(1);
});
