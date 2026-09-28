import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { log } from "../../log.js";

interface Migration {
  id: number;
  filename: string;
  sql: string;
  mode: "transactional" | "persona-backfill" | "persona-indexes" | "persona-contract";
}

/** Session-level advisory lock so concurrent `runMigrations` cannot race CREATE TYPE. */
export const JEB_MIGRATION_LOCK = 746283901;

export class DatabaseMigrator {
  private migrationsCache?: Promise<Migration[]>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
  ) {}

  async createMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS public.migrations (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async getAppliedMigrations(): Promise<number[]> {
    const rows = await this.pool.query<{ id: number }>("SELECT id FROM public.migrations ORDER BY id");
    return rows.rows.map((row) => row.id);
  }

  /** Read-only readiness check for roles that must never execute DDL. */
  async allMigrationsApplied(): Promise<boolean> {
    const table = await this.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.migrations')::text AS table_name",
    );
    if (!table.rows[0]?.table_name) return false;
    const applied = new Set(await this.getAppliedMigrations());
    const all = await this.loadMigrations();
    return all.every((migration) => applied.has(migration.id));
  }

  async loadMigrations(): Promise<Migration[]> {
    this.migrationsCache ??= (async () => {
      const files = await fs.readdir(this.migrationsPath);
      const sqlFiles = files.filter((f) => f.endsWith(".sql") && !f.startsWith("._")).sort();
      const migrations: Migration[] = [];
      for (const filename of sqlFiles) {
        const match = filename.match(/^(\d+)_/);
        if (!match) continue;
        const id = parseInt(match[1], 10);
        const sql = await fs.readFile(path.join(this.migrationsPath, filename), "utf-8");
        const mode = sql.includes("-- migrate:persona-backfill")
          ? "persona-backfill"
          : sql.includes("-- migrate:persona-indexes")
            ? "persona-indexes"
            : sql.includes("-- migrate:persona-contract")
              ? "persona-contract"
              : "transactional";
        migrations.push({ id, filename, sql, mode });
      }
      return migrations;
    })();
    return this.migrationsCache;
  }

  async runMigrations(): Promise<void> {
    const lock = await this.pool.connect();
    try {
      // A blocking pg_advisory_lock() query retains a transaction snapshot
      // while waiting. CREATE INDEX CONCURRENTLY then waits for that snapshot,
      // deadlocking two concurrent migrators. Poll try-lock with completed
      // statements so waiters never retain a snapshot.
      const lockDeadline = Date.now() + 300_000;
      for (;;) {
        const result = await lock.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [JEB_MIGRATION_LOCK],
        );
        if (result.rows[0]?.acquired) break;
        if (Date.now() >= lockDeadline) throw new Error("timed out waiting for Jeb migration advisory lock");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try {
        await this.runMigrationsLocked();
      } finally {
        await lock.query("SELECT pg_advisory_unlock($1)", [JEB_MIGRATION_LOCK]);
      }
    } finally {
      lock.release();
    }
  }

  private async runMigrationsLocked(): Promise<void> {
    const cols = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cursor_state'`,
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (names.size > 0 && !names.has("nexus_url")) {
      await this.pool.query("DROP TABLE public.cursor_state");
    }

    await this.createMigrationsTable();
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      const old = await this.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'token_usage' AND column_name = 'mention_id'`,
      );
      if (old.rows.length > 0) {
        await this.pool.query("DROP TABLE IF EXISTS public.token_usage CASCADE");
      }
    }
    const all = await this.loadMigrations();
    const pending = all.filter((m) => !applied.includes(m.id));
    for (const migration of pending) {
      if (migration.mode === "persona-backfill") {
        await this.runPersonaBackfill();
        await this.recordAppliedMigration(migration);
        continue;
      }
      if (migration.mode === "persona-indexes") {
        await this.runPersonaIndexes();
        await this.recordAppliedMigration(migration);
        continue;
      }
      if (migration.mode === "persona-contract") {
        await this.runPersonaContract();
        await this.recordAppliedMigration(migration);
        continue;
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const configuredBotPk = process.env.JEB_BOT_PK?.trim();
        if (configuredBotPk) {
          await client.query("SELECT set_config('jeb.bot_pk', $1, TRUE)", [configuredBotPk]);
        }
        await client.query(migration.sql);
        await client.query("INSERT INTO public.migrations (id, filename) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
          migration.id,
          migration.filename,
        ]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        log.info({ err: String(e), migration: migration.filename }, "migration failed");
        throw e;
      } finally {
        client.release();
      }
    }
  }

  private async recordAppliedMigration(migration: Migration): Promise<void> {
    await this.pool.query(
      "INSERT INTO public.migrations (id, filename) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [migration.id, migration.filename],
    );
  }

  private async runPersonaBackfill(): Promise<void> {
    const tables = [
      "handled_mentions",
      "work_queue",
      "evidence",
      "publish_requests",
      "token_usage",
      "routing_audit",
      "web_queries",
      "scout_queries",
      "artifact_tags",
      "knowledge_answer_evidence",
    ] as const;
    const batchSize = 1_000;
    for (const table of tables) {
      for (;;) {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '30s'");
          const targetBotExpression =
            table === "handled_mentions"
              ? "COALESCE(target.bot_id, target.target_bot_pk, persona_default_bot_pk())"
              : "COALESCE(target.target_bot_pk, persona_default_bot_pk())";
          const result = await client.query(
            `WITH batch AS (
               SELECT ctid
               FROM ${table}
               WHERE persona_id IS NULL
                  OR persona_version IS NULL
                  OR persona_manifest_hash IS NULL
                  OR target_bot_pk IS NULL
               LIMIT $1
               FOR UPDATE SKIP LOCKED
             )
             UPDATE ${table} AS target
             SET persona_id = COALESCE(target.persona_id, 'jeb'),
                 persona_version = COALESCE(target.persona_version, persona_default_version()),
                 persona_manifest_hash = COALESCE(target.persona_manifest_hash, persona_default_manifest_hash()),
                 target_bot_pk = ${targetBotExpression}
             FROM batch
             WHERE target.ctid = batch.ctid`,
            [batchSize],
          );
          await client.query("COMMIT");
          if ((result.rowCount ?? 0) === 0) break;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
    }
  }

  private async runPersonaIndexes(): Promise<void> {
    const indexes = [
      {
        name: "handled_mentions_persona_mention",
        sql: "CREATE UNIQUE INDEX CONCURRENTLY handled_mentions_persona_mention ON handled_mentions (persona_id, mention_key)",
      },
      {
        name: "work_queue_active_persona_mention",
        sql: "CREATE UNIQUE INDEX CONCURRENTLY work_queue_active_persona_mention ON work_queue (persona_id, mention_key) WHERE status IN ('queued', 'claimed')",
      },
      {
        name: "publish_requests_active_persona_mention",
        sql: "CREATE UNIQUE INDEX CONCURRENTLY publish_requests_active_persona_mention ON publish_requests (persona_id, mention_key) WHERE status IN ('queued', 'retry', 'publishing', 'published')",
      },
      {
        name: "artifact_tags_active_persona_uri_label",
        sql: "CREATE UNIQUE INDEX CONCURRENTLY artifact_tags_active_persona_uri_label ON artifact_tags (persona_id, post_uri, label) WHERE status IN ('queued', 'retry', 'publishing', 'published')",
      },
      {
        name: "token_usage_persona_created",
        sql: "CREATE INDEX CONCURRENTLY token_usage_persona_created ON token_usage (persona_id, created_at)",
      },
      {
        name: "web_queries_persona_created",
        sql: "CREATE INDEX CONCURRENTLY web_queries_persona_created ON web_queries (persona_id, created_at)",
      },
      {
        name: "scout_queries_persona_created",
        sql: "CREATE INDEX CONCURRENTLY scout_queries_persona_created ON scout_queries (persona_id, created_at)",
      },
      {
        name: "knowledge_answer_evidence_persona_created",
        sql: "CREATE INDEX CONCURRENTLY knowledge_answer_evidence_persona_created ON knowledge_answer_evidence (persona_id, created_at)",
      },
    ] as const;
    for (const index of indexes) {
      const state = await this.pool.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1`,
        [index.name],
      );
      if (state.rows[0]?.valid) continue;
      if (state.rows.length > 0) {
        await this.pool.query(`DROP INDEX CONCURRENTLY public.${index.name}`);
      }
      await this.pool.query(index.sql);
    }
  }

  private async runPersonaContract(): Promise<void> {
    const tables = [
      "handled_mentions",
      "work_queue",
      "evidence",
      "publish_requests",
      "token_usage",
      "routing_audit",
      "web_queries",
      "scout_queries",
      "artifact_tags",
      "knowledge_answer_evidence",
    ] as const;
    for (const table of tables) {
      const presentConstraint = `${table}_persona_identity_present`;
      const existing = await this.pool.query(
        `SELECT 1 FROM pg_constraint
         WHERE conname = $1 AND conrelid = $2::regclass`,
        [presentConstraint, table],
      );
      if (existing.rowCount === 0) {
        const checkClient = await this.pool.connect();
        try {
          await checkClient.query("SET lock_timeout = '2s'");
          await checkClient.query(
            `ALTER TABLE ${table}
             ADD CONSTRAINT ${presentConstraint} CHECK (
               persona_id IS NOT NULL
               AND persona_version IS NOT NULL
               AND persona_manifest_hash IS NOT NULL
               AND target_bot_pk IS NOT NULL
             ) NOT VALID`,
          );
        } finally {
          await checkClient.query("RESET lock_timeout").catch(() => undefined);
          checkClient.release();
        }
      }
      for (const suffix of ["persona_version_fk", "persona_identity_fk", "persona_identity_present"]) {
        const validationClient = await this.pool.connect();
        try {
          await validationClient.query("SET lock_timeout = '2s'");
          await validationClient.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_${suffix}`);
        } finally {
          await validationClient.query("RESET lock_timeout").catch(() => undefined);
          validationClient.release();
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query(`ALTER TABLE ${table} ALTER COLUMN persona_id SET NOT NULL`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN persona_version SET NOT NULL`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN persona_manifest_hash SET NOT NULL`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN target_bot_pk SET NOT NULL`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
}
