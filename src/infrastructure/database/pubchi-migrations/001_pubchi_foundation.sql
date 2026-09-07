CREATE TABLE IF NOT EXISTS public.pubchi_nonces (
  bot TEXT NOT NULL,
  asker TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot, asker, nonce)
);

CREATE INDEX IF NOT EXISTS idx_pubchi_nonces_expires
  ON public.pubchi_nonces (expires_at);

CREATE TABLE IF NOT EXISTS public.pubchi_budget_day (
  mention_key TEXT NOT NULL,
  utc_day DATE NOT NULL,
  reserved BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (mention_key, utc_day)
);

CREATE TABLE IF NOT EXISTS public.token_usage (
  id BIGSERIAL PRIMARY KEY,
  mention_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  meta_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_pubkey_created
  ON public.token_usage (public_key, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_created
  ON public.token_usage (created_at);

CREATE TABLE IF NOT EXISTS public.kill_switch (
  id INTEGER PRIMARY KEY DEFAULT 1,
  disabled BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO public.kill_switch (id, disabled)
VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.switches (
  name TEXT PRIMARY KEY,
  on_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
