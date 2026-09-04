-- Stage 2 proactive drafts: operator-approved only. Never auto-published.

CREATE TABLE IF NOT EXISTS drafts (
  id BIGSERIAL PRIMARY KEY,
  format TEXT NOT NULL,
  body TEXT NOT NULL,
  title TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'rejected', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  reject_reason TEXT,
  publish_request_id BIGINT REFERENCES publish_requests (id),
  proactive_utc_day DATE
);

CREATE INDEX IF NOT EXISTS idx_drafts_status_format ON drafts (status, format);
CREATE INDEX IF NOT EXISTS idx_drafts_proactive_day
  ON drafts (proactive_utc_day)
  WHERE status IN ('approved', 'published');

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS standalone BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS post_json JSONB;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS post_path TEXT;
