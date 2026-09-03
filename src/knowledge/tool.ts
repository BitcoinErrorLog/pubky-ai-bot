import pg from "pg";
import { searchKnowledgeParameters } from "../tools.js";
import { embedderFromEnv } from "./embed.js";
import { lastRetrievalBinder, persistKnowledgeEvidence } from "./evidence.js";
import { publicRetrievalPayload, retrieveKnowledge } from "./retrieve.js";
import { KnowledgeStore } from "./store.js";
import type { z } from "zod";

export type SearchKnowledgeArgs = z.infer<typeof searchKnowledgeParameters>;

/**
 * Executes the search_knowledge tool. Pass the reasoner pool via `pool` so a
 * fresh pg.Pool is not opened per call; `databaseUrl` is the standalone
 * fallback (eval scripts) and opens a per-call pool that is closed after use.
 */
export function createSearchKnowledgeExecute(
  opts: { pool?: pg.Pool; databaseUrl?: string; mentionKey?: string },
  binder = lastRetrievalBinder(),
): {
  execute: (args: SearchKnowledgeArgs) => Promise<ReturnType<typeof publicRetrievalPayload>>;
  binder: ReturnType<typeof lastRetrievalBinder>;
} {
  const execute = async (args: SearchKnowledgeArgs) => {
    if (!opts.pool && !opts.databaseUrl) throw new Error("DATABASE_URL required for search_knowledge");
    const ownPool = opts.pool ? null : new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
    const pool = opts.pool ?? ownPool!;
    try {
      const store = new KnowledgeStore(pool);
      const embedder = embedderFromEnv();
      const result = await retrieveKnowledge(store, embedder, args.query, {
        product: args.product,
        status: args.status,
        k: args.k,
      });
      binder.set(result);
      if (opts.mentionKey) await persistKnowledgeEvidence(pool, opts.mentionKey, result);
      return publicRetrievalPayload(result);
    } finally {
      if (ownPool) await ownPool.end();
    }
  };
  return { execute, binder };
}
