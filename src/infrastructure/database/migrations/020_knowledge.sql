-- Jeb public knowledge index (pgvector + FTS + trigram)

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  component TEXT NOT NULL,
  kind TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL,
  audience TEXT NOT NULL,
  confidentiality TEXT NOT NULL,
  owner TEXT NOT NULL,
  embedding_model TEXT,
  embedding_dim INTEGER,
  last_ingested_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  source_url TEXT,
  version TEXT,
  content_hash TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, path)
);

CREATE INDEX IF NOT EXISTS knowledge_documents_path_trgm ON knowledge_documents USING gin (path gin_trgm_ops);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
  embedding vector(384),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_gin ON knowledge_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks (document_id);

CREATE TABLE IF NOT EXISTS knowledge_refusals (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT,
  path TEXT NOT NULL,
  rule TEXT NOT NULL,
  refused_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_answer_evidence (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL,
  chunk_id BIGINT,
  score DOUBLE PRECISION,
  source_url TEXT,
  product TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_answer_evidence_mention ON knowledge_answer_evidence (mention_key);
