-- One in-flight work item and one active publish request per mention.
-- Finished/failed rows stay for audit; a later crash-recovery enqueue may
-- insert a new row only when no active sibling exists.

-- R-07: databases that ran the pre-fix race may already hold duplicate active
-- rows, which would abort the unique index creation below. Delete the newer
-- duplicates first, keeping the lowest id. Idempotent: on a clean database
-- (or a re-run) these delete zero rows.
DELETE FROM work_queue a
USING work_queue b
WHERE a.mention_key = b.mention_key
  AND a.status IN ('queued', 'claimed')
  AND b.status IN ('queued', 'claimed')
  AND a.id > b.id;

ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_mention_key_key;
DROP INDEX IF EXISTS work_queue_mention_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS work_queue_active_mention_key
  ON work_queue (mention_key)
  WHERE status IN ('queued', 'claimed');

DELETE FROM publish_requests a
USING publish_requests b
WHERE a.mention_key = b.mention_key
  AND a.status IN ('queued', 'retry', 'publishing', 'published')
  AND b.status IN ('queued', 'retry', 'publishing', 'published')
  AND a.id > b.id;

ALTER TABLE publish_requests DROP CONSTRAINT IF EXISTS publish_requests_mention_key_key;
DROP INDEX IF EXISTS publish_requests_mention_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS publish_requests_active_mention_key
  ON publish_requests (mention_key)
  WHERE status IN ('queued', 'retry', 'publishing', 'published');
