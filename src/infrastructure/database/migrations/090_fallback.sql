-- Guaranteed-reply fallback: record why a mention used a deterministic
-- fallback instead of a model answer, and mark the evidence row.
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_handled_mentions_fallback_reason
  ON handled_mentions (fallback_reason)
  WHERE fallback_reason IS NOT NULL;

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
