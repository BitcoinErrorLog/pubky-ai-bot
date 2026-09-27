\set ON_ERROR_STOP on

DO $$
DECLARE
  missing_migration INTEGER;
  persona_count INTEGER;
  orphan_count BIGINT;
  table_name TEXT;
  missing_identity BIGINT;
BEGIN
  SELECT count(*)::integer INTO missing_migration
  FROM public.migrations
  WHERE id = 110 AND filename = '110_personas.sql';
  IF missing_migration <> 1 THEN
    RAISE EXCEPTION 'migration 110_personas.sql is not recorded exactly once';
  END IF;

  SELECT count(*)::integer INTO persona_count
  FROM personas
  WHERE id = 'jeb'
    AND current_version = '1.0.0'
    AND enabled
    AND manifest_hash = 'c2558ce9e03911a3835cdf0457b9992efc41930b23403a0d86df4f9017f597ed';
  IF persona_count <> 1 OR (SELECT count(*) FROM personas) <> 1 THEN
    RAISE EXCEPTION 'Phase 1 registry must contain exactly enabled Jeb 1.0.0';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'handled_mentions',
    'work_queue',
    'evidence',
    'publish_requests',
    'token_usage',
    'routing_audit',
    'web_queries',
    'scout_queries',
    'artifact_tags'
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
      RAISE EXCEPTION '% has % rows without complete persona identity', table_name, missing_identity;
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
END
$$;

SELECT 'artifact_tags' AS table_name, count(*) AS row_count FROM artifact_tags
UNION ALL SELECT 'evidence', count(*) FROM evidence
UNION ALL SELECT 'handled_mentions', count(*) FROM handled_mentions
UNION ALL SELECT 'publish_requests', count(*) FROM publish_requests
UNION ALL SELECT 'routing_audit', count(*) FROM routing_audit
UNION ALL SELECT 'scout_queries', count(*) FROM scout_queries
UNION ALL SELECT 'token_usage', count(*) FROM token_usage
UNION ALL SELECT 'web_queries', count(*) FROM web_queries
UNION ALL SELECT 'work_queue', count(*) FROM work_queue
ORDER BY table_name;

SELECT id, current_version, enabled, bot_pk, manifest_hash
FROM personas
ORDER BY id;
