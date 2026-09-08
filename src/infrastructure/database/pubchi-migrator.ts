import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { log } from "../../log.js";

export const PUBCHI_MIGRATION_LOCK = 746283902;
export const PUBCHI_MIGRATION_LEDGER = "public.pubchi_migrations";

const ALLOWED_STATEMENTS = new Set([
  "CREATE TABLE IF NOT EXISTS public.pubchi_nonces ( bot TEXT NOT NULL, asker TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (bot, asker, nonce) )",
  "CREATE INDEX IF NOT EXISTS idx_pubchi_nonces_expires ON public.pubchi_nonces (expires_at)",
  "CREATE TABLE IF NOT EXISTS public.pubchi_budget_day ( mention_key TEXT NOT NULL, utc_day DATE NOT NULL, reserved BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (mention_key, utc_day) )",
  "CREATE TABLE IF NOT EXISTS public.token_usage ( id BIGSERIAL PRIMARY KEY, mention_key TEXT NOT NULL, public_key TEXT NOT NULL, phase TEXT NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, meta_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now() )",
  "CREATE INDEX IF NOT EXISTS idx_token_usage_pubkey_created ON public.token_usage (public_key, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_token_usage_created ON public.token_usage (created_at)",
  "CREATE TABLE IF NOT EXISTS public.kill_switch ( id INTEGER PRIMARY KEY DEFAULT 1, disabled BOOLEAN NOT NULL DEFAULT FALSE )",
  "INSERT INTO public.kill_switch (id, disabled) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING",
  "CREATE TABLE IF NOT EXISTS public.switches ( name TEXT PRIMARY KEY, on_flag BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now() )",
  "CREATE TABLE IF NOT EXISTS public.scout_queries ( id BIGSERIAL PRIMARY KEY, tool TEXT NOT NULL, cypher_hash TEXT NOT NULL, params_hash TEXT NOT NULL, rows INTEGER, truncated BOOLEAN, duration_ms INTEGER NOT NULL, ok BOOLEAN NOT NULL, error_code TEXT, mention_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now() )",
  "CREATE INDEX IF NOT EXISTS idx_scout_queries_created ON public.scout_queries (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_scout_queries_mention ON public.scout_queries (mention_key, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_scout_queries_tool_created ON public.scout_queries (tool, created_at)",
]);

export interface PubchiMigration {
  version: number;
  filename: string;
  sql: string;
  checksum: string;
}

type MigrationRow = { version: number; filename: string; checksum: string };

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function validateSql(filename: string, sql: string): void {
  if (/--|\/\*|\*\//.test(sql)) {
    throw new Error(`Pubchi migration ${filename} contains a comment`);
  }
  const parts = sql.split(";").map((statement) => statement.trim());
  const statements = parts.slice(0, -1);
  if (parts.at(-1) !== "" || statements.length === 0 || statements.some((statement) => statement === "")) {
    throw new Error(`Pubchi migration ${filename} must contain one or more semicolon-terminated statements`);
  }
  for (const statement of statements) {
    // ASCII-only collapse: Unicode spaces (e.g. U+00A0) must not match ALLOWED_STATEMENTS
    // then fail in Postgres. Checksums hash raw file bytes, so this does not change ledger identity.
    const normalized = statement.replace(/[ \t\n\r\f\v]+/g, " ");
    if (!ALLOWED_STATEMENTS.has(normalized)) {
      throw new Error(`Pubchi migration ${filename} contains an unapproved SQL statement`);
    }
  }
}

export class PubchiMigrator {
  private migrationsCache?: Promise<PubchiMigration[]>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "pubchi-migrations"),
  ) {}

  async createMigrationsTable(client: { query: pg.PoolClient["query"] } = this.pool): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${PUBCHI_MIGRATION_LEDGER} (
        version INTEGER PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async loadMigrations(): Promise<PubchiMigration[]> {
    this.migrationsCache ??= (async () => {
      const files = (await fs.readdir(this.migrationsPath))
        .filter((filename) => filename.endsWith(".sql") && !filename.startsWith("._"))
        .sort();
      if (files.length === 0) {
        throw new Error(`Pubchi migration manifest is empty: ${this.migrationsPath}`);
      }
      const migrations: PubchiMigration[] = [];
      for (const filename of files) {
        const match = filename.match(/^(\d+)_/);
        if (!match) throw new Error(`Pubchi migration filename must start with a version: ${filename}`);
        const version = Number.parseInt(match[1], 10);
        const sql = await fs.readFile(path.join(this.migrationsPath, filename), "utf8");
        validateSql(filename, sql);
        migrations.push({ version, filename, sql, checksum: checksum(sql) });
      }
      for (let index = 0; index < migrations.length; index += 1) {
        if (migrations[index].version !== index + 1) {
          throw new Error(`Pubchi migration versions must be exact and contiguous at ${migrations[index].filename}`);
        }
      }
      return migrations;
    })();
    return this.migrationsCache;
  }

  async getAppliedMigrations(client: { query: pg.PoolClient["query"] } = this.pool): Promise<MigrationRow[]> {
    const result = await client.query<MigrationRow>(
      `SELECT version, filename, checksum FROM ${PUBCHI_MIGRATION_LEDGER} ORDER BY version`,
    );
    return result.rows;
  }

  async allMigrationsApplied(): Promise<boolean> {
    const table = await this.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.pubchi_migrations')::text AS table_name",
    );
    if (!table.rows[0]?.table_name) return false;
    const expected = await this.loadMigrations();
    const applied = await this.getAppliedMigrations();
    if (applied.length !== expected.length) return false;
    return expected.every((migration, index) => {
      const row = applied[index];
      return (
        row?.version === migration.version &&
        row.filename === migration.filename &&
        row.checksum === migration.checksum
      );
    });
  }

  async runMigrations(): Promise<void> {
    const lock = await this.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock($1)", [PUBCHI_MIGRATION_LOCK]);
      try {
        await this.runMigrationsLocked(lock);
      } finally {
        await lock.query("SELECT pg_advisory_unlock($1)", [PUBCHI_MIGRATION_LOCK]);
      }
    } finally {
      lock.release();
    }
  }

  private async runMigrationsLocked(client: pg.PoolClient): Promise<void> {
    const migrations = await this.loadMigrations();
    await this.createMigrationsTable(client);
    const applied = await this.getAppliedMigrations(client);
    for (const row of applied) {
      const expected = migrations.find((migration) => migration.version === row.version);
      if (!expected || expected.filename !== row.filename || expected.checksum !== row.checksum) {
        throw new Error(`Pubchi migration ledger mismatch at version ${row.version}`);
      }
    }
    for (const migration of migrations) {
      if (applied.some((row) => row.version === migration.version)) continue;
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${PUBCHI_MIGRATION_LEDGER} (version, filename, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        log.info({ err: String(error), migration: migration.filename }, "Pubchi migration failed");
        throw error;
      }
    }
  }
}
