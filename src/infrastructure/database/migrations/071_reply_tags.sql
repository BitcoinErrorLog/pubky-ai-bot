-- Ticket 12c (plan §4.4b): category self-tags on Jeb's own replies.
-- The reason step derives a fixed-vocabulary category set per answer and
-- stores it on the publish request and in the evidence bundle; the publisher
-- writes one Pubky tag per label under the bot key after the reply PUT
-- succeeds. `tag_uris` records the written tag URIs (NULL = pending);
-- `tag_attempts` caps tag retries at 3 before giving up (tags never fail the
-- publish itself).

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS tag_uris JSONB;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS tag_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_publish_requests_pending_tags
  ON publish_requests (id)
  WHERE status = 'published' AND tag_uris IS NULL;
