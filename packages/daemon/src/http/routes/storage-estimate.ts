/**
 * GET /api/storage-estimate
 *
 * Per-bucket disk-usage anchors for the Log retention panel: rows-per-day
 * (sampled from the last 7 days) and bytes-per-row (sampled from recent
 * rows for decisions, schema-derived constant for tick_metrics). The
 * dashboard multiplies these by the configured retention days to show
 * a per-knob "approx max storage" hint next to each retention input.
 *
 * Excludes index overhead and SQLite per-page padding, so the projection
 * is a planning aid, not a guarantee. Cached for 60s; the rates and
 * sample sizes do not move fast.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../state/types.js';

const CACHE_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_DAYS = 7;

/**
 * tick_metrics is mostly numeric (~24 INTEGER/REAL columns + a few
 * shorts). SQLite stores nullable INTEGER as 1-9 byte varint and REAL
 * as 8 bytes, plus a small per-row header. 160 bytes is a conservative
 * empirical anchor that overestimates very slightly so the projection
 * stays a cap, not an under-read. (Confirmed against a 525k-row DB
 * after migration 0051: ~78 MB total / 525k = ~149 B/row including
 * indexes.)
 */
const TICK_METRICS_BYTES_PER_ROW = 160;

/**
 * Decisions row has four text columns (observed/proposed/gated/executed
 * JSON), tick_at INTEGER, run_mode TEXT, action_mode TEXT, id INTEGER.
 * Beyond the four JSON payloads (which we sample with LENGTH()) the
 * fixed columns cost ~80 bytes total including the row header.
 */
const DECISIONS_OVERHEAD_BYTES = 80;

/** Fallback bytes-per-row when there are no recent samples. */
const DECISIONS_UNEVENTFUL_FALLBACK_BYTES = 1500;
const DECISIONS_EVENTFUL_FALLBACK_BYTES = 3000;

export interface StorageEstimateBucket {
  readonly rows_per_day: number;
  readonly bytes_per_row: number;
  readonly current_rows: number;
}

export interface StorageEstimateResponse {
  readonly tick_metrics: StorageEstimateBucket;
  readonly decisions_uneventful: StorageEstimateBucket;
  readonly decisions_eventful: StorageEstimateBucket;
  /** Total SQLite file size at the moment of the call, or null if not available. */
  readonly db_file_bytes: number | null;
  /** Sample window the rates were measured over, in days. */
  readonly sample_days: number;
  readonly computed_at: number;
}

interface CacheEntry {
  data: StorageEstimateResponse;
  fetched_at: number;
}

export interface StorageEstimateDeps {
  readonly db: Kysely<Database>;
}

export async function registerStorageEstimateRoute(
  app: FastifyInstance,
  deps: StorageEstimateDeps,
): Promise<void> {
  let cache: CacheEntry | null = null;

  app.get('/api/storage-estimate', async (): Promise<StorageEstimateResponse> => {
    const now = Date.now();
    if (cache && now - cache.fetched_at < CACHE_TTL_MS) {
      return cache.data;
    }
    const data = await computeStorageEstimate(deps.db, now);
    cache = { data, fetched_at: now };
    return data;
  });
}

async function computeStorageEstimate(
  db: Kysely<Database>,
  now: number,
): Promise<StorageEstimateResponse> {
  const sampleSinceMs = now - SAMPLE_DAYS * DAY_MS;

  // tick_metrics: rate from a 7-day count, size from the schema constant.
  const tickMetricsRecent = await sql<{ rows: number }>`
    SELECT COUNT(*) AS rows FROM tick_metrics WHERE tick_at >= ${sampleSinceMs}
  `.execute(db);
  const tickMetricsTotal = await sql<{ rows: number }>`
    SELECT COUNT(*) AS rows FROM tick_metrics
  `.execute(db);
  const tickMetricsRowsPerDay =
    Number(tickMetricsRecent.rows[0]?.rows ?? 0) / SAMPLE_DAYS;

  // decisions: split eventful (proposed_json != '[]') vs uneventful and
  // sample bytes-per-row from the same 7-day window.
  const decisionsSplit = await sql<{
    unev_rows: number;
    ev_rows: number;
    unev_bytes_avg: number | null;
    ev_bytes_avg: number | null;
  }>`
    SELECT
      SUM(CASE WHEN proposed_json = '[]' THEN 1 ELSE 0 END) AS unev_rows,
      SUM(CASE WHEN proposed_json != '[]' THEN 1 ELSE 0 END) AS ev_rows,
      AVG(CASE WHEN proposed_json = '[]'
            THEN LENGTH(observed_json) + LENGTH(proposed_json)
              + LENGTH(gated_json) + LENGTH(executed_json)
          END) AS unev_bytes_avg,
      AVG(CASE WHEN proposed_json != '[]'
            THEN LENGTH(observed_json) + LENGTH(proposed_json)
              + LENGTH(gated_json) + LENGTH(executed_json)
          END) AS ev_bytes_avg
    FROM decisions
    WHERE tick_at >= ${sampleSinceMs}
  `.execute(db);
  const ds = decisionsSplit.rows[0];

  const unevBytesPerRow = ds?.unev_bytes_avg
    ? Math.round(Number(ds.unev_bytes_avg) + DECISIONS_OVERHEAD_BYTES)
    : DECISIONS_UNEVENTFUL_FALLBACK_BYTES;
  const evBytesPerRow = ds?.ev_bytes_avg
    ? Math.round(Number(ds.ev_bytes_avg) + DECISIONS_OVERHEAD_BYTES)
    : DECISIONS_EVENTFUL_FALLBACK_BYTES;
  const unevRowsPerDay = Number(ds?.unev_rows ?? 0) / SAMPLE_DAYS;
  const evRowsPerDay = Number(ds?.ev_rows ?? 0) / SAMPLE_DAYS;

  const decisionsTotal = await sql<{ unev: number; ev: number }>`
    SELECT
      SUM(CASE WHEN proposed_json = '[]' THEN 1 ELSE 0 END) AS unev,
      SUM(CASE WHEN proposed_json != '[]' THEN 1 ELSE 0 END) AS ev
    FROM decisions
  `.execute(db);
  const dt = decisionsTotal.rows[0];

  // db file size - best effort. Wrapped in try/catch because the
  // table-valued pragma form (`pragma_page_count()`) is only available
  // when SQLite was compiled with SQLITE_ENABLE_PRAGMA_FUNCTIONS, which
  // is the default for better-sqlite3 but not strictly guaranteed.
  let dbFileBytes: number | null = null;
  try {
    const pageRes = await sql<{ page_count: number; page_size: number }>`
      SELECT
        (SELECT page_count FROM pragma_page_count()) AS page_count,
        (SELECT page_size FROM pragma_page_size()) AS page_size
    `.execute(db);
    const pr = pageRes.rows[0];
    if (pr) {
      dbFileBytes = Number(pr.page_count) * Number(pr.page_size);
    }
  } catch {
    /* pragma functions not available; leave null. */
  }

  return {
    tick_metrics: {
      rows_per_day: Math.round(tickMetricsRowsPerDay),
      bytes_per_row: TICK_METRICS_BYTES_PER_ROW,
      current_rows: Number(tickMetricsTotal.rows[0]?.rows ?? 0),
    },
    decisions_uneventful: {
      rows_per_day: Math.round(unevRowsPerDay),
      bytes_per_row: unevBytesPerRow,
      current_rows: Number(dt?.unev ?? 0),
    },
    decisions_eventful: {
      rows_per_day: Math.round(evRowsPerDay),
      bytes_per_row: evBytesPerRow,
      current_rows: Number(dt?.ev ?? 0),
    },
    db_file_bytes: dbFileBytes,
    sample_days: SAMPLE_DAYS,
    computed_at: now,
  };
}
