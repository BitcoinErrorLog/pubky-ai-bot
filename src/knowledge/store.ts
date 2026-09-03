import pg from "pg";
import { LOCAL_EMBED_DIM, type RetrievalResult, type SourceEntry, type SourceStatus } from "./types.js";
import { toSqlVector } from "./embed.js";

export class KnowledgeStore {
  constructor(readonly pool: pg.Pool) {}

  async upsertSource(entry: SourceEntry, modelId: string, dim: number): Promise<void> {
    const existing = await this.pool.query<{ embedding_dim: number | null }>(
      "SELECT embedding_dim FROM knowledge_sources WHERE id = $1",
      [entry.id],
    );
    const prev = existing.rows[0]?.embedding_dim ?? null;
    if (prev !== null && prev !== dim) {
      throw new Error(`dimension mismatch: source ${entry.id} is ${prev}-d, refusing ${dim}-d`);
    }
    await this.pool.query(
      `INSERT INTO knowledge_sources (
         id, product, component, kind, location, status, audience, confidentiality, owner,
         embedding_model, embedding_dim, last_ingested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET
         product = EXCLUDED.product,
         component = EXCLUDED.component,
         kind = EXCLUDED.kind,
         location = EXCLUDED.location,
         status = EXCLUDED.status,
         audience = EXCLUDED.audience,
         confidentiality = EXCLUDED.confidentiality,
         owner = EXCLUDED.owner,
         embedding_model = EXCLUDED.embedding_model,
         embedding_dim = EXCLUDED.embedding_dim,
         last_ingested_at = now()`,
      [
        entry.id,
        entry.product,
        entry.component,
        entry.kind,
        entry.location,
        entry.status,
        entry.audience,
        entry.confidentiality,
        entry.owner,
        modelId,
        dim,
      ],
    );
  }

  async getDocumentHash(sourceId: string, path: string): Promise<string | null> {
    const r = await this.pool.query<{ content_hash: string }>(
      "SELECT content_hash FROM knowledge_documents WHERE source_id = $1 AND path = $2",
      [sourceId, path],
    );
    return r.rows[0]?.content_hash ?? null;
  }

  async upsertDocument(row: {
    sourceId: string;
    path: string;
    sourceUrl: string | null;
    version: string | null;
    contentHash: string;
  }): Promise<number> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO knowledge_documents (source_id, path, source_url, version, content_hash, ingested_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (source_id, path) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         version = EXCLUDED.version,
         content_hash = EXCLUDED.content_hash,
         ingested_at = now()
       RETURNING id`,
      [row.sourceId, row.path, row.sourceUrl, row.version, row.contentHash],
    );
    return Number(r.rows[0].id);
  }

  async replaceChunks(
    documentId: number,
    chunks: Array<{ content: string; ordinal: number; hash: string; embedding: number[]; metadata: unknown }>,
  ): Promise<void> {
    await this.pool.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [documentId]);
    for (const c of chunks) {
      if (c.embedding.length !== LOCAL_EMBED_DIM) {
        throw new Error(`dimension mismatch: chunk embedding ${c.embedding.length}`);
      }
      const content = c.content.replace(/\u0000/g, "");
      await this.pool.query(
        `INSERT INTO knowledge_chunks (document_id, ordinal, content, embedding, metadata, content_hash)
         VALUES ($1,$2,$3,$4::vector,$5::jsonb,$6)`,
        [documentId, c.ordinal, content, toSqlVector(c.embedding), JSON.stringify(c.metadata), c.hash],
      );
    }
  }

  async deleteMissingDocuments(sourceId: string, keepPaths: string[]): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM knowledge_documents
       WHERE source_id = $1 AND NOT (path = ANY($2::text[]))`,
      [sourceId, keepPaths],
    );
    return r.rowCount ?? 0;
  }

  async recordRefusal(sourceId: string | null, path: string, rule: string): Promise<void> {
    await this.pool.query("INSERT INTO knowledge_refusals (source_id, path, rule) VALUES ($1,$2,$3)", [
      sourceId,
      path,
      rule,
    ]);
  }

  async recordAnswerEvidence(
    mentionKey: string,
    rows: Array<{ chunkId: number; score: number; sourceUrl: string | null; product: string; status: string }>,
  ): Promise<void> {
    await this.pool.query("DELETE FROM knowledge_answer_evidence WHERE mention_key = $1", [mentionKey]);
    for (const row of rows) {
      await this.pool.query(
        `INSERT INTO knowledge_answer_evidence (mention_key, chunk_id, score, source_url, product, status)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [mentionKey, row.chunkId, row.score, row.sourceUrl, row.product, row.status],
      );
    }
  }

  async hybridSearch(opts: {
    query: string;
    queryEmbedding: number[];
    product?: string;
    status?: string;
    audience?: string;
    historical: boolean;
    k: number;
    perSourceCap: number;
  }): Promise<RetrievalResult> {
    const lexical = await this.pool.query<{
      id: string;
      content: string;
      source_url: string | null;
      product: string;
      component: string;
      status: string;
      version: string | null;
      source_id: string;
      rank: string;
    }>(
      `SELECT c.id, c.content, d.source_url, s.product, s.component, s.status, d.version, s.id AS source_id,
              ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1))::text AS rank
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       JOIN knowledge_sources s ON s.id = d.source_id
       WHERE c.tsv @@ websearch_to_tsquery('english', $1)
         AND ($2::text IS NULL OR s.product = $2)
         AND ($3::text IS NULL OR s.status = $3)
         AND ($4::text IS NULL OR s.audience = $4)
       ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) DESC
       LIMIT 50`,
      [opts.query, opts.product ?? null, opts.status ?? null, opts.audience ?? null],
    );

    const vector = await this.pool.query<{
      id: string;
      content: string;
      source_url: string | null;
      product: string;
      component: string;
      status: string;
      version: string | null;
      source_id: string;
      dist: string;
    }>(
      `SELECT c.id, c.content, d.source_url, s.product, s.component, s.status, d.version, s.id AS source_id,
              (c.embedding <=> $1::vector)::text AS dist
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       JOIN knowledge_sources s ON s.id = d.source_id
       WHERE c.embedding IS NOT NULL
         AND ($2::text IS NULL OR s.product = $2)
         AND ($3::text IS NULL OR s.status = $3)
         AND ($4::text IS NULL OR s.audience = $4)
       ORDER BY c.embedding <=> $1::vector
       LIMIT 50`,
      [toSqlVector(opts.queryEmbedding), opts.product ?? null, opts.status ?? null, opts.audience ?? null],
    );

    const rrfK = 60;
    const scores = new Map<
      number,
      {
        id: number;
        content: string;
        source_url: string | null;
        product: string;
        component: string;
        status: SourceStatus;
        version: string | null;
        source_id: string;
        score: number;
      }
    >();
    const add = (
      row: {
        id: string;
        content: string;
        source_url: string | null;
        product: string;
        component: string;
        status: string;
        version: string | null;
        source_id: string;
      },
      rank: number,
    ) => {
      const id = Number(row.id);
      const prev = scores.get(id);
      const addend = 1 / (rrfK + rank);
      if (prev) {
        prev.score += addend;
      } else {
        scores.set(id, {
          id,
          content: row.content,
          source_url: row.source_url,
          product: row.product,
          component: row.component,
          status: row.status as SourceStatus,
          version: row.version,
          source_id: row.source_id,
          score: addend,
        });
      }
    };
    lexical.rows.forEach((row, i) => add(row, i + 1));
    vector.rows.forEach((row, i) => add(row, i + 1));

    const weighted = [...scores.values()].map((row) => ({
      ...row,
      score: row.score * statusWeight(row.status, opts.historical),
    }));
    weighted.sort((a, b) => b.score - a.score);

    const capped: typeof weighted = [];
    const perSource = new Map<string, number>();
    for (const row of weighted) {
      const n = perSource.get(row.source_id) ?? 0;
      if (n >= opts.perSourceCap) continue;
      perSource.set(row.source_id, n + 1);
      capped.push(row);
    }
    const truncated = capped.length > opts.k;
    const top = capped.slice(0, opts.k);
    return {
      chunks: top.map((c) => ({
        id: c.id,
        content: c.content,
        source_url: c.source_url,
        product: c.product,
        component: c.component,
        status: c.status,
        version: c.version,
        score: c.score,
      })),
      truncated,
    };
  }
}

function statusWeight(status: SourceStatus, historical: boolean): number {
  const current: Record<SourceStatus, number> = {
    canonical: 1.15,
    released: 1.1,
    proposal: 0.85,
    opinion: 0.7,
    deprecated: 0.45,
    historical: 0.4,
  };
  const hist: Record<SourceStatus, number> = {
    historical: 1.2,
    deprecated: 1.1,
    canonical: 0.7,
    released: 0.7,
    proposal: 0.6,
    opinion: 0.65,
  };
  return historical ? hist[status] : current[status];
}

export const HISTORICAL_CUES = /\b(used to|originally|history|historical|deprecated|slashtags|used to be)\b/i;

export function isHistoricalQuery(query: string): boolean {
  return HISTORICAL_CUES.test(query);
}
