/**
 * SQLite connection + Kysely wiring.
 *
 * - Opens better-sqlite3 in WAL mode (concurrent reads, single writer).
 * - Applies the bundled migrations from ./migrations/*.sql on open.
 * - Returns a typed {@link Kysely} instance backed by the opened connection.
 *
 * The daemon opens exactly one Database; repository classes take it as a
 * constructor argument. Close via `closeDatabase(handle)` on shutdown.
 */

import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMigrations, type MigrationRunResult } from './migrations/index.js';
import type { Database } from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(MODULE_DIR, 'migrations');

export interface OpenDatabaseOptions {
  /**
   * Filesystem path to the SQLite file. Pass `':memory:'` for ephemeral
   * in-memory DBs (useful in tests).
   */
  readonly path: string;

  /**
   * Override the migrations directory. Defaults to the bundled
   * `./migrations/*.sql`.
   */
  readonly migrationsDir?: string;

  /**
   * Enable verbose statement logging via better-sqlite3's `verbose` hook.
   * Pass a console.log-like fn. Off by default.
   */
  readonly verbose?: ((msg: unknown, ...rest: unknown[]) => void) | undefined;
}

export interface DatabaseHandle {
  readonly db: Kysely<Database>;
  readonly raw: SQLite.Database;
  readonly migrations: MigrationRunResult;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<DatabaseHandle> {
  const raw = new SQLite(options.path, {
    ...(options.verbose ? { verbose: options.verbose } : {}),
  });

  // WAL for concurrent reads; foreign_keys for referential integrity when we
  // add FKs later; busy_timeout so writes wait briefly instead of failing.
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');

  const migrations = await applyMigrations(raw, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: raw }),
  });

  return { db, raw, migrations };
}

export async function closeDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.db.destroy();
  handle.raw.close();
}
