-- One in-flight work item and one active publish request per mention.
-- Finished/failed rows stay for audit; a later crash-recovery enqueue may
-- insert a new row only when no active sibling exists.

ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_mention_key_key;
DROP INDEX IF EXISTS work_queue_mention_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS work_queue_active_mention_key
  ON work_queue (mention_key)
  WHERE status IN ('queued', 'claimed');

ALTER TABLE publish_requests DROP CONSTRAINT IF EXISTS publish_requests_mention_key_key;
DROP INDEX IF EXISTS publish_requests_mention_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS publish_requests_active_mention_key
  ON publish_requests (mention_key)
  WHERE status IN ('queued', 'retry', 'publishing', 'published');
