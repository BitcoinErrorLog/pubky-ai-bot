CREATE TABLE IF NOT EXISTS weekly_legacy_recoveries (
  series TEXT NOT NULL CHECK (series IN ('feedback', 'updates')),
  week_key TEXT NOT NULL CHECK (week_key = '2026-W36'),
  old_post_uri TEXT NOT NULL,
  old_mention_key TEXT NOT NULL,
  old_publish_request_id BIGINT NOT NULL REFERENCES publish_requests (id),
  replacement_mention_key TEXT NOT NULL UNIQUE,
  replacement_post_uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'published')) DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (series, week_key)
);
