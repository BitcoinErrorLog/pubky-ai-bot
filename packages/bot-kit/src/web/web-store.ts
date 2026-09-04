import type { Queryable } from "../queue/ingest-store.js";

export type { Queryable };

export type WebQueryInsert = {
  provider: string;
  queryHash: string;
  ok: boolean;
  sourcesCount: number;
  durationMs: number;
  mentionKey?: string | null;
};

/**
 * Queue subset for `web_queries` audit rows. Jeb's Store implements this;
 * SQL lives here so Kit never inlines the insert.
 */
export interface WebStore {
  insertWebQuery(row: WebQueryInsert): Promise<void>;
}

export async function insertWebQuery(db: Queryable, row: WebQueryInsert): Promise<void> {
  await db.query(
    `INSERT INTO web_queries (provider, query_hash, ok, sources_count, duration_ms, mention_key)
       VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.provider, row.queryHash, row.ok, row.sourcesCount, row.durationMs, row.mentionKey ?? null],
  );
}
