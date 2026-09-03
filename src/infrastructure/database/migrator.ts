import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { log } from "../../log.js";

interface Migration {
  id: number;
  filename: string;
  sql: string;
}

export class DatabaseMigrator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
  ) {}

  async createMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async getAppliedMigrations(): Promise<number[]> {
    const rows = await this.pool.query<{ id: number }>("SELECT id FROM migrations ORDER BY id");
    return rows.rows.map((row) => row.id);
  }

  async loadMigrations(): Promise<Migration[]> {
    const files = await fs.readdir(this.migrationsPath);
    const sqlFiles = files.filter((f) => f.endsWith(".sql") && !f.startsWith("._")).sort();
    const migrations: Migration[] = [];
    for (const filename of sqlFiles) {
      const match = filename.match(/^(\d+)_/);
      if (!match) continue;
      const id = parseInt(match[1], 10);
      const sql = await fs.readFile(path.join(this.migrationsPath, filename), "utf-8");
      migrations.push({ id, filename, sql });
    }
    return migrations;
  }

  async runMigrations(): Promise<void> {
    const cols = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cursor_state'`,
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (names.size > 0 && !names.has("nexus_url")) {
      await this.pool.query("DROP TABLE cursor_state");
    }

    await this.createMigrationsTable();
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      const old = await this.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'token_usage' AND column_name = 'mention_id'`,
      );
      if (old.rows.length > 0) {
        await this.pool.query("DROP TABLE IF EXISTS token_usage CASCADE");
      }
    }
    const all = await this.loadMigrations();
    const pending = all.filter((m) => !applied.includes(m.id));
    for (const migration of pending) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO migrations (id, filename) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
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
}
