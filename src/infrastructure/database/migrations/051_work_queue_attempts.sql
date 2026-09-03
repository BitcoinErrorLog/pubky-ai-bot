-- Reaper support (R-01): stale `claimed` work rows are requeued with
-- attempts + 1, and terminally failed once attempts reach the cap.

ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
