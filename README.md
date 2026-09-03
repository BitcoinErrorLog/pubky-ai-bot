# Pubky AI Bot

TypeScript bot that polls Nexus notifications, classifies mentions, and publishes replies via `@synonymdev/pubky` 0.6.0 / `pubky-app-specs` 0.4.4.

This is a real process: PostgreSQL for cursor/idempotency, Redis Streams for router/workers, Express for health/metrics/admin.

## Run locally

```bash
npm ci
# Provide DATABASE_URL, REDIS_URL, and either PUBKY_BOT_SECRET_KEY_HEX (32-byte hex)
# or PUBKY_BOT_MNEMONIC, plus AI_* vars. Do not commit a .env.
npm run db:migrate
npm run dev          # ts-node-dev + tsconfig-paths
```

Production entry after `npm run build` (`tsc && tsc-alias`):

```bash
node dist/server.js
```

Docker:

```bash
docker build --target production -t pubky-ai-bot .
docker compose up    # development target by default; bind-mounts src
```

## Auth

- `PUBKY_BOT_SECRET_KEY_HEX` — 32-byte Ed25519 secret as hex. Takes precedence.
- `PUBKY_BOT_MNEMONIC` — BIP39 phrase; first 32 seed bytes used with `Keypair.fromSecret`.
- Neither value is logged.
- Homeserver: `PUBKY_HOMESERVER_URL` must be a z32 pubkey (or `pubky://<pubkey>`), not an https URL.
- Optional `PUBKY_SIGNUP_TOKEN` — used when `signin()` fails.
- `PUBKY_NETWORK=testnet` uses `Pubky.testnet()`; anything else uses `new Pubky()` (staging/mainnet).

Nexus (`PUBKY_NEXUS_API_URL`) is public. There is no Basic Auth.

## Polling

`GET /v0/user/{bot}/notifications?limit=&end=` (timestamp cursor, not offset).
Kept types: `body.type === "mention"` and `body.type === "reply"` when the parent was authored by the bot. Cursor is `polling_state.last_timestamp`.

Mention text forms `pubky{z32}` and `pk:{id}` are accepted in post content; notification bodies still use `mentioned_by` / `post_uri`.

## Kill switch

Stops new consumes and publishes within one poll interval:

- `BOT_DISABLED=1`, or
- Redis key `jeb:kill_switch` = `1`

Admin (header `x-admin-token` must equal `ADMIN_TOKEN`; denied if unset):

- `POST /api/admin/kill`
- `POST /api/admin/resume`

## HTTP

- `GET /api/health` — database + Redis only (no LLM)
- `GET /api/live` and `GET /api/health/live`
- `GET /api/ready` and `GET /api/health/ready`
- `GET /metrics`

## Contract adapter

```bash
npm run build
cd /Volumes/vibedrive/vibes-dev/jeb-contract
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_bot_test \
REDIS_URL=redis://127.0.0.1:6379/3 \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot/dist/contract-adapter.js \
npm test
```

`src/contract-adapter.ts` maps `ContractEnv` including `testnet` (`Pubky.testnet()` vs `new Pubky()`). `stop()` halts poller, event-bus loops, HTTP, Redis, and Postgres.

## Config

Plain JSON under `config/` with `${ENV}` substitution in `src/config/index.ts` (not node-config). `WORKER_TYPE` is not used; one process runs poller + router + workers.

Rate-limit and blacklist **fail closed** on Redis errors. Daily token budget (`budget.enabled`, `budget.defaultDailyTokens`) refuses model calls when `token_usage` for the UTC day exceeds the ceiling.
