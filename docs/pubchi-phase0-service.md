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
array and a plain-language summary. If the brain cannot produce valid output, Pubchi
returns a deterministic non-empty summary from the screened evidence.

Parse, expiry, signature, body hash, and nonce consume run **before** tenant resolution. Owner/bot equality against the tenant runs after.

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

Absent until later phases: scheduler, publisher, session broker, homeserver PUT, `PUBKY_BOT_SECRET_KEY*`, bot allowlist, reciprocal verification (Phase 1). Enrollment is self-asserted (`pubky://U/pub/pubchi.app/bots/B.json`); that is why budgets are keyed by owner, not bot.

Tenant enrollment is a public GET of `pubky://U/pub/pubchi.app/bots/B.json` through Pubky `publicStorage` (no session, 5 s timeout). `TenantV1` or an active `OwnerBindingV1` enrolls; 404 is `TENANT_NOT_ENROLLED`; any other tier is `TIER_UNSUPPORTED`. Success/404 cache TTL 60s. `UPSTREAM_UNAVAILABLE` is negative-cached 30s per `(asker, bot)`.

Nonces are unique per `(bot, asker)` in `pubchi_nonces` (migration `108_pubchi.sql`). Expired rows are deleted every 32 inserts and by a 60 s sweeper.

Daily token reservations are atomic per owner UTC day in `pubchi_budget_day` (migration `109_pubchi_budget.sql`). Failed requests refund the reservation; success settles a `token_usage` row.

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `PUBCHI_PORT` | `3015` | Listen port |
| `PUBCHI_BIND` | `127.0.0.1` | Loopback unless `PUBCHI_BIND_DANGEROUS=1` |
| `PUBCHI_BIND_DANGEROUS` | unset | Required for a non-loopback bind |
| `PUBCHI_DAILY_TOKEN_CEILING` | `200000` | Per-**owner** UTC-day tokens (`mention_key = pubchi:<U>`). The window is `date_trunc` in UTC, not the Postgres session timezone. |
| `PUBCHI_PER_REQUEST_TOKEN_CAP` | `10000` | Clamp on a single reserve/charge. Actual charges are **1** token for `/v1/query` and **2000** (`per_request_output_tokens`) for `/v1/feed`. The feed path also rejects a question whose estimated input tokens exceed 8000 and passes `maxOutputTokens=2000` to the model. |
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
