# Persona migration operations

Persona persistence rolls out in six restart-safe phases:

1. `110_personas_expand.sql` creates only the small persona registry,
   functions, switches, and release tables.
2. `111_personas_expand_tables.sql` expands one populated table per committed
   transaction with 2s lock and 30s statement timeouts. A blocked table fails
   fast without retaining locks on tables already expanded.
3. `112_personas_backfill.sql` tells the migrator to update at most 1,000 rows
   per committed transaction, with a two-second lock timeout, a 30-second
   statement timeout, and `SKIP LOCKED`.
4. `113_personas_indexes.sql` tells the migrator to build persona indexes one
   at a time with `CREATE INDEX CONCURRENTLY`. Invalid remnants of an
   interrupted build are dropped concurrently before retry.
5. `114_personas_contract.sql` validates each constraint independently, then
   applies `NOT NULL` one table per short transaction. The validated
   `persona_identity_present` check lets PostgreSQL avoid a full validation
   scan while taking the final metadata lock.
6. `115_persona_pack_binding.sql` inserts the identity-free pack version and
   advances the small `personas` registry row to its combined binding snapshot.

No populated table is rewritten or indexed in the expansion transaction.
Legacy mention-key indexes stay active until persona-aware claim SQL ships.

Jeb is seeded as persona `jeb`, version `1.0.0`. `JEB_BOT_PK` selects the
current deployment identity and must already appear in a non-empty database's
handled/cursor history. Older Jeb keys remain historical `bot_id` evidence;
backfilled `target_bot_pk` points to the current configured key. An empty
database without `JEB_BOT_PK`, or a configured key absent from non-empty
history, fails before expansion commits. There is no implicit fallback.

`pubchi_budget_day` remains owner-scoped Pubchi accounting, not Jeb persona
accounting. Persona budget schema and enforcement belong to the budget/runtime
PR; Jeb's `knowledge_answer_evidence` carries persona identity alongside
queue, evidence, publish, token, routing, web, Scout, and tag rows.

Writers update `updated_at` explicitly when persona, budget, or switch records
change. There is no hidden database trigger.

## Preflight and verification

Before staging or production migration:

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" \
  -f docs/persona-migration-preflight.sql
```

For a database with historical keys, set `jeb.bot_pk` to the current public
key in the preflight session. Preflight rejects a configured key absent from
history and durably records row counts. Record the output and migration start
time.

After migrations 110–115:

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" \
  -f docs/persona-migration-verify.sql
```

The verifier fails on missing phases, decreasing row counts, null identity
fields, orphan version/key rows, key disagreement, unvalidated constraints,
or missing/invalid indexes. Run the migrator a second time and rerun the
verifier to prove ledger and phase idempotency.

Record per-phase and total wall time. Query `pg_stat_activity` and
`pg_locks` during staging to record the longest lock wait. Use production
read-only row counts to size the staging fixture; do not copy production
content when synthetic rows can reproduce the count and width.

Read-only counts captured 2026-09-27:

| Table | Production | Staging |
| --- | ---: | ---: |
| `artifact_tags` | 383 | 143 |
| `evidence` | 121 | 38 |
| `handled_mentions` | 132 | 37 |
| `knowledge_answer_evidence` | 270 | 95 |
| `publish_requests` | 183 | 35 |
| `routing_audit` | 117 | 32 |
| `scout_queries` | 255 | 0 |
| `token_usage` | 283 | 69 |
| `web_queries` | 34 | 10 |
| `work_queue` | 137 | 41 |

Production is currently small; the largest migrated table has 383 rows.
Staging deployment still records per-phase wall and lock timing. No production
content needs to be copied to reproduce this scale.

## Rollback

Rollback is permitted only before any non-Jeb identity row exists. Include
`knowledge_answer_evidence` in the check:

```sql
SELECT persona_id, count(*)
FROM (
  SELECT persona_id FROM handled_mentions
  UNION ALL SELECT persona_id FROM work_queue
  UNION ALL SELECT persona_id FROM evidence
  UNION ALL SELECT persona_id FROM publish_requests
  UNION ALL SELECT persona_id FROM token_usage
  UNION ALL SELECT persona_id FROM routing_audit
  UNION ALL SELECT persona_id FROM web_queries
  UNION ALL SELECT persona_id FROM scout_queries
  UNION ALL SELECT persona_id FROM artifact_tags
  UNION ALL SELECT persona_id FROM knowledge_answer_evidence
) rows_by_persona
GROUP BY persona_id;
```

The only allowed result is `jeb`. Otherwise fix forward.

For a Jeb-only rollback, stop ingest/reason/publish, take a database snapshot,
and run:

```sql
BEGIN;
DROP TABLE IF EXISTS persona_release_events;
DROP TABLE IF EXISTS persona_switches;

ALTER TABLE handled_mentions DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE work_queue DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE evidence DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE publish_requests DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE token_usage DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE routing_audit DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE web_queries DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE scout_queries DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE artifact_tags DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;
ALTER TABLE knowledge_answer_evidence DROP COLUMN IF EXISTS persona_id, DROP COLUMN IF EXISTS persona_version, DROP COLUMN IF EXISTS persona_manifest_hash, DROP COLUMN IF EXISTS target_bot_pk;

DROP FUNCTION IF EXISTS persona_default_manifest_hash();
DROP FUNCTION IF EXISTS persona_default_version();
DROP FUNCTION IF EXISTS persona_default_bot_pk();
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_current_version_fk;
DROP TABLE IF EXISTS persona_versions;
DROP TABLE IF EXISTS personas;
DROP TABLE IF EXISTS persona_migration_baseline;
DELETE FROM public.migrations WHERE id BETWEEN 110 AND 115;
COMMIT;
```

Deploy the recorded last-good merged source and repeat health, metrics, queue,
publish, count, and orphan checks. `railway redeploy` is not a historical
rollback mechanism.
