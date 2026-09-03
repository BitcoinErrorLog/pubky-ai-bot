# Jeb (pubky-ai-bot)

Postgres-only Pubky answer bot extracted from jeb-slim (ADR 0001). Redis is gone.

## Architecture

Three OS processes, one codebase:

| Role | Command | Keys | Job |
| --- | --- | --- | --- |
| ingest | `node dist/main.js --role ingest` | none (`JEB_BOT_PK` only) | Poll Nexus, claim `handled_mentions`, enqueue `work_queue` |
| reason | `node dist/main.js --role reason` | none (fails if key env is set) | Policy, intent, tool loop, evidence, `publish_requests` |
| publish | `node dist/main.js --role publish` | `PUBKY_BOT_SECRET_KEY_HEX` (or file / mnemonic) | Validate, SDK PUT, readback, idempotent reconcile |

`--role all` spawns the three as **child processes** (not threads) and strips key env from ingest/reason.

Intents: `answer` (default), `summarize`, `explain_pubky`, `research_pubky`, `research_web`, `evidence_map`, `find`, `compare`, `decline`, `ignore`. `research_web` and current-events questions (news, latest, price, years ≥ 2025, "is it true that", "did X happen") use the bounded `search_web` tool. `evidence_map` uses web search plus Scout and returns an evidence map, not a bare verdict.

## Config

Env-driven (`JEB_*`). See `.env.example` (names only). Never commit a real `.env`.

Model calls always set `temperature` explicitly (never the SDK default): `JEB_MODEL_TEMPERATURE` (0..2) overrides, otherwise `1` is sent. Moonshot `kimi-k3` (`JEB_MODEL_BASE_URL=https://api.moonshot.ai/v1`) rejects any temperature other than `1`.

Web search (`search_web`): `JEB_WEB_PROVIDER=moonshot|brave|off` (default `moonshot`). Moonshot uses the same model key/base URL and the **built-in** `$web_search` function (not a normal tool schema). Moonshot documents this feature as "being updated"; if the call fails, Jeb reports that web search is unavailable and does not invent sources. Brave Search is used when `JEB_WEB_PROVIDER=brave` and `JEB_BRAVE_API_KEY` is set. Caps: `JEB_WEB_PER_MENTION_CAP` (default 2), `JEB_WEB_DAILY_CEILING`, timeout `JEB_WEB_TIMEOUT_MS` (default 45s). Kill switch: `web` (`JEB_SWITCH_WEB=1` or admin `POST /admin/switch/web`). The tool only calls the provider search endpoint; it never fetches arbitrary pages.

Key material (publish process only):

- **`PUBKY_BOT_SECRET_KEY_HEX` is preferred** — 32-byte hex.
- `PUBKY_BOT_SECRET_KEY_FILE` — path to a mode-`0600` file containing the same hex. Used when HEX is unset.
- `PUBKY_BOT_MNEMONIC` — last resort. Jeb takes the **first 32 bytes of the BIP39 seed** (non-standard; not BIP32 / SLIP-10). Prefer HEX.

`npm run keygen -- --out <path>` writes that hex file with mode `0600` and `fsync`. Then set `PUBKY_BOT_SECRET_KEY_FILE` to the same path.

Kill switches: Postgres `switches` plus `JEB_SWITCH_*` / `JEB_DISABLED`. Admin: `POST /admin/switch/{name}` on `JEB_ADMIN_PORT` (loopback), `Authorization: Bearer $ADMIN_TOKEN` (404 if unset). `/healthz` and `/metrics` bind `127.0.0.1` by default (`JEB_BIND` override).

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
npm run build && npm run build:contract
```

Voice spec in `docs/voice.md`; `npm run eval:voice` runs the offline voice eval (live pass when `JEB_MODEL_API_KEY` is set). `npm run profile:publish -- --dry-run` prints the bot profile JSON; without `--dry-run` it PUTs `/pub/pubky.app/profile.json` under the bot key (operator-only; refuses under `JEB_CONTRACT_MODE=1` and the replies/global switches).

Contract (staging homeserver; do not echo the password file). The adapter is **not** in the product `dist/`; use `dist-contract/` and `JEB_CONTRACT_MODE=1`:

```bash
cd /Volumes/vibedrive/vibes-dev/jeb-contract
CONTRACT_HOMESERVER=staging \
CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test \
JEB_CONTRACT_MODE=1 \
CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot-jeb/dist-contract/contract-adapter.js \
npm test
```

The adapter starts `--role ingest|reason|publish` child processes from `dist/main.js` and refuses to start unless `JEB_CONTRACT_MODE=1` and the Nexus URL is loopback.

## Docker

`Dockerfile` and `docker-compose.yml` are written (non-root, three services, publish-only key env, `read_only` + `cap_drop: [ALL]`, Postgres on `127.0.0.1` only, password required). Compose does not bind-mount source or `.env`.

Base image is `node:20-bookworm-slim`; **digest pin is optional and not applied**. Retag a digest in a fork if you need reproducible pulls.

**Image build is UNVERIFIED** — Docker daemon was hung on this machine. Validate compose with `POSTGRES_PASSWORD=x JEB_BOT_PK=x PUBKY_BOT_SECRET_KEY_HEX=00… docker compose config`.
