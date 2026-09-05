# Pubchi Phase 0 service

Read-only hosted Pubchi. Two trust domains only: **Gateway/API** and **Reason/NLQ**. No scheduler, no publisher, no session broker, no bot key.

Process entry: `npm run pubchi` or `node dist/main.js --role pubchi`. A `pubchi` role was added next to `nlq` so the process shares `parseRole`, migrations, `assertNoKeyMaterial`, and SIGINT/SIGTERM instead of a second script that would drift.

## Endpoints

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/healthz` | `{ ok: true, role: "pubchi" }` | |
| `POST` | `/v1/query` | `QueryResultV1` | Purpose must be `who-tagged-me`. NLQ `asker` is the verified owner. |
| `POST` | `/v1/feed` | `FeedProposalV1` | Purpose must be `build-feed`. Brain structured output, then `pubky-app-specs`. |

Request body:

```json
{ "request": { "...RequestObjectV1" }, "body": { "question": "who tagged me?" } }
```

`body.asker` / `body.scope` are ignored. The gateway forces `asker = U` and `scope.graph_scope.pubky = U` from the verified request + enrollment.

Errors are `{ "error": "<CODE>" }` only. Whitelisted codes:

- Schema/verifier: `SCHEMA_INVALID`, `VERSION_UNSUPPORTED`, `UNKNOWN_FIELD`, `FORBIDDEN_*`, `INVALID_PUBKY`, `TIER_UNSUPPORTED`, `BRAIN_FORBIDDEN`, `BUDGET_NOT_FIXED`, `FEED_SPECS_INVALID`, `FEED_UNSUPPORTED_LIKES`, `FEED_UNSUPPORTED_REACH`, `REQUEST_MALFORMED`, `SIGNATURE_INVALID`, `REQUEST_EXPIRED`, `CLOCK_SKEW`, `NONCE_REPLAY`, `BODY_HASH_MISMATCH`, `ASKER_MISMATCH`, `BOT_MISMATCH`, `PURPOSE_UNSUPPORTED`, `PATH_FORBIDDEN`, `URI_FORBIDDEN`
- Service: `TENANT_NOT_ENROLLED`, `BUDGET_EXCEEDED`, `UPSTREAM_UNAVAILABLE`, `BRAIN_UNAVAILABLE`

HTTP status: `200` success; `400` most verify/schema failures; `404` `TENANT_NOT_ENROLLED`; `429` `BUDGET_EXCEEDED`; `503` `UPSTREAM_UNAVAILABLE` / `BRAIN_UNAVAILABLE`.

## Trust domains

Present in Phase 0:

1. **Gateway/API** — bind, body cap, timeout, request-object verify, tenant resolve, token bucket, response codes. No session, no provider key in this module.
2. **Reason/NLQ** — Bot Kit NLQ (`asker` forced), Scout budgets keyed `pubchi:<B>:<U>`, brain via `createBrain({ id: "moonshot", ... })` from `JEB_MODEL_*` / `JEB_BRAIN`. A brain error is `BRAIN_UNAVAILABLE`. No fallback.

Absent until later phases: scheduler, publisher, session broker, homeserver PUT, `PUBKY_BOT_SECRET_KEY*`.

Tenant enrollment is a public GET of `pubky://U/pub/pubchi.app/bots/B.json` through Pubky `publicStorage` (no session). `TenantV1` or an active `OwnerBindingV1` enrolls; 404 is `TENANT_NOT_ENROLLED`; any other tier is `TIER_UNSUPPORTED`. Cache TTL 60s.

Nonces are unique per `(bot, asker)` in `pubchi_nonces` (migration `108_pubchi.sql`).

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `PUBCHI_PORT` | `3015` | Listen port |
| `PUBCHI_BIND` | `127.0.0.1` | Loopback unless `PUBCHI_BIND_DANGEROUS=1` |
| `PUBCHI_BIND_DANGEROUS` | unset | Required for a non-loopback bind |
| `PUBCHI_DAILY_TOKEN_CEILING` | `200000` | Per-tenant UTC-day tokens (`token_usage.mention_key = pubchi:<B>:<U>`) |
| `PUBCHI_PER_REQUEST_TOKEN_CAP` | `10000` | Reserved/charged per request |
| `PUBCHI_BODY_MAX_BYTES` | `65536` | Request body cap |
| `PUBCHI_REQUEST_TIMEOUT_MS` | `30000` | Slowloris bound |
| `PUBCHI_BUCKET_RATE_PER_SEC` | `2` | Per-tenant token bucket refill |
| `PUBCHI_BUCKET_BURST` | `10` | Per-tenant burst |
| `DATABASE_URL` / `JEB_DB_URL_REASON` | — | Postgres |
| `JEB_MODEL_*` / `JEB_BRAIN` | moonshot | Brain only; egress allowlist unchanged |
| `JEB_SCOUT_*` / `JEB_NEXUS_URL` | staging defaults | NLQ/Scout |

Must be **absent**: `PUBKY_BOT_SECRET_KEY_HEX`, `PUBKY_BOT_SECRET_KEY_FILE`, `PUBKY_BOT_MNEMONIC`. Startup calls `assertNoKeyMaterial()`.

## Proof commands

```bash
npm run build
npx vitest run src/pubchi
# `packages/pubchi` is the same tree via `src/pubchi` → `../packages/pubchi/src`.
# Vitest runs `src/pubchi` so `../bot-kit` resolves the way the compiled process does.
```

Full `npm test` needs a reachable Postgres (`DATABASE_URL`, typically `jeb_service_test` or `jeb_stage1_test`). Create with:

```bash
psql postgres://johncarvalho@127.0.0.1:5432/postgres -c 'CREATE DATABASE jeb_service_test;'
```

Live smoke (parent): if `JEB_MODEL_API_KEY` is unset, mark live smoke **unverified**. Do not hunt for keys.

## What Phase 1 adds

Real bot enrollment and reciprocal ownership in App, portable public-state schemas and export/import, complete Brain negotiation/input/output, provider registry, and a production-ready replaceable-brain package. Still no hosted session in the default read-only path.
