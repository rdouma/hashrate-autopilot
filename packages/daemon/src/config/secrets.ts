/**
 * Secrets loader.
 *
 * Reads a YAML file, transparently decrypts it with sops if needed, parses
 * it, and validates against {@link SecretsSchema}. See architecture §7.
 *
 * Two shapes are accepted:
 *
 *   - **sops-encrypted** (production): file has a top-level `sops:` key with
 *     encryption metadata. We shell out to the `sops` CLI to decrypt.
 *   - **plaintext** (tests, first-run scratch files): file is a regular YAML
 *     file; we parse it directly.
 *
 * Decryption runs exactly once at startup; decrypted values are held in
 * memory by the caller. Never written back to disk in the clear.
 */

import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import { ConfigError } from './errors.js';
import { SecretsSchema, type Secrets } from './schema.js';

export interface LoadSecretsOptions {
  /**
   * Override the sops CLI path. Defaults to looking up `sops` on PATH.
   * Useful for tests or for pinning an exact binary in production.
   */
  readonly sopsBin?: string;

  /**
   * Environment passed to the sops child process. Defaults to
   * `process.env`. The age key location is typically read from
   * `SOPS_AGE_KEY_FILE` - add it here if it's not already in the daemon's
   * environment.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Load and validate the secrets file at `path`.
 *
 * Throws {@link ConfigError} with a specific `code` for each failure mode.
 */
export async function loadSecrets(path: string, options: LoadSecretsOptions = {}): Promise<Secrets> {
  await assertReadable(path);

  const raw = await readFile(path, 'utf8');
  const plaintext = isSopsEncrypted(raw) ? await sopsDecrypt(path, options) : raw;

  let parsed: unknown;
  try {
    parsed = parseYaml(plaintext);
  } catch (err) {
    throw new ConfigError(
      'YAML_PARSE_FAILED',
      path,
      `Failed to parse YAML after decrypt: ${(err as Error).message}`,
    );
  }

  const result = SecretsSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      'SCHEMA_VALIDATION_FAILED',
      path,
      'Secrets file failed schema validation',
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Cheap content-based detection: sops-encrypted YAML files carry a top-level
 * `sops:` mapping with metadata. We look for that marker before invoking the
 * CLI. This is not security-sensitive - if we guess wrong we get a clear
 * downstream error.
 */
export function isSopsEncrypted(yamlText: string): boolean {
  // The mapping key appears on its own line at column 0. Anchor to
  // start-of-line to avoid false positives inside values.
  return /^sops:\s*$/m.test(yamlText);
}

async function assertReadable(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    throw new ConfigError(
      'FILE_NOT_FOUND',
      path,
      `Secrets file not found at ${path}. Run the setup CLI to create it.`,
    );
  }
}

async function sopsDecrypt(path: string, options: LoadSecretsOptions): Promise<string> {
  const bin = options.sopsBin ?? 'sops';
  const env = options.env ?? process.env;
  const result = spawnSync(bin, ['-d', path], {
    encoding: 'utf8',
    env,
    // Capture both streams so failures include sops' own error message.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new ConfigError(
      'SOPS_NOT_INSTALLED',
      path,
      'The sops CLI was not found on PATH. Install with `brew install sops`.',
    );
  }
  if (result.status !== 0) {
    throw new ConfigError(
      'SOPS_DECRYPT_FAILED',
      path,
      `sops -d failed (exit ${result.status ?? 'null'})`,
      result.stderr?.trim(),
    );
  }
  return result.stdout;
}

function formatZodIssues(err: import('zod').ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n');
}
