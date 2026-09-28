\set ON_ERROR_STOP on

DO $$
DECLARE
  identity_count INTEGER;
  configured_bot_pk TEXT;
BEGIN
  configured_bot_pk := NULLIF(current_setting('jeb.bot_pk', TRUE), '');
  SELECT count(DISTINCT bot_id)::integer INTO identity_count
  FROM (
    SELECT bot_id FROM handled_mentions WHERE bot_id IS NOT NULL AND bot_id <> ''
    UNION ALL
    SELECT bot_id FROM cursor_state WHERE bot_id IS NOT NULL AND bot_id <> ''
  ) identities;
  IF identity_count > 1 AND configured_bot_pk IS NULL THEN
    RAISE EXCEPTION 'preflight found % historical bot identities; SET jeb.bot_pk is required', identity_count;
  END IF;
  IF configured_bot_pk IS NOT NULL AND identity_count > 0 AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT bot_id FROM handled_mentions WHERE bot_id IS NOT NULL AND bot_id <> ''
      UNION ALL
      SELECT bot_id FROM cursor_state WHERE bot_id IS NOT NULL AND bot_id <> ''
    ) identities
    WHERE bot_id = configured_bot_pk
  ) THEN
    RAISE EXCEPTION 'configured jeb.bot_pk is absent from existing identity history';
  END IF;
  IF identity_count = 0 AND configured_bot_pk IS NULL THEN
    RAISE EXCEPTION 'empty database preflight requires SET jeb.bot_pk to the deployment public key';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS persona_migration_baseline (
  table_name TEXT PRIMARY KEY,
  row_count BIGINT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

TRUNCATE persona_migration_baseline;

INSERT INTO persona_migration_baseline (table_name, row_count, captured_at)
SELECT 'artifact_tags', count(*), now() FROM artifact_tags
UNION ALL SELECT 'evidence', count(*), now() FROM evidence
UNION ALL SELECT 'handled_mentions', count(*), now() FROM handled_mentions
UNION ALL SELECT 'knowledge_answer_evidence', count(*), now() FROM knowledge_answer_evidence
UNION ALL SELECT 'publish_requests', count(*), now() FROM publish_requests
UNION ALL SELECT 'routing_audit', count(*), now() FROM routing_audit
UNION ALL SELECT 'scout_queries', count(*), now() FROM scout_queries
UNION ALL SELECT 'token_usage', count(*), now() FROM token_usage
UNION ALL SELECT 'web_queries', count(*), now() FROM web_queries
UNION ALL SELECT 'work_queue', count(*), now() FROM work_queue;

SELECT table_name, row_count, captured_at
FROM persona_migration_baseline
ORDER BY table_name;
