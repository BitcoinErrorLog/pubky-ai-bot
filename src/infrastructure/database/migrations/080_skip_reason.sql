-- Record why a mention was skipped so cap refusals are measurable.
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS skip_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_handled_mentions_skip_reason
  ON handled_mentions (skip_reason)
  WHERE status = 'skipped' AND skip_reason IS NOT NULL;
