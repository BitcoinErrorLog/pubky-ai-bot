# Persona migration 110 operations

Migration `110_personas.sql` is additive and preserves the current Jeb runtime:

- Jeb is seeded as persona `jeb`, version `1.0.0`.
- The public key is discovered from existing `handled_mentions` and
  `cursor_state`; an inconsistent multi-key database fails before mutation.
  A database without identity rows uses Jeb's registered production key.
- Existing queue, evidence, publish, token, routing, web, Scout, and artifact
  tag rows are backfilled before non-null and foreign-key constraints apply.
- Compatibility defaults keep legacy insert statements writing Jeb identity
  fields until persona-aware stores ship.
- Legacy mention-key uniqueness remains in place. Composite persona indexes
  are added now; the legacy indexes are removed only with persona-aware claim
  and idempotency SQL.

## Verification

Run `docs/persona-migration-110-verify.sql` through `psql -v ON_ERROR_STOP=1`.
The script fails if migration 110 is missing, any identity field is null, any
row is orphaned from its persona/version/key, or the sole Phase 1 persona is
not Jeb.

Record pre/post totals for:

`handled_mentions`, `work_queue`, `evidence`, `publish_requests`,
`token_usage`, `routing_audit`, `web_queries`, `scout_queries`, and
`artifact_tags`.

Migration 110 updates those rows but does not delete or merge them, so every
table's pre/post count must be equal.

## Rollback

Rollback is permitted only before persona-aware runtime code writes a non-Jeb
row. Check:

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
) rows_by_persona
GROUP BY persona_id;
```

The only allowed result is `jeb`. If another persona exists, do not roll back;
fix forward because dropping identity columns would destroy routing
provenance.

For a Jeb-only rollback, stop ingest, reason, and publish; take a database
snapshot; verify table counts; then run the following transaction:

```sql
BEGIN;

DROP TABLE IF EXISTS persona_release_events;
DROP TABLE IF EXISTS persona_budget_day;
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

DROP FUNCTION IF EXISTS persona_default_manifest_hash();
DROP FUNCTION IF EXISTS persona_default_bot_pk();
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_current_version_fk;
DROP TABLE IF EXISTS persona_versions;
DROP TABLE IF EXISTS personas;
DELETE FROM public.migrations WHERE id = 110;

COMMIT;
```

Restart the prior merged deployment and rerun health, metrics, queue, publish,
and count checks. A rollback does not restore a historical deployment by
itself; deploy the recorded last-good source through the normal Railway
procedure.
