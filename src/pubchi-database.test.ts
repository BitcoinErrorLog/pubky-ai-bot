import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PubchiMigrator } from "./infrastructure/database/pubchi-migrator.js";
import { log } from "./log.js";
import {
  assertPubchiMigrationConfig,
  assertPubchiRuntimeDatabaseConfig,
  pubchiMigrationsReady,
  pubchiRuntimeReadiness,
  requirePubchiMigrationsReady,
  requirePubchiRuntimeTables,
  runPubchiMigrations,
} from "./pubchi-database.js";

function privilegeDeniedError(table: string): InstanceType<typeof pg.DatabaseError> {
  const err = new pg.DatabaseError(`permission denied for table ${table}`, 0, "error");
  err.code = "42501";
  return err;
}

describe("Pubchi database role split", () => {
  it("rejects a runtime URL or HTTP configuration in migration mode", () => {
    expect(() =>
      assertPubchiMigrationConfig({
        DATABASE_URL: "postgres://migrator@db/pubchi",
        PUBCHI_RUNTIME_DATABASE_URL: "postgres://runtime@db/pubchi",
      }),
    ).toThrow("PUBCHI_RUNTIME_DATABASE_URL");
    expect(() =>
      assertPubchiMigrationConfig({
        DATABASE_URL: "postgres://migrator@db/pubchi",
        PUBCHI_BIND: "0.0.0.0",
      }),
    ).toThrow("HTTP bind");
    expect(() =>
      assertPubchiMigrationConfig({
        DATABASE_URL: "postgres://migrator@db/pubchi",
        JEB_GITHUB_TOKEN: "present",
      }),
    ).toThrow("JEB_GITHUB_TOKEN");
    for (const name of ["JEB_SKIP_MIGRATIONS", "JEB_DB_URL_INGEST", "JEB_DB_URL_REASON"]) {
      expect(() =>
        assertPubchiMigrationConfig({
          DATABASE_URL: "postgres://migrator@db/pubchi",
          [name]: "present",
        }),
      ).toThrow(name);
    }
  });

  it("rejects a migrator URL in the runtime boot gate", () => {
    expect(() =>
      assertPubchiRuntimeDatabaseConfig({
        DATABASE_URL: "postgres://runtime@db/pubchi",
        PUBCHI_MIGRATOR_DATABASE_URL: "postgres://migrator@db/pubchi",
      }),
    ).toThrow("PUBCHI_MIGRATOR_DATABASE_URL");
    expect(() =>
      assertPubchiRuntimeDatabaseConfig({
        DATABASE_URL: "postgres://runtime@db/pubchi",
        JEB_DB_URL_INGEST: "postgres://ingest@db/jeb",
      }),
    ).toThrow("JEB_DB_URL_INGEST");
    expect(() =>
      assertPubchiRuntimeDatabaseConfig({
        DATABASE_URL: "postgres://runtime@db/pubchi",
        JEB_DB_URL_REASON: "postgres://reason@db/jeb",
      }),
    ).toThrow("JEB_DB_URL_REASON");
  });

  it("reports missing migration state without executing DDL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ table_name: null }] });
    const migrator = new PubchiMigrator({ query } as never);
    const ready = await pubchiMigrationsReady(migrator);
    expect(ready).toBe(false);
    expect(query).toHaveBeenCalledWith("SELECT to_regclass('public.pubchi_migrations')::text AS table_name");
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("CREATE"));
    await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("pubchi-migrate");
  });

  it("rejects runtime readiness when the ledger misses a checked-in migration", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-migrations-"));
    try {
      await writeFile(
        path.join(migrationsPath, "001_pubchi_foundation.sql"),
        `CREATE TABLE IF NOT EXISTS public.pubchi_nonces (
          bot TEXT NOT NULL,
          asker TEXT NOT NULL,
          nonce TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (bot, asker, nonce)
        );`,
      );
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.pubchi_migrations" }] };
        if (sql === "SELECT version, filename, checksum FROM public.pubchi_migrations ORDER BY version") {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      const migrator = new PubchiMigrator({ query } as never, migrationsPath);

      await expect(pubchiMigrationsReady(migrator)).resolves.toBe(false);
      await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("pubchi-migrate");
      expect(query).toHaveBeenCalledWith("SELECT version, filename, checksum FROM public.pubchi_migrations ORDER BY version");
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("rejects runtime readiness when the ledger checksum or filename is tampered", async () => {
    const [expected] = await new PubchiMigrator({ query: vi.fn() } as never).loadMigrations();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.pubchi_migrations" }] };
      if (sql === "SELECT version, filename, checksum FROM public.pubchi_migrations ORDER BY version") {
        return { rows: [{ version: expected.version, filename: expected.filename, checksum: "0".repeat(64) }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const migrator = new PubchiMigrator({ query } as never);
    await expect(pubchiMigrationsReady(migrator)).resolves.toBe(false);
    await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("pubchi-migrate");
  });

  it("keeps runtime unready when the packaged manifest is empty", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-empty-dist-"));
    try {
      const query = vi.fn(async (sql: string) => {
        if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
        if (sql.includes("IS NOT NULL AS present")) return { rows: [{ present: true }] };
        if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.pubchi_migrations" }] };
        if (sql === "SELECT version, filename, checksum FROM public.pubchi_migrations ORDER BY version") {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      const migrator = new PubchiMigrator({ query } as never, migrationsPath);

      await expect(pubchiMigrationsReady(migrator)).rejects.toThrow("manifest is empty");
      await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("manifest is empty");
      await expect(pubchiRuntimeReadiness({ query }, migrator)).resolves.toEqual({
        config: true,
        database: true,
        migrations: false,
      });
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("runs the migrator and exits without starting HTTP", async () => {
    const runMigrations = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { end } as never;
    await runPubchiMigrations(
      "postgres://migrator@db/pubchi",
      () => ({ runMigrations } as never),
      () => pool,
    );
    expect(runMigrations).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("flushes the applied confirmation before closing the pool", async () => {
    const calls: string[] = [];
    const info = vi.spyOn(log, "info").mockImplementation((..._args: unknown[]) => {
      calls.push("info");
      return log;
    });
    const flush = vi.spyOn(log, "flush").mockImplementation((cb?: (err?: Error | null) => void) => {
      calls.push("flush");
      cb?.();
    });
    const runMigrations = vi.fn(async () => {
      calls.push("migrate");
    });
    const end = vi.fn(async () => {
      calls.push("end");
    });
    try {
      await runPubchiMigrations(
        "postgres://migrator@db/pubchi",
        () => ({ runMigrations } as never),
        () => ({ end } as never),
      );
      expect(calls).toEqual(["migrate", "info", "flush", "end"]);
      expect(info).toHaveBeenCalledWith(
        { role: "pubchi-migrate", mode: "migration" },
        "Pubchi migrations applied",
      );
    } finally {
      info.mockRestore();
      flush.mockRestore();
    }
  });

  it("flushes the failure line before closing the pool and rethrows", async () => {
    const calls: string[] = [];
    const info = vi.spyOn(log, "info").mockImplementation((..._args: unknown[]) => {
      calls.push("error");
      return log;
    });
    const flush = vi.spyOn(log, "flush").mockImplementation((cb?: (err?: Error | null) => void) => {
      calls.push("flush");
      cb?.();
    });
    const migrateError = new Error("migration boom");
    const runMigrations = vi.fn(async () => {
      calls.push("migrate");
      throw migrateError;
    });
    const end = vi.fn(async () => {
      calls.push("end");
    });
    try {
      await expect(
        runPubchiMigrations(
          "postgres://migrator@db/pubchi",
          () => ({ runMigrations } as never),
          () => ({ end } as never),
        ),
      ).rejects.toBe(migrateError);
      expect(calls).toEqual(["migrate", "error", "flush", "end"]);
      expect(info).toHaveBeenCalledWith(
        { err: "Error: migration boom", role: "pubchi-migrate", mode: "migration" },
        "Pubchi migrations failed",
      );
    } finally {
      info.mockRestore();
      flush.mockRestore();
    }
  });

  it("keeps a migrate cancellation ahead of a later flush failure", async () => {
    const cancel = new Error("aborted");
    cancel.name = "AbortError";
    const info = vi.spyOn(log, "info").mockImplementation((..._args: unknown[]) => log);
    const flush = vi.spyOn(log, "flush").mockImplementation((cb?: (err?: Error | null) => void) => {
      cb?.(new Error("flush failed"));
    });
    try {
      await expect(
        runPubchiMigrations(
          "postgres://migrator@db/pubchi",
          () => ({ runMigrations: async () => { throw cancel; } } as never),
          () => ({ end: async () => undefined } as never),
        ),
      ).rejects.toBe(cancel);
    } finally {
      info.mockRestore();
      flush.mockRestore();
    }
  });

  it("reports database true and migrations false when SELECT 1 succeeds but ledger reads fail", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
        if (sql.includes("IS NOT NULL AS present")) return { rows: [{ present: true }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const migrator = {
      allMigrationsApplied: vi.fn(async () => {
        throw new Error("permission denied for table migrations");
      }),
    };
    await expect(pubchiRuntimeReadiness(pool, migrator)).resolves.toEqual({
      config: true,
      database: true,
      migrations: false,
    });
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
    expect(migrator.allMigrationsApplied).toHaveBeenCalledOnce();
  });

  it("creates a separate namespace-safe ledger", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const migrator = new PubchiMigrator({ query } as never);
    await migrator.createMigrationsTable();
    expect(String(query.mock.calls[0]?.[0])).toMatch(/CREATE TABLE IF NOT EXISTS public\.pubchi_migrations/);
    expect(String(query.mock.calls[0]?.[0])).toContain("checksum TEXT NOT NULL");
  });

  it("fails readiness when scout_queries is missing and passes when present", async () => {
    const pg = await import("pg");
    const url = process.env.DATABASE_URL;
    expect(url).toMatch(/\/jeb_vitest(?:_[a-z0-9]{6})?(?:\?|$)/);
    const pool = new pg.default.Pool({ connectionString: url });
    const restore = async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.scout_queries (
          id BIGSERIAL PRIMARY KEY,
          tool TEXT NOT NULL,
          cypher_hash TEXT NOT NULL,
          params_hash TEXT NOT NULL,
          rows INTEGER,
          truncated BOOLEAN,
          duration_ms INTEGER NOT NULL,
          ok BOOLEAN NOT NULL,
          error_code TEXT,
          mention_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_scout_queries_created ON public.scout_queries (created_at)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_scout_queries_mention ON public.scout_queries (mention_key, created_at)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_scout_queries_tool_created ON public.scout_queries (tool, created_at)");
    };
    try {
      await pool.query("DROP TABLE IF EXISTS public.scout_queries CASCADE");
      await expect(requirePubchiRuntimeTables(pool)).rejects.toThrow("public.scout_queries");
      await expect(
        pubchiRuntimeReadiness(pool, { allMigrationsApplied: async () => true }),
      ).resolves.toEqual({ config: true, database: false, migrations: false });
      await restore();
      await expect(requirePubchiRuntimeTables(pool)).resolves.toBeUndefined();
      await expect(
        pubchiRuntimeReadiness(pool, { allMigrationsApplied: async () => true }),
      ).resolves.toEqual({ config: true, database: true, migrations: true });
    } finally {
      await restore();
      await pool.end();
    }
  });

  it("passes existence for an INSERT-only role that cannot SELECT the table", async () => {
    const url = process.env.DATABASE_URL;
    expect(url).toMatch(/\/jeb_vitest(?:_[a-z0-9]{6})?(?:\?|$)/);
    const pool = new pg.Pool({ connectionString: url });
    const role = "pubchi_probe_insert_only_42501";
    const client = await pool.connect();
    const dropRole = async () => {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    };
    try {
      await dropRole();
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`REVOKE ALL ON TABLE public.token_usage FROM ${role}`);
      await client.query(`GRANT INSERT ON TABLE public.token_usage TO ${role}`);
      await client.query(`SET ROLE ${role}`);
      await expect(requirePubchiRuntimeTables(client)).resolves.toBeUndefined();
      await client.query("RESET ROLE");
    } finally {
      await dropRole();
      client.release();
      await pool.end();
    }
  });

  it("names privilege, not a missing table, when the probe hits 42501", async () => {
    const pool = {
      query: async () => {
        throw privilegeDeniedError("token_usage");
      },
    };
    await expect(requirePubchiRuntimeTables(pool)).rejects.toThrow(/insufficient privilege on public\.pubchi_nonces/);
    await expect(requirePubchiRuntimeTables(pool)).rejects.toThrow(/42501/);
    try {
      await requirePubchiRuntimeTables(pool);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/requires table/);
    }
  });

  it("rejects extension, Jeb-table, and unexpected-table migrations", async () => {
    for (const sql of [
      "CREATE EXTENSION vector;",
      "CREATE TABLE public.publish_requests (id INTEGER);",
      "CREATE TABLE public.unexpected_table (id INTEGER);",
    ]) {
      const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-invalid-"));
      try {
        await writeFile(path.join(migrationsPath, "001_bad.sql"), sql);
        const migrator = new PubchiMigrator({ query: vi.fn() } as never, migrationsPath);
        await expect(migrator.loadMigrations()).rejects.toThrow("Pubchi migration");
      } finally {
        await rm(migrationsPath, { recursive: true, force: true });
      }
    }
  });
});
