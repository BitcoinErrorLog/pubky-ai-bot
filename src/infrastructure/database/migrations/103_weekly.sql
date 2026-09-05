-- Weekly articles + feedback skill. Autonomous Sunday/Monday series;
-- classifier and tag-collector rows share feedback_items.

CREATE TABLE IF NOT EXISTS feedback_items (
  id BIGSERIAL PRIMARY KEY,
  post_uri TEXT NOT NULL UNIQUE,
  author_pk TEXT NOT NULL,
  kinds TEXT[] NOT NULL DEFAULT '{}',
  quote TEXT NOT NULL CHECK (char_length(quote) <= 280),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  week_key TEXT NOT NULL CHECK (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  source TEXT NOT NULL CHECK (source IN ('classifier', 'tag')),
  included_in_post_uri TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_items_week ON feedback_items (week_key, detected_at);
CREATE INDEX IF NOT EXISTS idx_feedback_items_open ON feedback_items (detected_at)
  WHERE included_in_post_uri IS NULL;

CREATE TABLE IF NOT EXISTS weekly_posts (
  series TEXT NOT NULL CHECK (series IN ('feedback', 'updates')),
  week_key TEXT NOT NULL CHECK (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  post_uri TEXT,
  mention_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'published', 'skipped')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (series, week_key)
);

CREATE TABLE IF NOT EXISTS tracked_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  pubky_ids TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tracked_projects (id, name, aliases, tags, pubky_ids, status) VALUES
  ('pubky-app', 'Pubky App', ARRAY['PubkyApp','pubky-app'], ARRAY['pubky-app','pubkyapp'], ARRAY[]::text[], 'active'),
  ('pubky-ring', 'Pubky Ring', ARRAY['PubkyRing','Ring'], ARRAY['pubky-ring','pubkyring'], ARRAY[]::text[], 'active'),
  ('pubky-core', 'Pubky Core / homeserver', ARRAY['Pubky Core','homeserver','pubky-core'], ARRAY['pubky-core','homeserver'], ARRAY[]::text[], 'active'),
  ('pkarr', 'Pkarr', ARRAY['PKARR','pkdns','PKDNS'], ARRAY['pkarr','pkdns'], ARRAY[]::text[], 'active'),
  ('nexus', 'Nexus', ARRAY['Pubky Nexus'], ARRAY['nexus','pubky-nexus'], ARRAY[]::text[], 'active'),
  ('nexus-scout', 'Nexus Scout', ARRAY['Scout'], ARRAY['nexus-scout','scout'], ARRAY[]::text[], 'active'),
  ('homegate', 'Homegate', ARRAY[]::text[], ARRAY['homegate'], ARRAY[]::text[], 'active'),
  ('paykit', 'Paykit', ARRAY['paykit-rs'], ARRAY['paykit'], ARRAY[]::text[], 'active'),
  ('locks', 'Locks', ARRAY['Pubky Locks','pubky-locks'], ARRAY['locks','pubky-locks'], ARRAY[]::text[], 'active'),
  ('loopky', 'Loopky', ARRAY[]::text[], ARRAY['loopky'], ARRAY[]::text[], 'active'),
  ('hypercolor', 'Hypercolor', ARRAY[]::text[], ARRAY['hypercolor'], ARRAY[]::text[], 'active'),
  ('jeb', 'Jeb', ARRAY['pubky-ai-bot'], ARRAY['jeb'], ARRAY[]::text[], 'active'),
  ('pubky-bot-kit', 'Pubky Bot Kit', ARRAY['bot-kit','bot kit'], ARRAY['pubky-bot-kit','bot-kit'], ARRAY[]::text[], 'active')
ON CONFLICT (id) DO NOTHING;
