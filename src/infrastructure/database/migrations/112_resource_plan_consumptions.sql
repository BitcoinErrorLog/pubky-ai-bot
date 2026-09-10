-- One confirmed plan executes at most once.
--
-- Confirming a plan is an operator commitment; letting the same artifact
-- execute repeatedly would let one review authorize unbounded mutation. The
-- consumption row is keyed by the plan hash and is inserted in the same
-- transaction as the executor's run row, so a plan is consumed atomically
-- with the run that executes it — a second execution of the same hash is
-- refused before any mutation. The foreign keys bind the consumption to the
-- planner run that minted the artifact and the executor run that consumed it.

CREATE TABLE IF NOT EXISTS resource_plan_consumptions (
  plan_sha256 TEXT PRIMARY KEY,
  planner_run_id UUID NOT NULL REFERENCES resource_runs (run_id),
  executor_run_id UUID NOT NULL REFERENCES resource_runs (run_id),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
