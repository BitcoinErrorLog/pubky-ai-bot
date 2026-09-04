-- Last-allowed-answer quota prefix (R12): persist which rule fired so
-- fallback / deadline replies can reuse the same prefix.
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS quota_notice TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS quota_notice TEXT;
