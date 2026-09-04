-- User opt-out: permanent until the same pubky opts back in.
CREATE TABLE IF NOT EXISTS user_optouts (
  pubky TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opted_in_at TIMESTAMPTZ,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_optouts_active
  ON user_optouts (opted_out_at)
  WHERE opted_in_at IS NULL;
