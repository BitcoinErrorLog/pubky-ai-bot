-- Scout query attribution and budgets

CREATE TABLE IF NOT EXISTS scout_queries (
  id BIGSERIAL PRIMARY KEY,
  tool TEXT NOT NULL,
  cypher_hash TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  rows INTEGER,
  truncated BOOLEAN,
  duration_ms INTEGER NOT NULL,
  ok BOOLEAN NOT NULL,
  error_code TEXT,
  mention_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scout_queries_created ON scout_queries (created_at);
CREATE INDEX IF NOT EXISTS idx_scout_queries_mention ON scout_queries (mention_key, created_at);
CREATE INDEX IF NOT EXISTS idx_scout_queries_tool_created ON scout_queries (tool, created_at);
