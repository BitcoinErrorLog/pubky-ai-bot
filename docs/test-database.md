# Test database

`npm test` / `vitest` use a dedicated Postgres database named **`jeb_vitest_<8-hex-hash>`**, derived from the real path of the git worktree, so concurrent runs across worktrees are allowed. A leftover `DATABASE_URL` pointing at `jeb_stage1_test` (or any live bot database) is rewritten to the per-worktree suite database on the same host and user. To drop stale suite databases, list them with `psql -c "\l"` and then run `DROP DATABASE` for the selected `jeb_vitest_*` name. Per-role URLs (`JEB_DB_URL_REASON`, `JEB_DB_URL_INGEST`) are dropped so a `--role reason` child cannot inherit a test database the way the 2026-09-07 stray process did.

You do not set an extra env var to run tests. Optional `JEB_SUITE_DATABASE_URL` supplies host/user/password only; the database name is still selected per worktree.

## Create and migrate

`tests/global-setup.ts` (wired from `vitest.config.ts`) creates the per-worktree `jeb_vitest_*` database if it is missing, applies the same migrations as `Store.migrate()`, then runs the collision guard. If Postgres is down or the role cannot connect, the suite **fails** with a start/install hint. Database-backed tests are not skipped.

When the suite process exits, the same setup function truncates the work tables listed above (not `migrations` or migration seed tables) so the next run starts empty.

Eval still uses `JEB_EVAL_DATABASE_URL` (default `jeb_eval`, or the original `DATABASE_URL` when that was a different database). Knowledge unit tests still use `JEB_KNOWLEDGE_TEST_DATABASE_URL` (`jeb_knowledge_unit`) and refuse to share `DATABASE_URL`.

## Collision guard

At every suite start the setup process fails if:

- another client backend is connected to the per-worktree `jeb_vitest_*` database, or
- work tables already have rows (`handled_mentions`, `work_queue`, `publish_requests`, `evidence`, plus token/scout/web/corrections)

Migration seed rows (`kill_switch`, `collection_rules`, `tracked_projects`) are expected and do not trip the guard.

The error names a stray bot (for example `--role reason` from a sibling worktree) or a crashed previous suite. That is the same class of concurrent writer that previously produced scattered assertion failures and was dismissed as row pollution. Kill the extra process or clear leftover rows, then re-run.

Live bots and local `node dist/main.js` keep using whatever `DATABASE_URL` you set (commonly `jeb_stage1_test`). Do not point them at `jeb_vitest`.
