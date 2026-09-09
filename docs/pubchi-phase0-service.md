# Pubchi Phase 0 service

Read-only hosted Pubchi. Two trust domains only: **Gateway/API** and **Reason/NLQ**. No scheduler, no publisher, no session broker, no bot key.

Process entry: `npm run pubchi` or `node dist/main.js --role pubchi`. `npm run pubchi` runs `node --preserve-symlinks --preserve-symlinks-main --import tsx` so `src/pubchi` → `../bot-kit` resolves through the `src/` symlink tree. `NODE_OPTIONS=--preserve-symlinks` is not used: this repo's `node_modules` is a symlink and that flag breaks the `tsx` `.bin` shim. Compiled `dist/main.js` is unchanged. The public role checks migration state without DDL; the dedicated `node dist/main.js --role pubchi-migrate` mode is the only Pubchi migration executor and exits without HTTP.

`--role pubchi` pins the feed brain to `PHASE0_BRAIN.model_id` (`kimi-k3`). `JEB_MODEL` is ignored for this role so a leftover `gpt-4o-mini` default cannot make every `/v1/feed` fail as `BRAIN_UNAVAILABLE`.

## Staging vs production

Write this down once: **defaults are mixed on purpose.**

| Dependency | Default | Notes |
| --- | --- | --- |
| Nexus (`JEB_NEXUS_URL`) | `https://nexus.staging.pubky.app` | Staging graph/search. Override for production Nexus. |
| Homeserver (`JEB_HOMESERVER`) | unset | Tenant resolution uses Pubky `publicStorage` (pkarr + the asker's homeserver). A local/dev homeserver is fine. |
| Scout (`JEB_SCOUT_URL`) | `https://nexus-scout.pubky.app` | **Production** Scout host. This is not a staging URL. |

Dev/staging Pubchi may therefore read staging Nexus and production Scout at the same time. That is the documented default, not a mislabel.

## Endpoints

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | `{ ok: true, role: "pubchi", mode: "runtime" }` | Not pre-auth rate limited. |
| `POST` | `/v1/query` | `QueryResultV1` or `PubchiAnswerV1` | Purpose is `who-tagged-me` or `ask`. `who-tagged-me` is deterministic from Nexus user tags for the verified owner (no NLQ, no Scout). `ask` runs NLQ with `asker` forced to the verified owner and interprets graph evidence, never a verdict. |
| `POST` | `/v1/feed` | `FeedProposalV1` | Purpose must be `build-feed`. Brain structured output, then `pubky-app-specs`. `created_at` is set server-side. |

Request body:

```json
{ "request": { "...RequestObjectV1" }, "body": { "question": "who tagged me?" } }
```

`body` must be present (missing key → `SCHEMA_INVALID`). A missing value is hashed as `null`. `body.asker` / `body.scope` are ignored. The gateway forces `asker = U` and `scope.graph_scope.pubky = U` from the verified request + enrollment.

For `who-tagged-me`, Pubchi reads `GET /v0/user/<verified-owner>/tags` from Nexus
and maps each tagger to the owner's profile URI. This path is deterministic so a
natural-language planner cannot select unrelated Scout tools for a question with
a direct upstream answer. Nexus 404 is an honest empty result; upstream failures
return `UPSTREAM_UNAVAILABLE`.

For `purpose: "ask"`, the body is `{ "question": "..." }` with a trimmed question of 1–500
characters. The response is the strict version-1 `pubchi-answer` schema: it contains a
non-empty interpretation `summary`, up to 50 evidence items, source URIs, and the tool
trace summary. Unsupported questions and refusals return HTTP 200 with an empty evidence
array and a plain-language summary. Routing covers graph-shaped requests with typed tools:
follower rankings use `rank_users(metric: followers)`, tag questions use
`get_tag_landscape` or `get_emerging_topics`, topic/thread questions use
`get_topic_brief` or `top_posts`, and follow recommendations, stale follows, paths, and
trust questions use their corresponding graph tools. The asker is supplied as the graph
scope for owner-relative requests.

The brain is called only when screened evidence exists. Its JSON may be prose-wrapped or
fenced, but must contain only `{ "summary": string }`; summaries naming a Pubky absent from
the evidence are rejected. Deterministic summaries receive the same check and fall back
when rejected. If output is invalid, times out, or errors, Pubchi returns a
deterministic summary from the screened evidence. With no evidence, it names the lookup
that was attempted and suggests actionable rephrasings without claiming facts. The
`pubchi_ask` log records `summary_source` as `deterministic`, `deterministic_rejected`, `brain`,
`fallback_invalid_json`, `fallback_empty`, `fallback_brain_error`, `fallback_timeout`,
or `skipped_no_evidence`.
Structured homogeneous routes use deterministic summaries: `nexus_influencers`/`rank_users`
map to follower counts, `tag_landscape` to tag claimant counts,
`recommend` to mutual-follower counts, `stale_follows` to inactive accounts,
and `top_posts` to authors and reply counts. Mixed or heterogeneous routes
continue to use the brain. The App should map `tool_trace_summary.tools` to evidence
labels as follows: planned `nexus_influencers` (trace `nexus_influencer`) and
`rank_users` → “Followers”; planned `get_tag_landscape` (trace `tag_landscape`) →
“Tagged by”; planned `recommend_follows` (trace `recommend`) → “Claimants”;
`top_posts` → “Replies”; `stale_follows` → “Claimants”; and all other tools →
“Claimants”.

Scout mention keys are logged as HMAC pseudonyms, using `PUBCHI_LOG_HASH_KEY` when
configured. If unset, a random per-process key is used; pseudonyms are linkable only
within that key lifetime and are not a substitute for access control.

The verifier order is **body parse/schema → signature → route↔purpose (pure) →
tenant → delegation → nonce → budget**. The route↔purpose check runs before
any tenant or delegation read and returns `PURPOSE_UNSUPPORTED` without
revealing tenant or delegation state. The service resolves the bot from the
owner's state and preserves the request-bot check before the delegation
decision; after the pure route check, the delegation lookup may be initiated
concurrently with tenant resolution. Nonce consumption remains after tenant
and delegation authorization.

Errors are `{ "error": "<CODE>" }` only. Whitelisted codes:

- Schema/verifier: `SCHEMA_INVALID`, `VERSION_UNSUPPORTED`, `UNKNOWN_FIELD`, `FORBIDDEN_*`, `INVALID_PUBKY`, `TIER_UNSUPPORTED`, `BRAIN_FORBIDDEN`, `BUDGET_NOT_FIXED`, `FEED_SPECS_INVALID`, `FEED_UNSUPPORTED_LIKES`, `FEED_UNSUPPORTED_REACH`, `REQUEST_MALFORMED`, `SIGNATURE_INVALID`, `REQUEST_EXPIRED`, `CLOCK_SKEW`, `NONCE_REPLAY`, `BODY_HASH_MISMATCH`, `ASKER_MISMATCH`, `BOT_MISMATCH`, `PURPOSE_UNSUPPORTED`, `PATH_FORBIDDEN`, `URI_FORBIDDEN`
- Service: `TENANT_NOT_ENROLLED`, `BUDGET_EXCEEDED`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `BRAIN_UNAVAILABLE`

HTTP status: `200` success; `400` most verify/schema failures; `404` `TENANT_NOT_ENROLLED`; `429` `BUDGET_EXCEEDED` / `RATE_LIMITED`; `503` `UPSTREAM_UNAVAILABLE` / `BRAIN_UNAVAILABLE`.

Every non-2xx response logs **one** pino line at level 40 (`warn`) with `code`, `stage` (`verify` | `tenant` | `query` | `feed` | `upstream`), `status`, and a sanitized `cause` (no prompt text, no keys). Upstream call failures also include `upstream_host` (host[:port]) and `upstream_status`. Tenant resolution does not log on its own.

### CORS

Browser callers (Pubky App on `http://localhost:3001`) need an explicit origin allowlist. Set `PUBCHI_ALLOWED_ORIGINS` to a comma-separated list of exact origins.

| Request | Allowlisted `Origin` | Unknown `Origin` or empty env |
| --- | --- | --- |
| `OPTIONS` preflight | `204` + `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type, accept`, `Access-Control-Max-Age: 600` | `204` with **no** ACAO headers (browser blocks; this is not auth) |
| `POST` success or error | same `Access-Control-Allow-Origin` + `Vary: Origin` | no CORS headers; the handler still runs |

Never `*`. Never reflect an unknown origin. Never `Access-Control-Allow-Credentials`. Empty / unset `PUBCHI_ALLOWED_ORIGINS` sends no CORS headers at all (server-to-server). App `fetch` sends `content-type` and `accept`.

## Trust domains

Present in Phase 0:

1. **Gateway/API** — bind, body cap, timeout, pre-auth rate limit, request-object verify, tenant resolve, token bucket, response codes. No session, no provider key in this module.
2. **Reason/NLQ** — Bot Kit NLQ (`asker` forced), Scout budgets keyed `pubchi:<U>` (owner only), brain via `createBrain({ id, model: PHASE0_BRAIN.model_id, ... })` from `JEB_BRAIN` / `JEB_MODEL_*`. A brain error is `BRAIN_UNAVAILABLE`. No fallback. Redirects on the model HTTP path are refused so `Authorization` cannot leave the allowlisted host.

Absent until later phases: scheduler, publisher, session broker, homeserver PUT,
`PUBKY_BOT_SECRET_KEY*`, and bot write credentials. Budgets remain keyed by owner,
not bot.

Tenant resolution uses public GETs through Pubky `publicStorage` (no session,
5 s timeout), keyed and cached by owner U:

The canonical, binding, config, and signer-delegation reads share one per-owner
fetch bucket: at most 24 homeserver GETs immediately, then 30 more per 60 seconds.
Thus a signed request that misses both caches is bounded by the remaining owner
budget, never by the attacker's supply of rotated signers.

1. Read `pubky://U/pub/pubchi.app/bot.json` and derive canonical bot B and
   `key_generation`.
2. Require the signed request to name B. A different request bot is rejected
   before any binding or delegation read and is opaque `UNAUTHORIZED` to
   signer-bearing callers.
3. Read `pubky://U/pub/pubchi.app/bots/<B>.json`; require an active binding and
   the same generation.
4. Read `pubky://U/pub/pubchi.app/config.json`. A 404 selects the read-only
   default. Other read/parse failures fail closed.
5. Compute the effective tier as the minimum of the configured preference,
   verified credential ceiling, active switches, and budget capability. The v1
   build ceiling is `assisted`, because the service holds no B credential.
   Configuring `autonomous` therefore logs
   `autonomous_tier_capped_at_assisted` and resolves as assisted.

For existing shared-bot enrollments only, a missing `bot.json` falls back to the
request-named `bots/<B>.json`. An active legacy binding resolves read-only and
logs `legacy_binding_without_bot_json` once per owner per cache window. A
present canonical `bot.json` never falls back.

The positive tenant document set expires 15 seconds after the cold resolution
finishes, aligned with the device-delegation cache. This bounds tier downgrades
and bot re-mints to 15 seconds plus the fetch span from the beginning of the
cold resolution: at most 30 seconds under the 5-second-per-read timeout and
three sequential tenant reads. The corresponding delegation bound is at most
20 seconds (one 5-second read plus the 15-second cache window). A slow fetch is
therefore still warm immediately after completion instead of being stamped
expired by its start time. Each cold tenant resolution adds up to three public
homeserver GETs and one limiter token is consumed per GET. Authoritative tenant
misses cache for 60 seconds; upstream failures cache for 30 seconds.
Delegations still cache positively for 15 seconds and re-verify owner, bot,
purpose, and expiry on every hit.

`config.brain` is recorded-only in v1. The service uses the deployment brain
until self-hosted brain serving exists; this applies to every tenant regardless
of the configured provider or model.

All currently served purposes (`ask`, `who-tagged-me`, and `build-feed`) require
at least read-only. Assisted publication remains client-side after explicit
approval; no served v1 endpoint requires assisted server authority. The
purpose-to-endpoint and purpose-to-minimum-tier tables are exhaustive schema
constants, so a new served purpose must declare both.

Nonces are unique per `(bot, asker)` in `pubchi_nonces` (migration `108_pubchi.sql`). Rows remain retained until `expires_at` is older than the verifier's `CLOCK_SKEW_SECONDS` tolerance, so replay protection covers the full accepted expiry window. Expired rows are deleted every 32 inserts and by the periodic sweeper.

Daily token reservations are atomic per owner UTC day in `pubchi_budget_day` (migration `109_pubchi_budget.sql`). Failed requests refund the reservation; success settles a `token_usage` row.

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `PUBCHI_PORT` | `3015` | Listen port |
| `PUBCHI_BIND` | `127.0.0.1` | Loopback unless `PUBCHI_BIND_DANGEROUS=1` |
| `PUBCHI_BIND_DANGEROUS` | unset | Required for a non-loopback bind |
| `PUBCHI_DAILY_TOKEN_CEILING` | `200000` | Per-**owner** UTC-day tokens (`mention_key = pubchi:<U>`). The window is `date_trunc` in UTC, not the Postgres session timezone. |
| `PUBCHI_PER_REQUEST_TOKEN_CAP` | `10000` | Clamp on a single reserve/charge. Actual query/feed charges use the effective tenant's literal per-tier budgets: read-only output is 2000 and assisted output is 4000. |
| `PUBCHI_BODY_MAX_BYTES` | `65536` | Request body cap |
| `PUBCHI_REQUEST_TIMEOUT_MS` | `30000` | Slowloris bound |
| `PUBCHI_BUCKET_RATE_PER_SEC` | `2` | Per-**owner** token bucket refill |
| `PUBCHI_BUCKET_BURST` | `10` | Per-**owner** burst |
| `PUBCHI_PREAUTH_RPS` | `20` | Global pre-auth bucket (before parse/verify) |
| `PUBCHI_PREAUTH_BURST` | `40` | Global pre-auth burst |
| `PUBCHI_PREAUTH_IP_RPS` | `5` | Per-remote-address pre-auth refill |
| `PUBCHI_PREAUTH_IP_BURST` | `10` | Per-remote-address burst |
| `PUBCHI_TRUST_PROXY` | unset | Honour `X-Forwarded-For` **only** when set to `1`. The service binds loopback and is expected behind a proxy. |
| `DATABASE_URL` | — | Runtime Postgres URL for `--role pubchi` only. The migrator `DATABASE_URL` belongs solely to the separate `--role pubchi-migrate` service and is not a runtime alternative. `JEB_DB_URL_REASON` is forbidden. |
| `JEB_BRAIN` / `JEB_MODEL_*` | moonshot | Brain adapter/key/base URL. Model id for this role is `kimi-k3` from `PHASE0_BRAIN`. Egress allowlist unchanged; redirects refused. |
| `JEB_SCOUT_*` / `JEB_NEXUS_URL` | see table above | NLQ/Scout. The process refreshes `/v1/schema` on start (same as `--role nlq`); without a live schema the planner fails closed as `UPSTREAM_UNAVAILABLE`. |
| `PUBCHI_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins. Empty = no CORS headers. |

Must be **absent**: `PUBKY_BOT_SECRET_KEY_HEX`, `PUBKY_BOT_SECRET_KEY_FILE`, `PUBKY_BOT_MNEMONIC`. Startup calls `assertNoKeyMaterial()`.

## Ops notes

In-memory maps (`preauth` per-IP buckets, tenant cache, owner token-bucket state) have no eviction; growth is bounded by the global preauth bucket (~20 inserts/s worst case) and resets on process restart (accepted for Phase 0).

## Latency

Each `/v1/query` and `/v1/feed` request emits one `pubchi_request_timing` log with monotonic millisecond stages:
`body_parse_schema`, `signature_verify`, `tenant_resolve`, `delegation_resolve`, `nonce_consume`,
`budget_reserve`, `handler`, handler sub-stages (`nexus_ms`, `nlq_ms`, `brain_ms` when applicable),
`response_serialize`, and `total`. The log also records tenant/delegation cache hit or miss without
including request text or owner identifiers. The response exposes the same names
through `Server-Timing` durations only on 2xx responses so the App can attribute
its visible request timer; the full breakdown and cache hit/miss remain
server-side only for failures.

The production observation was 3398 ms total for `who-tagged-me`; no per-stage log was available before
instrumentation, so the dominant service stage could not be named from that request. The in-process
happy-path harness after instrumentation measured 3 ms total with mocked verification, budget, and
Nexus dependencies; it is not a production comparison. A live public homeserver reader reused one
`Pubky` client for two consecutive reads: 591 ms then 185 ms (the second read benefits from warmed
resolution). The service already constructs this reader once per process, and the Scout schema is
loaded once at process start then refreshed by the process cache. Tenant success
caching is 15s after fetch completion, while authoritative 404 misses remain
cached for 60s; upstream failures remain cached for 30s. This keeps slow-fetch
resolutions warm after completion, with the stale positive-entry window bounded
by the fetch timeout and the documented 30s tenant / 20s delegation worst cases.

## Proof commands

```bash
npm run build
npx vitest run src/pubchi packages/pubchi-schemas packages/bot-kit/src/brain
# `packages/pubchi` is excluded in vitest.config.ts; `src/pubchi` is the same tree
# via the symlink so `../bot-kit` resolves the way the compiled process does.
```

Full `npm test` needs a reachable Postgres. Vitest creates and migrates `jeb_vitest` automatically (see `docs/test-database.md`). Do not point the suite at `jeb_stage1_test`.

Live smoke (parent): if `JEB_MODEL_API_KEY` is unset, mark live smoke **unverified**. Do not hunt for keys.

## What Phase 1 adds

Real bot enrollment and reciprocal ownership in App, portable public-state schemas and export/import, complete Brain negotiation/input/output, provider registry, and a production-ready replaceable-brain package. Still no hosted session in the default read-only path.
