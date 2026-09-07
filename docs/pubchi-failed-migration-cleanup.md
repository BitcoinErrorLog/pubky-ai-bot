# Failed Pubchi migration cleanup

This is a draft runbook only. It was prepared for failed Railway deployment
`6560004f-0206-4fec-aa15-271171ec6d92`. Do not execute it as part of a deploy,
and do not claim that cleanup or an empty database has been completed.

## Preconditions

Run these read-only checks with the database administrator connection. Stop if
any result is unexpected:

```sql
SELECT current_database() AS database_name,
       current_user AS current_user,
       current_database() = 'pubchi' AS is_dedicated_pubchi_database;

SELECT to_regclass('public.pubchi_migrations') AS pubchi_ledger,
       to_regclass('public.migrations') AS jeb_ledger,
       current_database() = 'pubchi' AS is_dedicated_pubchi_database;
```

Proceed only when `is_dedicated_pubchi_database` is true, the database name is
`pubchi`, and `pubchi_ledger` is NULL. The cleanup is not authorized when the
Pubchi ledger exists, even if it is empty.

## Required export/backup

Before any destructive operation, export the exact fixed list and its data.
The export must be retained with the deployment incident record:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file=pubchi-failed-6560004f-before-cleanup.dump \
  --schema=public \
  --table=public.cursor_state \
  --table=public.handled_mentions \
  --table=public.blacklist \
  --table=public.rate_limit_events \
  --table=public.work_queue \
  --table=public.evidence \
  --table=public.publish_requests
```

Confirm the backup can be listed before continuing:

```bash
pg_restore --list pubchi-failed-6560004f-before-cleanup.dump
```

## Fixed removal list

Only these seven stage-1 Jeb tables are eligible for removal:

```text
public.cursor_state
public.handled_mentions
public.blacklist
public.rate_limit_events
public.work_queue
public.evidence
public.publish_requests
```

Do not touch `public.pubchi_nonces`, `public.pubchi_budget_day`,
`public.token_usage`, `public.kill_switch`, `public.switches`, or
`public.pubchi_migrations`. Do not touch the Postgres/Jeb database, any
schema other than `public`, `public.migrations`, `public.routing_audit`, or
any table not in the fixed list above. Do not grant superuser, extension, or
additional schema privileges.

## Transaction and rollback model

This document does not execute cleanup. After the preconditions and export have
been independently approved, an operator may drop only the fixed list in one
transaction, using explicit `public.<table>` names and no `CASCADE`. A missing
table must abort rather than broaden the operation. Commit only after a
second operator verifies the seven names against this document. On any error,
roll back. If a committed cleanup must be reversed, restore only the affected
tables from the retained custom dump into the dedicated database; never restore
the Jeb ledger or use a broad database restore.

## Dry-run-only verifier

This command performs no writes. It proves the target database and prints the
fixed-list existence state; it must not be changed into a drop command:

```bash
psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -X \
  -c "SELECT current_database() AS database_name,
             current_database() = 'pubchi' AS is_dedicated_pubchi_database;
      SELECT table_name
      FROM (VALUES
        ('cursor_state'),
        ('handled_mentions'),
        ('blacklist'),
        ('rate_limit_events'),
        ('work_queue'),
        ('evidence'),
        ('publish_requests')
      ) AS fixed(table_name)
      WHERE to_regclass('public.' || fixed.table_name) IS NOT NULL
      ORDER BY table_name;"
```

## Self-attack

| Attack or mistake | Control |
| --- | --- |
| Wrong database URL points at Jeb/Postgres | Require `current_database() = 'pubchi'`; stop otherwise. |
| Pubchi ledger is present but empty or partial | Require `to_regclass('public.pubchi_migrations') IS NULL`; stop otherwise. |
| A table outside the seven is removed | Use only the seven explicit `public.<table>` names; no wildcard or `CASCADE`. |
| Export is missing or unusable | Require `pg_restore --list` to succeed before any approved cleanup. |
| Operator broadens a failed command | One transaction, `ON_ERROR_STOP`, second-person review, and rollback on any error. |
| Cleanup is mistaken for migration completion | This draft makes no readiness or empty-database claim; rerun the packaged migrator and readiness checks separately. |
