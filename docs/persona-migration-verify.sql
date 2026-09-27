\set ON_ERROR_STOP on

DO $$
DECLARE
  migration_count INTEGER;
  missing_identity BIGINT;
  orphan_count BIGINT;
  table_name TEXT;
  constraint_count INTEGER;
  index_count INTEGER;
  mismatched_key_count INTEGER;
  count_drift INTEGER;
BEGIN
  SELECT count(*)::integer INTO migration_count
  FROM public.migrations
  WHERE id BETWEEN 110 AND 113;
  IF migration_count <> 4 THEN
    RAISE EXCEPTION 'persona migrations 110-113 are not all recorded';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM personas
    WHERE id = 'jeb' AND enabled
  ) THEN
    RAISE EXCEPTION 'enabled Jeb persona is missing';
  END IF;

  IF to_regclass('public.persona_migration_baseline') IS NULL THEN
    RAISE EXCEPTION 'persona migration preflight baseline is missing';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'handled_mentions', 'work_queue', 'evidence', 'publish_requests',
    'token_usage', 'routing_audit', 'web_queries', 'scout_queries',
    'artifact_tags', 'knowledge_answer_evidence'
  ]
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I
       WHERE persona_id IS NULL
          OR persona_version IS NULL
          OR persona_manifest_hash IS NULL
          OR target_bot_pk IS NULL',
      table_name
    ) INTO missing_identity;
    IF missing_identity <> 0 THEN
      RAISE EXCEPTION '% has % incomplete persona rows', table_name, missing_identity;
    END IF;
  END LOOP;

  SELECT count(*) INTO orphan_count
  FROM (
    SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM handled_mentions
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM work_queue
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM evidence
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM publish_requests
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM token_usage
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM routing_audit
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM web_queries
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM scout_queries
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM artifact_tags
    UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM knowledge_answer_evidence
  ) identity_rows
  LEFT JOIN persona_versions pv
    ON pv.persona_id = identity_rows.persona_id
   AND pv.version = identity_rows.persona_version
   AND pv.manifest_hash = identity_rows.persona_manifest_hash
  LEFT JOIN personas p
    ON p.id = identity_rows.persona_id
   AND p.bot_pk = identity_rows.target_bot_pk
  WHERE pv.persona_id IS NULL OR p.id IS NULL;
  IF orphan_count <> 0 THEN
    RAISE EXCEPTION 'persona migration has % orphan identity rows', orphan_count;
  END IF;

  SELECT count(*)::integer INTO mismatched_key_count
  FROM (
    SELECT DISTINCT bot_id
    FROM (
      SELECT bot_id FROM handled_mentions WHERE bot_id IS NOT NULL AND bot_id <> ''
      UNION ALL
      SELECT bot_id FROM cursor_state WHERE bot_id IS NOT NULL AND bot_id <> ''
    ) keys
  ) existing
  LEFT JOIN personas p ON p.id = 'jeb' AND p.bot_pk = existing.bot_id
  WHERE p.id IS NULL;
  IF mismatched_key_count <> 0 THEN
    RAISE EXCEPTION 'registered Jeb key disagrees with % existing identity keys', mismatched_key_count;
  END IF;

  SELECT count(*)::integer INTO constraint_count
  FROM pg_constraint
  WHERE convalidated
    AND conname ~ '_persona_(version_fk|identity_fk|identity_present)$';
  IF constraint_count <> 30 THEN
    RAISE EXCEPTION 'expected 30 validated persona row constraints, found %', constraint_count;
  END IF;

  SELECT count(*)::integer INTO index_count
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE i.indisvalid
    AND c.relname IN (
      'handled_mentions_persona_mention',
      'work_queue_active_persona_mention',
      'publish_requests_active_persona_mention',
      'artifact_tags_active_persona_uri_label',
      'token_usage_persona_created',
      'web_queries_persona_created',
      'scout_queries_persona_created',
      'knowledge_answer_evidence_persona_created'
    );
  IF index_count <> 8 THEN
    RAISE EXCEPTION 'expected 8 valid persona indexes, found %', index_count;
  END IF;

  WITH current_counts AS (
    SELECT 'artifact_tags' AS table_name, count(*) AS row_count FROM artifact_tags
    UNION ALL SELECT 'evidence', count(*) FROM evidence
    UNION ALL SELECT 'handled_mentions', count(*) FROM handled_mentions
    UNION ALL SELECT 'knowledge_answer_evidence', count(*) FROM knowledge_answer_evidence
    UNION ALL SELECT 'publish_requests', count(*) FROM publish_requests
    UNION ALL SELECT 'routing_audit', count(*) FROM routing_audit
    UNION ALL SELECT 'scout_queries', count(*) FROM scout_queries
    UNION ALL SELECT 'token_usage', count(*) FROM token_usage
    UNION ALL SELECT 'web_queries', count(*) FROM web_queries
    UNION ALL SELECT 'work_queue', count(*) FROM work_queue
  )
  SELECT count(*)::integer INTO count_drift
  FROM persona_migration_baseline baseline
  JOIN current_counts current USING (table_name)
  WHERE current.row_count < baseline.row_count;
  IF count_drift <> 0 THEN
    RAISE EXCEPTION 'row counts decreased for % persona-migrated tables', count_drift;
  END IF;
END
$$;

SELECT p.id, p.current_version, p.enabled, p.bot_pk, p.manifest_hash,
       pv.corpus_namespace, pv.status
FROM personas p
JOIN persona_versions pv
  ON pv.persona_id = p.id
 AND pv.version = p.current_version
 AND pv.manifest_hash = p.manifest_hash
ORDER BY p.id;

SELECT table_name, row_count, captured_at
FROM persona_migration_baseline
ORDER BY table_name;
