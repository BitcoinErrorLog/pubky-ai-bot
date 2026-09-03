import type pg from "pg";
import { KnowledgeStore } from "./store.js";
import type { RetrievalResult } from "./types.js";

export async function persistKnowledgeEvidence(
  pool: pg.Pool,
  mentionKey: string,
  result: RetrievalResult | null,
): Promise<void> {
  if (!result) return;
  const store = new KnowledgeStore(pool);
  await store.recordAnswerEvidence(
    mentionKey,
    result.chunks.map((c) => ({
      chunkId: c.id,
      score: c.score,
      sourceUrl: c.source_url,
      product: c.product,
      status: c.status,
    })),
  );
}

export function lastRetrievalBinder(): {
  set: (r: RetrievalResult) => void;
  take: () => RetrievalResult | null;
} {
  let last: RetrievalResult | null = null;
  return {
    set: (r) => {
      last = r;
    },
    take: () => last,
  };
}
