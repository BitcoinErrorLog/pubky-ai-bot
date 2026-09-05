-- Atomic per-owner UTC-day reservation for Pubchi Phase 0 (K1 P4 TOCTOU).
-- reserved is the check-and-reserve ceiling; token_usage is written on settle.

CREATE TABLE IF NOT EXISTS pubchi_budget_day (
  mention_key TEXT NOT NULL,
  utc_day DATE NOT NULL,
  reserved BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (mention_key, utc_day)
);
