# Jeb (pubky-ai-bot)

Postgres-only Pubky answer bot extracted from jeb-slim (ADR 0001). Redis is gone.

## Architecture

Three OS processes, one codebase:

| Role | Command | Keys | Job |
| --- | --- | --- | --- |
| ingest | `node dist/main.js --role ingest` | none (`JEB_BOT_PK` only) | Poll Nexus, claim `handled_mentions`, enqueue `work_queue` |
| reason | `node dist/main.js --role reason` | none (fails if key env is set) | Policy, intent, tool loop, evidence, `publish_requests` |
| publish | `node dist/main.js --role publish` | `PUBKY_BOT_SECRET_KEY_HEX` (or file / mnemonic) | Validate, SDK PUT, readback, idempotent reconcile |
| ingest-knowledge | `node dist/main.js --role ingest-knowledge [--full]` | none | One-shot corpus ingest, logs stats JSON, exits |
| requeue | `node dist/main.js --role requeue --mention <uri> [--mention <uri> …]` | none (`JEB_BOT_PK` only) | Operator one-shot: reopen skipped/failed mentions and enqueue work |

`--role all` spawns the three as **child processes** (not threads) and strips key env from ingest/reason. If `knowledge_chunks` is empty it logs `knowledge corpus empty; run --role ingest-knowledge` and still starts. Default Nexus poll interval is `JEB_POLL_MS=3000`. Production images bake `Xenova/bge-small-en-v1.5` into `/app/.cache/jeb-models` (`JEB_MODEL_CACHE`); the reason process warms embeddings at startup. Railway corpus load: `node dist/main.js --role ingest-knowledge --full`.

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

`npm run post:publish -- --dry-run --file <path>` prints a validated standalone post JSON and homeserver path. Without `--dry-run` it PUTs the post under the bot key, reads it back from public storage, and prints the `pubky://` URI plus `${JEB_APP_URL}/post/<pk>/<id>`. `--kind short|long` (default `short`); long files may be plain text or JSON `{title, body}` (that JSON object is stored as `content`). Specs enforce 2000 / 50000 character limits. Same key loading, contract-mode refusal, and replies/global switch gating as profile publish. Voice-linter hits print as warnings and do not block. Operator-only; do not run the live PUT from CI. `--edit <postId>` overwrites an existing post in place (same URI; Nexus re-indexes it); existing attachments are dropped unless repeated with `--keep-attachment <file uri>`.

Public numeric caps (thread, hourly, budget) are listed in `docs/limits.md`. Confirm live values with the dashboard header.

## Operations: dashboard and corrections

Read-only evidence report over Postgres (`DATABASE_URL`). Does not load key material. Default window is 24h.

```bash
npm run dashboard -- --since 24h
npm run dashboard -- --since 7d --json
npm run dashboard -- --since 2026-09-01T00:00:00.000Z --markdown-file /tmp/jeb-dashboard.md
```

Reply latency is `publish_requests.updated_at - handled_mentions.created_at` (ingest claim → published request). Scout / web-search failures come from `scout_queries.ok` and `web_queries.ok`. There is no `security_event` table; the Security section counts `evidence.intent = 'decline'`.

Staff corrections **do not edit history**. They insert a `corrections` row. Jeb does not auto-post a follow-up; publish that separately.

```bash
npm run correct -- --reply 'pubky://<bot-pk>/pub/pubky.app/posts/<id>' --reason 'wrong product name' --by alice \
  --correct-answer 'Ring is the signer app.'
# export new rows as eval/questions YAML (fetches original mention text from Nexus; not stored in evidence):
npm run correct -- --export-eval ./eval/questions
# follow-up public correction (operator, uses the bot key):
npm run post:publish -- --dry-run --file ./correction-post.txt
# live:
# npm run post:publish -- --file ./correction-post.txt
```

`JEB_BOT_PK` must match the reply URI author. `JEB_NEXUS_URL` is used only for `--export-eval`.

### Requeue skipped or failed mentions

Use this when a policy bug skipped a real user and you want the reason/publish loop to answer them. It does not need key material (same as ingest-knowledge). Honours `JEB_SKIP_MIGRATIONS=1`. Fetches each post from Nexus (`JEB_NEXUS_URL`), confirms it mentions the bot or replies to a bot post, sets `handled_mentions` to `processing` (clears `skip_reason` / `fallback_reason`), and `enqueueWork` as `mention` or `reply`. Already-published rows are left alone.

Prints one line per URI (`requeued <uri>` or `skipped <uri>: <reason>`) and exits 0 only if every URI was requeued. Pass repeated `--mention` flags (plain argv; no shell quoting tricks required):

```bash
node dist/main.js --role requeue --mention 'pubky://<pk>/pub/pubky.app/posts/<id>'
# production container:
# railway ssh --service jeb -- node dist/main.js --role requeue --mention <uri>
```

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

## Knowledge ingest

Repo docs are `kind: git` (public GitHub, pinned default-branch `ref`). Ingest shallow-clones each repo; it does not need `/Volumes` paths in the container. Operator articles are `kind: pubky-collection` (Nexus `GET /v0/post/{author}/{id}`, cited as `JEB_APP_URL/post/{author}/{id}`). Local `synonym-articles-*` entries are `enabled: false`. Bounded websites are `kind: http-site` (same-host crawl, robots.txt, `max_pages`). `JEB_SOURCES_SKIP_LOCAL=1` skips remaining local sources even when the path exists. Citations in replies use `JEB_APP_URL` (default `https://pubky.app`), never raw `pubky://` URIs.
