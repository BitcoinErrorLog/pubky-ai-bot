-- Operator corrections: staff mark a published Jeb reply incorrect.
-- History (handled_mentions / publish_requests) is never edited.
-- Follow-up correction posts are a separate operator `post:publish` step.

CREATE TABLE IF NOT EXISTS corrections (
  id BIGSERIAL PRIMARY KEY,
  reply_uri TEXT NOT NULL,
  mention_key TEXT NOT NULL REFERENCES handled_mentions (mention_key) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  correct_answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exported_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_corrections_created ON corrections (created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_reply ON corrections (reply_uri);
CREATE INDEX IF NOT EXISTS idx_corrections_unexported ON corrections (id)
  WHERE exported_at IS NULL;
