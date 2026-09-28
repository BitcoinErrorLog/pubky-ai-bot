SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE persona_versions
  ADD COLUMN IF NOT EXISTS budget_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE persona_versions
  DROP CONSTRAINT IF EXISTS persona_versions_check;
ALTER TABLE persona_versions
  ADD CONSTRAINT persona_versions_check
  CHECK (
    corpus_namespace = 'global'
    OR corpus_namespace = 'persona/' || persona_id || '/' || version
  );

INSERT INTO persona_versions (
  persona_id, version, manifest_hash, profile_json, capability_json,
  budget_json, tag_json, corpus_namespace, status, reviewed_at
)
SELECT
  persona_id,
  '1.2.0',
  'a2be94e2b6f2fe1f65bc5b67f2598cebafa33e407103f7a5cbb17a0ffbeee7b0',
  profile_json,
  capability_json,
  '{"daily_tokens":5000000,"per_user_daily_tokens":600000,"web_calls_per_mention":2,"web_calls_daily":200,"scout_calls_per_mention":12,"scout_calls_daily":400,"image_tokens_daily":5000000}'::jsonb,
  tag_json,
  'global',
  'active',
  now()
FROM persona_versions
WHERE persona_id = 'jeb' AND version = '1.1.0'
ON CONFLICT (persona_id, version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM persona_versions
    WHERE persona_id = 'jeb'
      AND version = '1.2.0'
      AND manifest_hash = 'a2be94e2b6f2fe1f65bc5b67f2598cebafa33e407103f7a5cbb17a0ffbeee7b0'
      AND corpus_namespace = 'global'
      AND budget_json = '{"daily_tokens":5000000,"per_user_daily_tokens":600000,"web_calls_per_mention":2,"web_calls_daily":200,"scout_calls_per_mention":12,"scout_calls_daily":400,"image_tokens_daily":5000000}'::jsonb
  ) THEN
    RAISE EXCEPTION 'persona version 1.2.0 is missing or conflicts with the expected immutable snapshot';
  END IF;
END
$$;

UPDATE personas
SET current_version = '1.2.0',
    manifest_hash = 'a2be94e2b6f2fe1f65bc5b67f2598cebafa33e407103f7a5cbb17a0ffbeee7b0',
    updated_at = now()
WHERE id = 'jeb'
  AND EXISTS (
    SELECT 1
    FROM persona_versions
    WHERE persona_id = 'jeb'
      AND version = '1.2.0'
      AND manifest_hash = 'a2be94e2b6f2fe1f65bc5b67f2598cebafa33e407103f7a5cbb17a0ffbeee7b0'
  );
