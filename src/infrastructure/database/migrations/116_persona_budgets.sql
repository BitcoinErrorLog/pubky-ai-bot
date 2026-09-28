SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE persona_versions
  ADD COLUMN IF NOT EXISTS budget_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS persona_budget_day (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  day DATE NOT NULL,
  tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  web_reserved INTEGER NOT NULL DEFAULT 0 CHECK (web_reserved >= 0),
  web_used INTEGER NOT NULL DEFAULT 0 CHECK (web_used >= 0),
  scout_reserved INTEGER NOT NULL DEFAULT 0 CHECK (scout_reserved >= 0),
  scout_used INTEGER NOT NULL DEFAULT 0 CHECK (scout_used >= 0),
  image_tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (image_tokens_reserved >= 0),
  image_tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (image_tokens_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, day)
);

CREATE TABLE IF NOT EXISTS persona_user_budget_day (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  public_key TEXT NOT NULL,
  day DATE NOT NULL,
  tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, public_key, day)
);

INSERT INTO persona_versions (
  persona_id, version, manifest_hash, profile_json, capability_json,
  budget_json, tag_json, corpus_namespace, status, reviewed_at
)
SELECT
  persona_id,
  '1.2.0',
  'd4d68f1b6aaff5d564e604320ea07df588536b14cc31daddbcd45b81d6ae3627',
  profile_json,
  capability_json,
  '{"daily_tokens":5000000,"per_user_daily_tokens":600000,"web_calls_per_mention":2,"web_calls_daily":200,"scout_calls_per_mention":12,"scout_calls_daily":400,"image_tokens_daily":5000000}'::jsonb,
  tag_json,
  'persona/jeb/1.2.0',
  'active',
  now()
FROM persona_versions
WHERE persona_id = 'jeb' AND version = '1.1.0'
ON CONFLICT (persona_id, version) DO NOTHING;

UPDATE personas
SET current_version = '1.2.0',
    manifest_hash = 'd4d68f1b6aaff5d564e604320ea07df588536b14cc31daddbcd45b81d6ae3627',
    updated_at = now()
WHERE id = 'jeb';
