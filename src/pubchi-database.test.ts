import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import { log } from "./log.js";
import {
  assertPubchiMigrationConfig,
  assertPubchiRuntimeDatabaseConfig,
  pubchiMigrationsReady,
  pubchiRuntimeReadiness,
  requirePubchiMigrationsReady,
  runPubchiMigrations,
} from "./pubchi-database.js";

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
    const migrator = new DatabaseMigrator({ query } as never);
    const ready = await pubchiMigrationsReady(migrator);
    expect(ready).toBe(false);
    expect(query).toHaveBeenCalledWith("SELECT to_regclass('public.migrations')::text AS table_name");
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("CREATE"));
    await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("pubchi-migrate");
  });

  it("rejects runtime readiness when the ledger misses a checked-in migration", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-migrations-"));
    try {
      await writeFile(path.join(migrationsPath, "108_pubchi.sql"), "SELECT 1;");
      await writeFile(path.join(migrationsPath, "109_pubchi_budget.sql"), "SELECT 1;");
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.migrations" }] };
        if (sql === "SELECT id FROM public.migrations ORDER BY id") return { rows: [{ id: 108 }] };
        throw new Error(`unexpected query: ${sql}`);
      });
      const migrator = new DatabaseMigrator({ query } as never, migrationsPath);

      await expect(pubchiMigrationsReady(migrator)).resolves.toBe(false);
      await expect(requirePubchiMigrationsReady(migrator)).rejects.toThrow("pubchi-migrate");
      expect(query).toHaveBeenCalledWith("SELECT id FROM public.migrations ORDER BY id");
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

  it("creates the ledger as public.migrations", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const migrator = new DatabaseMigrator({ query } as never);
    await migrator.createMigrationsTable();
    expect(String(query.mock.calls[0]?.[0])).toMatch(/CREATE TABLE IF NOT EXISTS public\.migrations/);
  });

  it("qualifies compatibility DROPs to public.cursor_state and public.token_usage", async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        sql.push(text);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const query = vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("table_name = 'cursor_state'")) {
        return { rows: [{ column_name: "bot_id" }] };
      }
      if (text.includes("table_name = 'token_usage'")) {
        return { rows: [{ column_name: "mention_id" }] };
      }
      if (text === "SELECT id FROM public.migrations ORDER BY id") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn(async () => client) };
    const migrator = new DatabaseMigrator(pool as never);
    await migrator.runMigrations();
    expect(sql).toContain("DROP TABLE public.cursor_state");
    expect(sql).toContain("DROP TABLE IF EXISTS public.token_usage CASCADE");
    expect(sql).not.toContain("DROP TABLE cursor_state");
    expect(sql).not.toContain("DROP TABLE IF EXISTS token_usage CASCADE");
  });
});
