-- Spend ceilings and run manifests for the resource publisher.
-- Explicit columns only: no JSON catch-all that could absorb config, env,
-- HTTP headers, or SDK error objects. Failure detail is a bounded code.

CREATE TABLE IF NOT EXISTS resource_spend_day (
  utc_day DATE NOT NULL,
  target TEXT NOT NULL,
  actual_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (actual_usd >= 0),
  reserved_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (utc_day, target)
);

CREATE TABLE IF NOT EXISTS resource_runs (
  run_id UUID PRIMARY KEY,
  target TEXT NOT NULL,
  family TEXT NOT NULL,
  config_version TEXT NOT NULL,
  pin_set_version TEXT NOT NULL,
  dist_hash TEXT NOT NULL,
  plan_sha256 TEXT,
  publisher_pk TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'overlap_refused')),
  estimated_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
  actual_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (actual_usd >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  unprocessed_count INTEGER NOT NULL DEFAULT 0,
  written_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  put_count INTEGER NOT NULL DEFAULT 0,
  delete_count INTEGER NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  failure_code TEXT
);

CREATE INDEX IF NOT EXISTS resource_runs_target_started_idx ON resource_runs (target, started_at DESC);
CREATE INDEX IF NOT EXISTS resource_runs_running_idx ON resource_runs (target, status) WHERE status = 'running';
