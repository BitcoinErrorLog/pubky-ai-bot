-- Jeb-owned collections: rules, published standalone posts, membership.
-- Number 107 leaves a gap after 102 for a sibling worktree's migrations.

CREATE TABLE IF NOT EXISTS collection_rules (
  collection_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  match_series TEXT,
  match_self_tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS published (
  uri TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('short', 'long')),
  content TEXT NOT NULL,
  self_tags TEXT[] NOT NULL DEFAULT '{}',
  series TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  publish_request_id BIGINT
);

CREATE INDEX IF NOT EXISTS idx_published_kind_at ON published (kind, published_at);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_key TEXT NOT NULL REFERENCES collection_rules (collection_key) ON DELETE CASCADE,
  post_uri TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_key, post_uri)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_position
  ON collection_items (collection_key, position);

INSERT INTO collection_rules (collection_key, title, description, match_series, match_self_tag) VALUES
  ('jeb-blog', 'Jeb''s Blog', 'Every article Jeb publishes, in publish order.', NULL, NULL),
  ('pubky-weekly', 'Pubky Weekly', 'The weekly Pubky briefing.', 'pubky-weekly', 'pubky-weekly'),
  ('community-feedback', 'Community Feedback', 'What the community asked for and how it was answered.', 'community-feedback', 'community-feedback'),
  ('pubky-explained', 'Pubky Explained', 'Mechanism notes from the public knowledge index.', 'pubky-explained', 'pubky-explained'),
  ('release-radar', 'Release Radar', 'Dated GitHub releases among indexed sources.', 'release-radar', 'release-radar'),
  ('pubky-app', 'Pubky App', 'Posts about Pubky App.', NULL, 'pubky-app'),
  ('pubky-ring', 'Pubky Ring', 'Posts about Pubky Ring.', NULL, 'pubky-ring'),
  ('pubky-core', 'Pubky Core', 'Posts about Pubky Core and the homeserver.', NULL, 'pubky-core'),
  ('pkarr', 'Pkarr', 'Posts about Pkarr.', NULL, 'pkarr'),
  ('nexus', 'Nexus', 'Posts about Nexus.', NULL, 'nexus'),
  ('nexus-scout', 'Nexus Scout', 'Posts about Nexus Scout.', NULL, 'nexus-scout'),
  ('homegate', 'Homegate', 'Posts about Homegate.', NULL, 'homegate'),
  ('paykit', 'Paykit', 'Posts about Paykit.', NULL, 'paykit'),
  ('locks', 'Locks', 'Posts about Locks.', NULL, 'locks'),
  ('loopky', 'Loopky', 'Posts about Loopky.', NULL, 'loopky'),
  ('hypercolor', 'Hypercolor', 'Posts about Hypercolor.', NULL, 'hypercolor'),
  ('jeb', 'Jeb', 'Posts about Jeb.', NULL, 'jeb'),
  ('pubky-bot-kit', 'Pubky Bot Kit', 'Posts about Pubky Bot Kit.', NULL, 'pubky-bot-kit')
ON CONFLICT (collection_key) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  match_series = EXCLUDED.match_series,
  match_self_tag = EXCLUDED.match_self_tag;
