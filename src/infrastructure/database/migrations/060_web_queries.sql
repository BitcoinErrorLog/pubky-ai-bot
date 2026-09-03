-- Web search attribution. Query text is never stored — only its hash.

CREATE TABLE IF NOT EXISTS web_queries (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  sources_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  mention_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_queries_created ON web_queries (created_at);
CREATE INDEX IF NOT EXISTS idx_web_queries_mention ON web_queries (mention_key, created_at);
