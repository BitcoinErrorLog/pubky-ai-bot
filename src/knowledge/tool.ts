import pg from "pg";
import { searchKnowledgeParameters } from "../tools.js";
import { embedderFromEnv } from "./embed.js";
import { lastRetrievalBinder, persistKnowledgeEvidence } from "./evidence.js";
import { publicRetrievalPayload, retrieveKnowledge } from "./retrieve.js";
import { KnowledgeStore } from "./store.js";
import type { z } from "zod";

export type SearchKnowledgeArgs = z.infer<typeof searchKnowledgeParameters>;

export function createSearchKnowledgeExecute(
  databaseUrl: string | undefined,
  mentionKey?: string,
  binder = lastRetrievalBinder(),
): {
  execute: (args: SearchKnowledgeArgs) => Promise<ReturnType<typeof publicRetrievalPayload>>;
  binder: ReturnType<typeof lastRetrievalBinder>;
} {
  const execute = async (args: SearchKnowledgeArgs) => {
    if (!databaseUrl) throw new Error("DATABASE_URL required for search_knowledge");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    try {
      const store = new KnowledgeStore(pool);
      const embedder = embedderFromEnv();
      const result = await retrieveKnowledge(store, embedder, args.query, {
        product: args.product,
        status: args.status,
        k: args.k,
      });
      binder.set(result);
      if (mentionKey) await persistKnowledgeEvidence(pool, mentionKey, result);
      return publicRetrievalPayload(result);
    } finally {
      await pool.end();
    }
  };
  return { execute, binder };
}
