-- Bounded reservation leases for resource runs.
--
-- A run killed between reserving and settling used to leave its `running`
-- row and its reserved dollars forever. Each run now carries a lease: the
-- reaper closes a `running` row whose lease expired as `abandoned` (never
-- silently reusable), and the day-row reservation stays conservative — a
-- crashed run's reservation is freed only by an operator, never by the
-- reaper. Statements are idempotent so the migration is safe to re-apply.

ALTER TABLE resource_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE resource_runs DROP CONSTRAINT IF EXISTS resource_runs_status_check;
ALTER TABLE resource_runs ADD CONSTRAINT resource_runs_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'overlap_refused', 'abandoned'));

CREATE INDEX IF NOT EXISTS resource_runs_lease_idx ON resource_runs (lease_expires_at)
  WHERE status = 'running';
