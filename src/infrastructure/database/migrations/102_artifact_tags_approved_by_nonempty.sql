-- Kimi audit A5 F-1: nonempty approved_by on artifact_tags at the SQL layer.
-- Fail any blank rows first (and give them a non-empty sentinel) so ADD
-- CONSTRAINT cannot reject existing data. Idempotent DROP + ADD.

UPDATE artifact_tags
   SET status = 'failed',
       last_error = 'artifact tag requires approved_by',
       approved_by = '(missing)'
 WHERE btrim(COALESCE(approved_by, '')) = '';

ALTER TABLE artifact_tags DROP CONSTRAINT IF EXISTS artifact_tags_approved_by_nonempty;
ALTER TABLE artifact_tags
  ADD CONSTRAINT artifact_tags_approved_by_nonempty
  CHECK (btrim(approved_by) <> '');
