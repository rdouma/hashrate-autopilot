/**
 * Minimal forward-only migration runner.
 *
 * - Reads `*.sql` files from a directory, applies them in filename order.
 * - Records applied migrations in `_migrations` so re-runs are no-ops.
 * - Each migration runs inside a transaction; a failure leaves the DB
 *   exactly as it was before the migration started.
 */

import type Database from 'better-sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MigrationRunResult {
  readonly applied: string[];
  readonly skipped: string[];
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);
}

function listAppliedMigrations(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export async function applyMigrations(
  db: Database.Database,
  dir: string,
): Promise<MigrationRunResult> {
  ensureMigrationsTable(db);

  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const already = listAppliedMigrations(db);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    const insertRecord = db.prepare(
      'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      db.exec(sql);
      insertRecord.run(file, Date.now());
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}
