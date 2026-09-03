ALTER TABLE evidence ADD COLUMN IF NOT EXISTS voice_violations JSONB NOT NULL DEFAULT '[]'::jsonb;
