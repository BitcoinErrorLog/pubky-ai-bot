-- Policy skip notices (R12): record when a resource-limit skip was
-- announced vs suppressed, and persist one-shot operator flags (budget_warning).
ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS notice_suppressed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS operator_flags (
  name TEXT PRIMARY KEY,
  noted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
