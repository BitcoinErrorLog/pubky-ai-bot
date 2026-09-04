-- Persist that the outbound gate fired on a publish request. A retry then
-- publishes the deterministic decline WITHOUT re-scanning the content or
-- re-appending duplicate security_event entries to the evidence bundle.

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS scrubbed BOOLEAN NOT NULL DEFAULT FALSE;
