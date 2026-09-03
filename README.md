# Jeb (pubky-ai-bot)

Postgres-only Pubky answer bot extracted from jeb-slim (ADR 0001). Redis is gone.

## Architecture

Three OS processes, one codebase:

| Role | Command | Keys | Job |
| --- | --- | --- | --- |
| ingest | `node dist/main.js --role ingest` | none (`JEB_BOT_PK` only) | Poll Nexus, claim `handled_mentions`, enqueue `work_queue` |
| reason | `node dist/main.js --role reason` | none (fails if key env is set) | Policy, intent, tool loop, evidence, `publish_requests` |
| publish | `node dist/main.js --role publish` | `PUBKY_BOT_SECRET_KEY_HEX` or mnemonic | Validate, SDK PUT, readback, idempotent reconcile |

`--role all` spawns the three as **child processes** (not threads) and strips key env from ingest/reason.

Intents: `answer` (default), `summarize`, `explain_pubky`, `research_pubky`, `research_web`, `evidence_map`, `find`, `compare`, `decline`, `ignore`. Scout/web tools are later tickets.

## Config

Env-driven (`JEB_*`). Key sources: `PUBKY_BOT_SECRET_KEY_HEX` wins over `PUBKY_BOT_MNEMONIC`. See `.env.example` (names only). Never commit a real `.env`.

Kill switches: Postgres `switches` plus `JEB_SWITCH_*` / `JEB_DISABLED`. Admin: `POST /admin/switch/{name}` on `JEB_ADMIN_PORT` (loopback), `Authorization: Bearer $ADMIN_TOKEN` (404 if unset). `/healthz` and `/metrics` are separate.

## Run

```bash
npm install
npm run build
export DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test
node dist/main.js --role all
```

## Tests

```bash
npx tsc --noEmit
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test npm test
```

Contract (staging homeserver; do not echo the password file):

```bash
cd /Volumes/vibedrive/vibes-dev/jeb-contract
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/dist/contract-adapter.js \
npm test
```

The adapter starts `--role ingest|reason|publish` child processes.

## Docker

`Dockerfile` and `docker-compose.yml` are written (non-root, three services, publish-only key env). **Image build is UNVERIFIED** — Docker daemon was hung on this machine.
