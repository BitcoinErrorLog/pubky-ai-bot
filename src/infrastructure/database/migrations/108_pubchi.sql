-- Pubchi Phase 0: request-object nonces, unique per (bot, asker).
-- Expired rows are deleted by postgresNonceStore (every N inserts) and by
-- runPubchiProcess's periodic sweeper. idx_pubchi_nonces_expires exists for
-- that DELETE. Replay safety does not depend on cleanup: post-expiry
-- requests die at the expiry check.

CREATE TABLE IF NOT EXISTS pubchi_nonces (
  bot TEXT NOT NULL,
  asker TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot, asker, nonce)
);

CREATE INDEX IF NOT EXISTS idx_pubchi_nonces_expires ON pubchi_nonces (expires_at);
