# Dedicated Pubchi Railway service

This service is a separate public, keyless deployment from the same repository.
It runs the `pubchi` Docker target and starts only:

```text
node dist/main.js --role pubchi
```

It never uses `--role all`, and it must not share Jeb's publisher service or
its environment.

## Create the service

Create a new Railway service from this repository and set its Railway
configuration file to `railway.pubchi.toml`. The file selects the `pubchi`
Docker target, starts the dedicated role, and checks `GET /healthz`.
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
JEB_SIGNUP_TOKEN
JEB_HOMESERVER
ADMIN_TOKEN
JEB_GITHUB_TOKEN
GITHUB_TOKEN
GH_TOKEN
```

Homeserver URL, signup, and publisher identity settings are deliberately not
part of this service. Tenant enrollment reads public homeserver data through
the Pubky SDK; no homeserver credential is accepted by the deployment.

## Database and health

Deploy with migrations enabled. Do not set `JEB_SKIP_MIGRATIONS=1`. Startup runs
all checked-in migrations, including `108_pubchi.sql` and
`109_pubchi_budget.sql`, before binding the public listener.

Railway's health check is `GET /healthz`. It returns `200` only when the
configuration boot gate passed, `SELECT 1` succeeds, and every checked-in
migration is recorded as applied. It returns `503` with only boolean readiness
fields otherwise. It does not call the model, Scout, Nexus, or any upstream
write path. The response contains no URL, token, prompt, or database detail.

### Database role prerequisite

Create a dedicated `pubchi_runtime` login on a dedicated Pubchi database; do
not reuse the Jeb publisher's application role. The runtime role should have
`CONNECT` on that database, `USAGE` on the service schema, `SELECT` on
`switches` and `kill_switch`, and only the minimum
`SELECT`/`INSERT`/`UPDATE`/`DELETE` privileges on `pubchi_nonces`,
`pubchi_budget_day`, and `token_usage`. It should have no privileges on
publisher tables such as `posts`, `drafts`, `publish_requests`, or
`work_queue`.

Use a separate `pubchi_migrator` owner/role to create and alter the schema,
then grant the runtime role only the table privileges above. This repository
does not perform that database change. Because the current process runs all
checked-in migrations before binding, the migration/serve credential split is
a deployment prerequisite: do not point `DATABASE_URL` at the Jeb publisher
role or claim this topology is least-privilege until migrations are run by
the separate role and the runtime grants are applied.

## CORS and proxy

`PUBCHI_ALLOWED_ORIGINS` is an exact comma-separated origin allowlist. Unknown
origins receive no CORS headers, and `*` is rejected. `PUBCHI_TRUST_PROXY=1`
allows the first `X-Forwarded-For` address to participate in the pre-auth
rate limiter; it must remain unset when the service is directly exposed
without a trusted proxy.

## Rollout and rollback

1. Apply the variables above to the new service only.
2. Deploy and wait for `/healthz` `200`.
3. Confirm the service logs show `role=pubchi` and no publisher role.
4. Send a deliberately invalid startup configuration in a disposable rollout
   (for example, remove `PUBCHI_ALLOWED_ORIGINS` while retaining the public
   bind) and confirm the process exits before listening; restore the variable
   before serving traffic.
5. Point the App integration at the service only after the health check is
   green.
6. Roll back to the previous Pubchi image if health or request probes fail.
   Never roll back to the Jeb `--role all` service as a substitute.

Proof of keylessness is an environment inspection of the Railway service
variable names plus the boot gate's explicit rejection list. The dedicated
image contains the full compiled service bundle and shared read-only Bot Kit
code; it is started with the fixed Pubchi entrypoint, and the boot gate rejects
publisher key variables before listening.

The Dockerfile base image is still tag-based because this checkout contains no
verifiable approved Node image digest. Pin `node:20-bookworm-slim` (including
the build and runtime stages) to an approved immutable `sha256` digest before
deployment; do not invent or copy an unverified digest.
