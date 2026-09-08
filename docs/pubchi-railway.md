# Dedicated Pubchi Railway service

This service is a separate public, keyless deployment from the same repository.
Railway IaC must set `dockerfilePath` to `Dockerfile.pubchi`. Do not set a
Docker build target: new services cannot use the legacy `railway.toml` target
field, and IaC does not expose `--target`. The dedicated image starts only:

```text
node dist/main.js --role pubchi
```

It never uses `--role all`, and it must not share Jeb's publisher service or
its environment.

## Create the service

Create a new Railway service from this repository and set IaC
`dockerfilePath` to `Dockerfile.pubchi` (see `docs/pubchi-docker.md`).
`railway.pubchi.toml` is a legacy/dev reference with the same path; it is not
a substitute for IaC. The image default command is the dedicated role, and
Railway should still check `GET /healthz`.
Railway supplies `PORT`; leave `PUBCHI_PORT` unset so the process uses it.
`PUBCHI_BIND=0.0.0.0` and `PUBCHI_BIND_DANGEROUS=1` are required for Railway's
public proxy.

Required variable names and values/classes:

```text
DATABASE_URL                 Railway Postgres connection string
JEB_NEXUS_URL                exact https URL for the intended Nexus
JEB_SCOUT_URL                exact https URL for the intended Scout
JEB_BRAIN                    moonshot, openai-compatible, or ollama
JEB_MODEL_API_KEY            Railway secret; required unless JEB_BRAIN=ollama
JEB_TESTNET                  optional; defaults to 0, and if set must be 0 or 1
JEB_MODEL_BASE_URL           optional; only an allowlisted brain endpoint
PUBCHI_BIND                  0.0.0.0
PUBCHI_BIND_DANGEROUS        1
PUBCHI_ALLOWED_ORIGINS       comma-separated exact https origins; never *
PUBCHI_TRUST_PROXY           1
JEB_SWITCH_FEED              optional 0 or 1; 1 stops feed model calls
```

The remaining `PUBCHI_*` budget, body, timeout, bucket, and pre-auth variables
are optional and use the safe defaults in `.env.example`. Do not set
`JEB_DB_URL_REASON`: the Pubchi boot gate rejects it so this service cannot
silently select the Jeb reason role. `DATABASE_URL` must point to a dedicated
Pubchi database role, never the Jeb publisher role. `JEB_MODEL_BASE_URL`, when
set, and the required Nexus and Scout URLs must use `https://`. The Pubchi
tenant reader resolves homeserver public data from Pubky URIs and accepts no
homeserver URL or credential.

`JEB_SWITCH_FEED=1` is the deployment-level emergency stop and takes effect
after restart. The database `feed` switch is checked immediately before
reservation/model work, and the existing database global/kill switch remains
authoritative. Operators can stop only feed generation with the existing
database maintenance channel:

```sql
UPDATE switches SET on_flag = TRUE WHERE name = 'feed';
```

Set it back to `FALSE` only after the incident is understood. Scout remains a
separate switch; disabling Scout does not implicitly enable or disable feed
generation.

The boot gate rejects these names when present, even if empty values are not
used by the application:

```text
PUBKY_BOT_SECRET_KEY_HEX
PUBKY_BOT_SECRET_KEY_FILE
PUBKY_BOT_MNEMONIC
JEB_SKIP_MIGRATIONS
JEB_SIGNUP_TOKEN
JEB_HOMESERVER
ADMIN_TOKEN
JEB_GITHUB_TOKEN
GITHUB_TOKEN
GH_TOKEN
JEB_DB_URL_INGEST
JEB_DB_URL_REASON
```

Homeserver URL, signup, and publisher identity settings are deliberately not
part of this service. Tenant enrollment reads public homeserver data through
the Pubky SDK; no homeserver credential is accepted by the deployment.

## Database and health

Deploy the separate migration service first with IaC `dockerfilePath`
`Dockerfile.pubchi-migrate` (`railway.pubchi-migrator.toml` is legacy/dev
reference only). Its command is exactly:

```text
node dist/main.js --role pubchi-migrate
```

This explicit mode uses only `DATABASE_URL`, applies the checked-in
Pubchi-only source migration manifest under
`src/infrastructure/database/pubchi-migrations/`, which the build copies to
`dist/infrastructure/database/pubchi-migrations/` and which the packaged
runtime actually reads. It logs
`"role":"pubchi-migrate","mode":"migration"` in its JSON output, and exits
without starting HTTP. The public service command remains exactly:

```text
node dist/main.js --role pubchi
```

The public runtime never runs DDL. It performs only read-only
`public.pubchi_migrations` state queries before listening and exits if any
manifest version, filename, or checksum is missing or mismatched.

Backlog (out of this split): `--role nlq` still runs `runMigrations()` at boot.
That is a Jeb NLQ process concern, not a Pubchi runtime/migrator defect; do not
fold NLQ DDL into `pubchi-migrate`.
Its `/healthz` response identifies `role: "pubchi", mode: "runtime"`.
Neither service accepts an alternate database URL variable.

Railway's health check is `GET /healthz`. It returns `200` only when the
configuration boot gate passed, `SELECT 1` succeeds, and every checked-in
migration is recorded as applied. It returns `503` with only boolean readiness
fields otherwise. It does not call the model, Scout, Nexus, or any upstream
write path. The response contains no URL, token, prompt, or database detail.

### Database role prerequisite

Create a dedicated Pubchi database and two logins. The manifest uses the
PostgreSQL `public` schema; it does not create a separate schema. Do not reuse
the Jeb publisher's application role. The `pubchi_migrator` role should own
the dedicated database (or otherwise have `USAGE` and `CREATE` on schema
`public`) and have only the DDL privileges needed to apply the checked-in
Pubchi manifest. The `pubchi_runtime` role should have
`CONNECT` on that database, `USAGE` on schema `public`, `SELECT` on
`pubchi_migrations`, `switches`, and `kill_switch`, and only the minimum
`SELECT`/`INSERT`/`UPDATE`/`DELETE` privileges on `pubchi_nonces`,
`pubchi_budget_day`, and `token_usage`. It also needs `SELECT` and `INSERT`
on `scout_queries` (NLQ daily budget counts plus ScoutClient audit inserts;
the runtime never `UPDATE`s or `DELETE`s that table). It should have no
privileges on publisher tables such as `posts`, `drafts`, `publish_requests`,
or `work_queue`.

Revoke `CREATE` on schema `public` from `PUBLIC` and from `pubchi_runtime`
after migration, and do not grant the runtime role ownership, `CREATE`,
`ALTER`, `DROP`, or sequence ownership. Grant the runtime role `USAGE` on
`public` and only the table privileges above. Because `token_usage.id` and
`scout_queries.id` are `BIGSERIAL`, grant `USAGE, SELECT` on
`public.token_usage_id_seq` and `public.scout_queries_id_seq` as well.
This
repository does not perform database work; operators must apply these grants
using their normal Railway Postgres administration path. The two Railway
services each receive their own `DATABASE_URL`: migrator credentials are set
only on the migration service, and runtime credentials only on the public
service. Never copy Jeb bot, signer, admin, signup, GitHub, or model secrets
into the migration service.

## CORS and proxy

`PUBCHI_ALLOWED_ORIGINS` is an exact comma-separated origin allowlist. Unknown
origins receive no CORS headers, and `*` is rejected. `PUBCHI_TRUST_PROXY=1`
allows the first `X-Forwarded-For` address to participate in the pre-auth
rate limiter; it must remain unset when the service is directly exposed
without a trusted proxy.

## Rollout and rollback

1. Create the dedicated database and `pubchi_migrator` /
   `pubchi_runtime` roles; apply the grants above.
2. Create the Railway migration service with IaC `dockerfilePath`
   `Dockerfile.pubchi-migrate`. Set only its migrator `DATABASE_URL` and
   non-secret build/runtime values. Do not add a public domain or model,
   signer, bot, admin, signup, GitHub, or alternate database URL variables.
   The migrator must target a dedicated empty Pubchi database, never the Jeb
   publisher database. The Pubchi runner never reads or executes the
   historical Jeb migration directory and never creates extensions, vector
   types, or Jeb publisher/knowledge tables.
3. Run the migration service once and confirm logs show
   `"role":"pubchi-migrate","mode":"migration"` in its JSON log output, then
   confirm the process exited 0.
4. Create the public service with IaC `dockerfilePath` `Dockerfile.pubchi`. Set its runtime
   `DATABASE_URL`, the required Nexus/Scout/model configuration, and the
   documented public bind values. Never set `JEB_DB_URL_REASON` or any
   migrator URL variable.
5. Confirm `/healthz` returns `200` with `role: "pubchi"` and
   `mode: "runtime"`; confirm logs contain
   `"role":"pubchi","mode":"runtime"` and no migration DDL activity.
6. Point the App integration at the public service only after readiness is
   green.

For a negative deployment check, temporarily omit one migration ledger row in
a disposable database or use a runtime role against a database that has not
run the migration service. The runtime must exit before listening; restore the
database state before traffic. Alternate database URL variable names are
rejected by the boot gate. A wrong credential value in `DATABASE_URL` is
protected by the Postgres role grants and fails closed with a database
permission error; the boot gate cannot inspect or identify credential values.

The prior dedicated deployment
`6560004f-0206-4fec-aa15-271171ec6d92` failed before HTTP while attempting
historical `020_knowledge.sql`; it made no intended Pubchi schema changes.
Verify the dedicated database is empty or inspect only its migration ledger
before retrying. Do not grant extension or superuser privileges. A failed run
of the Pubchi runner is safely retryable: each migration is transactional,
the separate ledger records only committed versions, and checksum/version
mismatches fail closed instead of being overwritten. Rerun the same migrator
against the same database after correcting role grants; do not manually insert
ledger rows.

If the migration run fails, fix the database/grant issue and rerun the
dedicated migration service; it is idempotent. If the public service fails
readiness, keep it out of traffic and rerun the migration service against the
same database. Roll back the public image only after the database is known to
contain the migrations required by that image. Never roll back to the Jeb
`--role all` service as a substitute, and never run production SQL from this
repository.

Proof of keylessness is an environment inspection of the Railway service
variable names plus the boot gate's explicit rejection list. The dedicated
image contains the compiled `dist/` bundle needed to start `src/main.ts` plus
shared read-only Bot Kit / Pubchi / schema sources; it is started with the
fixed Pubchi entrypoint, and the boot gate rejects publisher key variables
before listening. It does not bake Jeb embedding cache or `sources.yaml`.

Every stage in `Dockerfile.pubchi` and `Dockerfile.pubchi-migrate` is pinned to
the same verified `node:20-bookworm-slim` digest as the Jeb `Dockerfile`.
