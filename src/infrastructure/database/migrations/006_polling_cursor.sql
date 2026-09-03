-- Timestamp cursor for Nexus notification polling (replaces last_offset arithmetic)
ALTER TABLE polling_state
  ADD COLUMN IF NOT EXISTS last_timestamp BIGINT NOT NULL DEFAULT 0;

ALTER TABLE mentions
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE mentions
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS root_post_uri TEXT;

CREATE INDEX IF NOT EXISTS idx_replies_root_post_uri ON replies(root_post_uri);
