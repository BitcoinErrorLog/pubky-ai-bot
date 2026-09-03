-- Jeb Stage 1 schema (Postgres only)

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursor_state (
  bot_id TEXT NOT NULL,
  nexus_url TEXT NOT NULL,
  last_ts BIGINT NOT NULL DEFAULT 0,
  first_boot_done BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (bot_id, nexus_url)
);

CREATE TABLE IF NOT EXISTS handled_mentions (
  mention_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reply_uri TEXT,
  root_uri TEXT,
  author TEXT,
  bot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kill_switch (
  id INT PRIMARY KEY DEFAULT 1,
  disabled BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO kill_switch (id, disabled) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS switches (
  name TEXT PRIMARY KEY,
  on_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blacklist (
  public_key TEXT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  public_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_pk_time ON rate_limit_events (public_key, occurred_at);

CREATE TABLE IF NOT EXISTS token_usage (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  meta_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_pubkey_created ON token_usage (public_key, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at);

CREATE TABLE IF NOT EXISTS work_queue (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_queue_status ON work_queue (status, id);

CREATE TABLE IF NOT EXISTS evidence (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL,
  intent TEXT NOT NULL,
  tool_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  tokens INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publish_requests (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL UNIQUE,
  parent_uri TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence_id BIGINT REFERENCES evidence (id),
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fail_first_attempt BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_publish_requests_status ON publish_requests (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS routing_audit (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL,
  intent TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
