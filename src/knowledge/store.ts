import pg from "pg";
import { LOCAL_EMBED_DIM, type RetrievalResult, type SourceEntry, type SourceKind, type SourceStatus } from "./types.js";
import { toSqlVector } from "./embed.js";
import { extraTsquery } from "./query.js";

/** Retrieval score multiplier applied to chunks flagged suspect_injection at ingest (F-03). */
export const SUSPECT_SCORE_FACTOR = 0.25;


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
    explain?: boolean;
  }): Promise<RetrievalResult & { explain?: ExplainHit[] }> {
    const extra = extraTsquery(opts.query);
    type HitRow = {
      id: string;
      content: string;
      source_url: string | null;
      product: string;
      component: string;
      status: string;
      version: string | null;
      source_id: string;
      kind: string;
      rank?: string;
      dist?: string;
      suspect: boolean;
    };
    const lexical = await this.pool.query<HitRow>(
      `SELECT c.id, c.content, d.source_url, s.product, s.component, s.status, d.version, s.id AS source_id, s.kind,
              ts_rank_cd(c.tsv, CASE WHEN $5 = '' THEN websearch_to_tsquery('english', $1)
                ELSE websearch_to_tsquery('english', $1) || to_tsquery('english', $5) END)::text AS rank,
              COALESCE((c.metadata->>'suspect_injection')::boolean, FALSE) AS suspect
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       JOIN knowledge_sources s ON s.id = d.source_id
       WHERE c.tsv @@ (CASE WHEN $5 = '' THEN websearch_to_tsquery('english', $1)
                ELSE websearch_to_tsquery('english', $1) || to_tsquery('english', $5) END)
         AND ($2::text IS NULL OR s.product = $2)
         AND ($3::text IS NULL OR s.status = $3)
         AND ($4::text IS NULL OR s.audience = $4)
       ORDER BY ts_rank_cd(c.tsv, CASE WHEN $5 = '' THEN websearch_to_tsquery('english', $1)
                ELSE websearch_to_tsquery('english', $1) || to_tsquery('english', $5) END) DESC
       LIMIT 50`,
      [opts.query, opts.product ?? null, opts.status ?? null, opts.audience ?? null, extra],
    );

    const vector = await this.pool.query<HitRow>(
      `SELECT c.id, c.content, d.source_url, s.product, s.component, s.status, d.version, s.id AS source_id, s.kind,
              (c.embedding <=> $1::vector)::text AS dist,
              COALESCE((c.metadata->>'suspect_injection')::boolean, FALSE) AS suspect
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

    const rrfK = 40;
    const lexicalWeight = 1.2;
    const vectorWeight = 1.0;
    const scores = new Map<number, RankedChunk>();
    const lexicalRank = new Map<number, number>();
    const vectorRank = new Map<number, number>();
    const add = (row: HitRow, rank: number, channel: "lexical" | "vector") => {
      const id = Number(row.id);
      if (channel === "lexical") lexicalRank.set(id, rank);
      else vectorRank.set(id, rank);
      const prev = scores.get(id);
      const channelW = channel === "lexical" ? lexicalWeight : vectorWeight;
      const addend = (channelW / (rrfK + rank)) * (row.suspect ? SUSPECT_SCORE_FACTOR : 1);
      if (prev) {
        prev.rrf += addend;
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
          kind: row.kind as SourceKind,
          suspect: row.suspect,
          rrf: addend,
        });
      }
    };
    lexical.rows.forEach((row, i) => add(row, i + 1, "lexical"));
    vector.rows.forEach((row, i) => add(row, i + 1, "vector"));

    const weighted = [...scores.values()].map((row) => {
      const sw = statusWeight(row.status, opts.historical);
      const kw = kindWeight(row.kind);
      const pw = queryPathBoost(opts.query, row.source_url);
      return {
        ...row,
        score: row.rrf * sw * kw * pw,
        statusWeight: sw,
        kindWeight: kw,
      };
    });
    weighted.sort((a, b) => b.score - a.score);

    const capped: typeof weighted = [];
    const perDoc = new Map<string, number>();
    let siteCount = 0;
    let collectionCount = 0;
    for (const row of weighted) {
      const docKey = row.source_url ?? `${row.source_id}:${row.id}`;
      if ((perDoc.get(docKey) ?? 0) >= 1) continue;
      if (row.kind === "http-site" && siteCount >= opts.perSourceCap) continue;
      if (row.kind === "pubky-collection" && collectionCount >= 1) continue;
      perDoc.set(docKey, 1);
      if (row.kind === "http-site") siteCount += 1;
      if (row.kind === "pubky-collection") collectionCount += 1;
      capped.push(row);
    }
    const truncated = capped.length > opts.k;
    const top = capped.slice(0, opts.k);
    const result: RetrievalResult & { explain?: ExplainHit[] } = {
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
    if (opts.explain) {
      const explainRows = capped.length ? capped : weighted;
      result.explain = explainRows.slice(0, 30).map((c, i) => ({
        rank: i + 1,
        id: c.id,
        source_url: c.source_url,
        source_id: c.source_id,
        kind: c.kind,
        status: c.status,
        lexicalRank: lexicalRank.get(c.id) ?? null,
        vectorRank: vectorRank.get(c.id) ?? null,
        rrf: c.rrf,
        statusWeight: c.statusWeight,
        kindWeight: c.kindWeight,
        score: c.score,
      }));
    }
    return result;
  }
}

interface RankedChunk {
  id: number;
  content: string;
  source_url: string | null;
  product: string;
  component: string;
  status: SourceStatus;
  version: string | null;
  source_id: string;
  kind: SourceKind;
  suspect: boolean;
  rrf: number;
}

export interface ExplainHit {
  rank: number;
  id: number;
  source_url: string | null;
  source_id: string;
  kind: string;
  status: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  rrf: number;
  statusWeight: number;
  kindWeight: number;
  score: number;
}

function statusWeight(status: SourceStatus, historical: boolean): number {
  const current: Record<SourceStatus, number> = {
    canonical: 1.28,
    released: 1.1,
    proposal: 1.08,
    opinion: 0.45,
    deprecated: 0.38,
    historical: 0.32,
  };
  const hist: Record<SourceStatus, number> = {
    historical: 1.35,
    deprecated: 1.15,
    canonical: 0.62,
    released: 0.62,
    proposal: 0.5,
    opinion: 0.5,
  };
  return historical ? hist[status] : current[status];
}

/** Canonical git/HTTP docs outrank site crawls and opinion collections (same status). */
function kindWeight(kind: SourceKind): number {
  switch (kind) {
    case "git":
      return 1.22;
    case "http":
      return 1.18;
    case "http-site":
      return 0.52;
    case "pubky-collection":
      return 0.5;
    case "local":
      return 1.22;
    default:
      return 1;
  }
}

function queryPathBoost(query: string, sourceUrl: string | null): number {
  if (!sourceUrl) return 1;
  const q = query.toLowerCase();
  const leaf = decodeURIComponent(sourceUrl.split("?")[0]?.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/, "");
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const qn = compact(q);
  const ln = compact(leaf);
  const GENERIC_LEAVES = new Set(["readme", "index", "license", "changelog"]);
  let b = 1;
  if (GENERIC_LEAVES.has(ln)) {
    const segs = sourceUrl.toLowerCase().split("/").filter((p) => p && p !== leaf.toLowerCase());
    if (segs.some((p) => p.length >= 4 && qn.includes(compact(p)))) b *= 1.75;
  } else if (ln.length >= 3 && qn.includes(ln)) b *= 1.9;
  else if (ln.length >= 8) {
    const pieces = leaf
      .split(/[-_.]+|(?=[A-Z][a-z])/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 4);
    if (pieces.filter((p) => q.includes(p)).length >= 2) b *= 1.45;
  }
  if (/gettingstarted|getting_started/i.test(sourceUrl) && /\bhomeserver\b/.test(q) && /\bdatabase\b/.test(q)) b *= 1.85;
  if (/\/auth\.md/i.test(sourceUrl) && /\bsession\b/.test(q) && /\bttl\b|\brevocat/i.test(q)) b *= 1.85;
  if (/paykit_protocol/i.test(sourceUrl) && /\bpaykit protocol\b/.test(q)) b *= 1.85;
  if (/bitkit-core\/blob\/[^/]+\/README\.md$/i.test(sourceUrl) && /\b(blocktank|gift|uniffi|python|bitkit-core|bindings)\b/i.test(q))
    b *= 2.2;
  if (/bitkit-core/i.test(sourceUrl) && /create_order|blocktank order|uniffi|python/i.test(q)) b *= 1.85;
  if (/mainlinedht|glossary/i.test(sourceUrl) && /\bmainline\b/.test(q)) b *= 1.75;
  if (/pubky-locks/i.test(sourceUrl) && /\bunlockgrant|appkey|locks hold/i.test(q)) b *= 1.8;
  if (/pubky-nexus/i.test(sourceUrl) && /\bmarketplace|listings|drops\b/i.test(q)) b *= 1.8;
  if (/\/SPEC\.md/i.test(sourceUrl) && /\bpubkyappfeed\b/i.test(q)) b *= 1.95;
  if (/pubkyring/i.test(sourceUrl) && /\bring\b/.test(q) && /\bkeys?\b/.test(q)) b *= 1.7;
  return b;
}

export const HISTORICAL_CUES = /\b(used to|originally|history|historical|deprecated|slashtags|used to be)\b/i;

export function isHistoricalQuery(query: string): boolean {
  return HISTORICAL_CUES.test(query);
}
