-- Pubchi Phase 0: request-object nonces, unique per (bot, asker).

CREATE TABLE IF NOT EXISTS pubchi_nonces (
  bot TEXT NOT NULL,
  asker TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot, asker, nonce)
);

CREATE INDEX IF NOT EXISTS idx_pubchi_nonces_expires ON pubchi_nonces (expires_at);
