-- Kimi audit A2 remediation.
--
-- Cap (F-1): JEB_PROACTIVE_MAX_PER_DAY is configurable via proactiveMaxPerDay
-- (default 1, but any integer >= 1). A partial UNIQUE index on
-- drafts(proactive_utc_day) WHERE status IN ('approved','published') would
-- reject a legitimate second approve when the cap is >1. Serialization is
-- therefore pg_advisory_xact_lock(JEB_PROACTIVE_CAP_LOCK) inside approveDraft
-- before the cap COUNT, not a unique index.
--
-- F-3: approved/published/declined rows must carry a non-empty decided_by.
-- F-6: terminal status `declined` for standalone rows the outbound gate scrubbed.

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;

ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
  CHECK (status IN ('draft', 'approved', 'rejected', 'published', 'declined'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_decided_by_required;

ALTER TABLE drafts ADD CONSTRAINT drafts_decided_by_required
  CHECK (
    status NOT IN ('approved', 'published', 'declined')
    OR (decided_by IS NOT NULL AND decided_by <> '')
  );
