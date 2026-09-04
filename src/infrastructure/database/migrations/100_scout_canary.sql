-- F1-style Scout write canary outcomes (read-only gateway probe).

CREATE TABLE IF NOT EXISTS scout_canary (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL,
  accepted_probe TEXT,
  consecutive_unknown INTEGER NOT NULL DEFAULT 0,
  switch_flipped BOOLEAN NOT NULL DEFAULT FALSE,
  detail JSONB,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scout_canary_ran ON scout_canary (ran_at DESC);

ALTER TABLE scout_canary
  ADD CONSTRAINT scout_canary_outcome_chk
  CHECK (outcome IN ('pass', 'fail', 'unknown'));
