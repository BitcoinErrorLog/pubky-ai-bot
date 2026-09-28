-- Phase 1 persona registry/bootstrap only. Populated-table expansion runs
-- one table per committed transaction in migration 111.

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
  selected_bot_pk TEXT;
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
  selected_bot_pk := COALESCE(
    discovered_bot_pk,
    NULLIF(current_setting('jeb.bot_pk', TRUE), '')
  );
  IF selected_bot_pk IS NULL THEN
    RAISE EXCEPTION 'persona migration requires JEB_BOT_PK for an empty database';
  END IF;

  INSERT INTO personas (id, current_version, bot_pk, enabled, manifest_hash)
  VALUES (
    'jeb',
    '1.0.0',
    selected_bot_pk,
    TRUE,
    '14360805196e399a032a56ecdc2d9e979db45980ff13bbacddd702b551435fca'
  )
  ON CONFLICT (id) DO NOTHING;
END
$$;

INSERT INTO persona_versions (
  persona_id, version, manifest_hash, profile_json, capability_json,
  tag_json, corpus_namespace, status, reviewed_at
) VALUES (
  'jeb',
  '1.0.0',
  '14360805196e399a032a56ecdc2d9e979db45980ff13bbacddd702b551435fca',
  '{"name":"Jeb","bio":"AI role operated by Synonym; not a person or authority. Sources and policy are linked below.","status":"automated","disclosure_kind":"role"}'::jsonb,
  '{"allow":["nexus_read","scout_graph","knowledge_global","web_search","image_read","tags","translate","evidence_map"]}'::jsonb,
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
RETURNS TEXT LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT bot_pk FROM public.personas WHERE id = 'jeb' AND enabled $$;

CREATE OR REPLACE FUNCTION persona_default_version()
RETURNS TEXT LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT current_version FROM public.personas WHERE id = 'jeb' AND enabled $$;

CREATE OR REPLACE FUNCTION persona_default_manifest_hash()
RETURNS TEXT LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT manifest_hash FROM public.personas WHERE id = 'jeb' AND enabled $$;

CREATE TABLE IF NOT EXISTS persona_switches (
  persona_id TEXT NOT NULL REFERENCES personas (id),
  name TEXT NOT NULL CHECK (name IN ('global', 'ingest', 'generation', 'replies', 'web', 'scout', 'images', 'tags')),
  on_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  PRIMARY KEY (persona_id, name)
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
