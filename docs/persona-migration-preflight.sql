\set ON_ERROR_STOP on

DO $$
DECLARE
  identity_count INTEGER;
BEGIN
  SELECT count(DISTINCT bot_id)::integer INTO identity_count
  FROM (
    SELECT bot_id FROM handled_mentions WHERE bot_id IS NOT NULL AND bot_id <> ''
    UNION ALL
    SELECT bot_id FROM cursor_state WHERE bot_id IS NOT NULL AND bot_id <> ''
  ) identities;
  IF identity_count > 1 THEN
    RAISE EXCEPTION 'preflight found % existing bot identities; expected at most one', identity_count;
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
