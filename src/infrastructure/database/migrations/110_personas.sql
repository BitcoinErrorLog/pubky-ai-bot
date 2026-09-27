-- Phase 1 persona compatibility schema.
--
-- Additive first: seed Jeb, backfill every existing row, constrain only after
-- backfill, and retain legacy mention-key uniqueness for the current runtime.
-- Migration 110 is therefore safe before persona-aware SQL ships.

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  current_version TEXT NOT NULL,
  bot_pk TEXT NOT NULL UNIQUE CHECK (bot_pk ~ '^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, bot_pk)
);

CREATE TABLE IF NOT EXISTS persona_versions (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  version TEXT NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  manifest_hash TEXT NOT NULL UNIQUE CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  profile_json JSONB NOT NULL,
  capability_json JSONB NOT NULL,
  budget_json JSONB NOT NULL,
  tag_json JSONB NOT NULL,
  corpus_namespace TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, version),
  UNIQUE (persona_id, version, manifest_hash),
  CHECK (corpus_namespace = 'persona/' || persona_id || '/' || version)
);

DO $$
DECLARE
  discovered_bot_pk TEXT;
  discovered_count INTEGER;
BEGIN
  SELECT min(bot_id), count(DISTINCT bot_id)::integer
    INTO discovered_bot_pk, discovered_count
  FROM (
    SELECT bot_id FROM handled_mentions WHERE bot_id IS NOT NULL AND bot_id <> ''
    UNION ALL
    SELECT bot_id FROM cursor_state WHERE bot_id IS NOT NULL AND bot_id <> ''
  ) existing_identities;

  IF discovered_count > 1 THEN
    RAISE EXCEPTION 'persona migration requires one existing Jeb identity, found %', discovered_count;
  END IF;

  INSERT INTO personas (id, current_version, bot_pk, enabled, manifest_hash)
  VALUES (
    'jeb',
    '1.0.0',
    COALESCE(discovered_bot_pk, '9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y'),
    TRUE,
    'c2558ce9e03911a3835cdf0457b9992efc41930b23403a0d86df4f9017f597ed'
  )
  ON CONFLICT (id) DO NOTHING;
END
$$;

INSERT INTO persona_versions (
  persona_id,
  version,
  manifest_hash,
  profile_json,
  capability_json,
  budget_json,
  tag_json,
  corpus_namespace,
  status,
  reviewed_at
) VALUES (
  'jeb',
  '1.0.0',
  'c2558ce9e03911a3835cdf0457b9992efc41930b23403a0d86df4f9017f597ed',
  '{"name":"Jeb","bio":"AI role operated by Synonym; not a person or authority. Sources and policy are linked below.","status":"automated","disclosure_kind":"role"}'::jsonb,
  '{"allow":["nexus_read","scout_graph","knowledge_global","knowledge_persona","web_search","image_read","tags","translate","evidence_map"],"deny":["raw_scout_query","standalone_publish"]}'::jsonb,
  '{"daily_tokens":5000000,"per_user_daily_tokens":600000,"web_calls_per_mention":2,"web_calls_daily":200,"scout_calls_per_mention":12,"scout_calls_daily":400,"image_tokens_daily":5000000}'::jsonb,
  '{"reply_vocabulary":["answer","pubky","bitkit","paykit","graph","evidence-map","summary","declined"],"artifact_vocabulary":["sources-cited","debate","release-notes"],"max_per_target":5}'::jsonb,
  'persona/jeb/1.0.0',
  'active',
  now()
)
ON CONFLICT (persona_id, version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'personas_current_version_fk' AND conrelid = 'personas'::regclass
  ) THEN
    ALTER TABLE personas
      ADD CONSTRAINT personas_current_version_fk
      FOREIGN KEY (id, current_version, manifest_hash)
      REFERENCES persona_versions (persona_id, version, manifest_hash);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION persona_default_bot_pk()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT bot_pk FROM public.personas WHERE id = 'jeb' AND enabled
$$;

CREATE OR REPLACE FUNCTION persona_default_manifest_hash()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT manifest_hash FROM public.personas WHERE id = 'jeb' AND enabled
$$;

ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE routing_audit ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE routing_audit ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE routing_audit ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE routing_audit ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE web_queries ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE web_queries ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE web_queries ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE web_queries ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE scout_queries ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE scout_queries ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE scout_queries ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE scout_queries ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

ALTER TABLE artifact_tags ADD COLUMN IF NOT EXISTS persona_id TEXT;
ALTER TABLE artifact_tags ADD COLUMN IF NOT EXISTS persona_version TEXT;
ALTER TABLE artifact_tags ADD COLUMN IF NOT EXISTS persona_manifest_hash TEXT;
ALTER TABLE artifact_tags ADD COLUMN IF NOT EXISTS target_bot_pk TEXT;

DO $$
DECLARE
  table_name TEXT;
BEGIN
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
      'UPDATE %I
       SET persona_id = COALESCE(persona_id, ''jeb''),
           persona_version = COALESCE(persona_version, ''1.0.0''),
           persona_manifest_hash = COALESCE(persona_manifest_hash, persona_default_manifest_hash()),
           target_bot_pk = COALESCE(target_bot_pk, persona_default_bot_pk())',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN persona_id SET DEFAULT ''jeb''', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN persona_version SET DEFAULT ''1.0.0''', table_name);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN persona_manifest_hash SET DEFAULT persona_default_manifest_hash()',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN target_bot_pk SET DEFAULT persona_default_bot_pk()',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN persona_id SET NOT NULL', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN persona_version SET NOT NULL', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN persona_manifest_hash SET NOT NULL', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN target_bot_pk SET NOT NULL', table_name);
  END LOOP;
END
$$;

-- handled_mentions already records the polled identity. Preserve it when
-- present and prove that it agrees with the sole registered Phase 1 persona.
UPDATE handled_mentions
SET target_bot_pk = bot_id
WHERE bot_id IS NOT NULL AND bot_id <> '';

DO $$
DECLARE
  table_name TEXT;
  version_constraint TEXT;
  identity_constraint TEXT;
BEGIN
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
    version_constraint := table_name || '_persona_version_fk';
    identity_constraint := table_name || '_persona_identity_fk';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = version_constraint AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY (persona_id, persona_version, persona_manifest_hash)
         REFERENCES persona_versions (persona_id, version, manifest_hash)',
        table_name,
        version_constraint
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = identity_constraint AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY (persona_id, target_bot_pk)
         REFERENCES personas (id, bot_pk)',
        table_name,
        identity_constraint
      );
    END IF;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS handled_mentions_persona_mention
  ON handled_mentions (persona_id, mention_key);
CREATE UNIQUE INDEX IF NOT EXISTS work_queue_active_persona_mention
  ON work_queue (persona_id, mention_key)
  WHERE status IN ('queued', 'processing');
CREATE UNIQUE INDEX IF NOT EXISTS publish_requests_active_persona_mention
  ON publish_requests (persona_id, mention_key)
  WHERE status IN ('queued', 'retry', 'publishing');
CREATE UNIQUE INDEX IF NOT EXISTS artifact_tags_active_persona_uri_label
  ON artifact_tags (persona_id, post_uri, label)
  WHERE status IN ('queued', 'retry', 'publishing', 'published');

CREATE INDEX IF NOT EXISTS token_usage_persona_created
  ON token_usage (persona_id, created_at);
CREATE INDEX IF NOT EXISTS web_queries_persona_created
  ON web_queries (persona_id, created_at);
CREATE INDEX IF NOT EXISTS scout_queries_persona_created
  ON scout_queries (persona_id, created_at);

CREATE TABLE IF NOT EXISTS persona_switches (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  name TEXT NOT NULL CHECK (name IN ('global', 'ingest', 'generation', 'replies', 'web', 'scout', 'images', 'tags')),
  on_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  PRIMARY KEY (persona_id, name)
);

CREATE TABLE IF NOT EXISTS persona_budget_day (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  day DATE NOT NULL,
  tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  web_reserved INTEGER NOT NULL DEFAULT 0 CHECK (web_reserved >= 0),
  web_used INTEGER NOT NULL DEFAULT 0 CHECK (web_used >= 0),
  scout_used INTEGER NOT NULL DEFAULT 0 CHECK (scout_used >= 0),
  image_tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (image_tokens_reserved >= 0),
  image_tokens_used BIGINT NOT NULL DEFAULT 0 CHECK (image_tokens_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, day)
);

CREATE TABLE IF NOT EXISTS persona_release_events (
  id BIGSERIAL PRIMARY KEY,
  persona_id TEXT NOT NULL,
  persona_version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  corpus_revision TEXT,
  reviewer_gates JSONB NOT NULL,
  profile_uri TEXT,
  bot_pk TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  rollback_source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (persona_id, persona_version, manifest_hash)
    REFERENCES persona_versions (persona_id, version, manifest_hash),
  FOREIGN KEY (persona_id, bot_pk)
    REFERENCES personas (id, bot_pk)
);
