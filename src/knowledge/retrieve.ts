import type { Embedder } from "./embed.js";
import { embeddingQuery } from "./query.js";
import { isHistoricalQuery, KnowledgeStore, type ExplainHit } from "./store.js";
import type { RetrievalResult } from "./types.js";

export async function retrieveKnowledge(
  store: KnowledgeStore,
  embedder: Embedder,
  query: string,
  filters?: { product?: string; status?: string; audience?: string; k?: number; explain?: boolean },
): Promise<RetrievalResult & { explain?: ExplainHit[] }> {
  const q = query.trim();
  if (!q) return { chunks: [], truncated: false };
  const [vec] = await embedder.embed([embeddingQuery(q)]);
  const k = filters?.k ?? 8;
  return store.hybridSearch({
    query: q,
    queryEmbedding: vec,
    product: filters?.product,
    status: filters?.status,
    audience: filters?.audience,
    historical: isHistoricalQuery(q),
    k,
    perSourceCap: 2,
    explain: filters?.explain,
  });
}

export function publicRetrievalPayload(result: RetrievalResult): {
  chunks: Array<{
    content: string;
    source_url: string | null;
    product: string;
    component: string;
    status: string;
    version: string | null;
    score: number;
  }>;
  truncated: boolean;
} {
  return {
    chunks: result.chunks.map((c) => ({
      content: c.content,
      source_url: c.source_url,
      product: c.product,
      component: c.component,
      status: c.status,
      version: c.version,
      score: c.score,
    })),
    truncated: result.truncated,
  };
}
