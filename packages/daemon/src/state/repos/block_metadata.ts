/**
 * Repository for `block_metadata` — per-block-hash enrichment cache
 * populated from mempool.space (or a compatible local instance) and
 * surfaced on the Hashrate chart's block-marker tooltips.
 *
 * Blocks are immutable, so `upsert` is write-once in practice; the
 * table exists mainly to avoid re-fetching across daemon restarts and
 * to keep the Ocean route fast (no blocking HTTP on each /api/ocean).
 */

import type { Kysely, Selectable } from 'kysely';

import type { BlockMetadataTable, Database } from '../types.js';

export type BlockMetadataRow = Selectable<BlockMetadataTable>;

export interface BlockMetadataUpsert {
  readonly block_hash: string;
  readonly pool_name: string | null;
  readonly miner_tag: string | null;
  readonly fetched_at: number;
}

export class BlockMetadataRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async get(block_hash: string): Promise<BlockMetadataRow | null> {
    const row = await this.db
      .selectFrom('block_metadata')
      .selectAll()
      .where('block_hash', '=', block_hash)
      .executeTakeFirst();
    return row ?? null;
  }

  async getMany(block_hashes: readonly string[]): Promise<Map<string, BlockMetadataRow>> {
    if (block_hashes.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('block_metadata')
      .selectAll()
      .where('block_hash', 'in', block_hashes as string[])
      .execute();
    const out = new Map<string, BlockMetadataRow>();
    for (const r of rows) out.set(r.block_hash, r);
    return out;
  }

  async upsert(args: BlockMetadataUpsert): Promise<void> {
    await this.db
      .insertInto('block_metadata')
      .values(args)
      .onConflict((oc) =>
        oc.column('block_hash').doUpdateSet({
          pool_name: args.pool_name,
          miner_tag: args.miner_tag,
          fetched_at: args.fetched_at,
        }),
      )
      .execute();
  }
}
