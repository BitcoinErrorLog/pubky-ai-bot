-- Stage 2 publisher artifacts: standalone posts from operator-approved
-- publish_requests, plus Jeb-authored tags on other people's posts.
-- 098 (not 097) so a concurrent drafts-module migration can take 097.

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS standalone BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS post_kind TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS attachments JSONB;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS collection_id TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS approved_by TEXT;

CREATE TABLE IF NOT EXISTS artifact_tags (
  id BIGSERIAL PRIMARY KEY,
  post_uri TEXT NOT NULL,
  label TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  tag_uri TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_tags_active_uri_label
  ON artifact_tags (post_uri, label)
  WHERE status IN ('queued', 'retry', 'publishing', 'published');

CREATE INDEX IF NOT EXISTS idx_artifact_tags_status
  ON artifact_tags (status, next_attempt_at);
