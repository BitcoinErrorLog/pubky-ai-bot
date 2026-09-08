import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DatabaseMigrator } from "./migrator.js";
import { PubchiMigrator } from "./pubchi-migrator.js";

const requiredTables = [
  "pubchi_nonces",
  "pubchi_budget_day",
  "token_usage",
  "kill_switch",
  "switches",
  "scout_queries",
];

describe("Pubchi migration manifest", () => {
  it("contains only the required Pubchi tables and no extension", async () => {
    const migrator = new PubchiMigrator({ query: vi.fn() } as never);
    const migrations = await migrator.loadMigrations();
    expect(migrations.map((m) => m.filename)).toEqual([
      "001_pubchi_foundation.sql",
      "002_pubchi_scout_queries.sql",
    ]);
    const sql = migrations.map((m) => m.sql).join("\n");
    expect(sql).not.toMatch(/CREATE EXTENSION|vector/i);
    for (const table of requiredTables) expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    expect(sql).not.toMatch(/publisher|knowledge|posts|drafts|work_queue|handled_mentions|cursor_state/i);
    expect(migrations[1]?.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_scout_queries_created ON public\.scout_queries/);
    expect(migrations[1]?.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_scout_queries_mention ON public\.scout_queries/);
    expect(migrations[1]?.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_scout_queries_tool_created ON public\.scout_queries/);
  });

  it("applies the manifest to a controllable empty database stub", async () => {
    const applied: Array<{ version: number; filename: string; checksum: string }> = [];
    const executed: string[] = [];
    const lockQueries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.pubchi_migrations" }] };
        if (sql.includes("SELECT version, filename")) return { rows: applied };
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          lockQueries.push(sql);
          executed.push(sql);
          if (sql.includes("INSERT INTO public.pubchi_migrations")) {
            applied.push({ version: values?.[0] as number, filename: values?.[1] as string, checksum: values?.[2] as string });
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    };

    const migrator = new PubchiMigrator(pool as never);
    await migrator.runMigrations();
    expect(applied).toHaveLength(2);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(lockQueries.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS public.pubchi_migrations"))).toBe(true);
    expect(lockQueries.some((sql) => sql.includes("INSERT INTO public.pubchi_migrations"))).toBe(true);
    expect(executed.join("\n")).not.toMatch(/CREATE EXTENSION|020_knowledge|CREATE TABLE public\.(posts|drafts)/i);
    await expect(migrator.allMigrationsApplied()).resolves.toBe(true);
  });

  const approvedNonceTable =
    "CREATE TABLE IF NOT EXISTS public.pubchi_nonces ( bot TEXT NOT NULL, asker TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (bot, asker, nonce) )";

  function ledgerPool(applied: Array<{ version: number; filename: string; checksum: string }>) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("to_regclass")) return { rows: [{ table_name: "public.pubchi_migrations" }] };
        if (sql.includes("SELECT version, filename, checksum")) return { rows: applied };
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("SELECT version, filename, checksum")) return { rows: applied };
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    };
  }

  it.each([
    "CREATE UNLOGGED TABLE IF NOT EXISTS public.pubchi_nonces (id INTEGER);",
    "CREATE TEMP TABLE public.pubchi_nonces (id INTEGER);",
    "DROP TABLE public.pubchi_nonces;",
    "ALTER TABLE public.pubchi_nonces ADD COLUMN unsafe TEXT;",
    "TRUNCATE public.pubchi_nonces;",
    "GRANT SELECT ON public.pubchi_nonces TO public;",
    "CREATE FUNCTION public.unsafe() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;",
    "CREATE EXTENSION vector;",
    "CREATE TABLE public.unexpected_table (id INTEGER);",
    "CREATE TABLE public.pubchi_nonces (id INTEGER); DROP TABLE public.pubchi_nonces;",
    "CREATE TABLE public.pubchi_nonces (id INTEGER) /* bypass */;",
    "-- bypass\nCREATE TABLE public.pubchi_nonces (id INTEGER);",
    `${approvedNonceTable};;`,
    `${approvedNonceTable}; ;`,
    approvedNonceTable,
    "   \n\t  ",
    `${approvedNonceTable.replace("CREATE TABLE", "CREATE TABLE\u00A0")};`,
  ])("rejects adversarial SQL: %s", async (sql) => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-invalid-"));
    try {
      await writeFile(path.join(migrationsPath, "001_bad.sql"), sql);
      await expect(new PubchiMigrator({ query: vi.fn() } as never, migrationsPath).loadMigrations()).rejects.toThrow(
        "Pubchi migration",
      );
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("accepts ordinary trailing whitespace and a terminal newline", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-trailing-"));
    try {
      await writeFile(path.join(migrationsPath, "001_ok.sql"), `${approvedNonceTable};  \n`);
      const [migration] = await new PubchiMigrator({ query: vi.fn() } as never, migrationsPath).loadMigrations();
      expect(migration?.filename).toBe("001_ok.sql");
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("rejects a whitespace-only file as having zero statements", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-blank-"));
    try {
      await writeFile(path.join(migrationsPath, "001_blank.sql"), " \n\t\n ");
      await expect(new PubchiMigrator({ query: vi.fn() } as never, migrationsPath).loadMigrations()).rejects.toThrow(
        "one or more semicolon-terminated statements",
      );
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("fails closed when the ledger checksum does not match the real manifest", async () => {
    const [expected] = await new PubchiMigrator({ query: vi.fn() } as never).loadMigrations();
    const applied = [{ version: expected.version, filename: expected.filename, checksum: "0".repeat(64) }];
    const pool = ledgerPool(applied);
    const migrator = new PubchiMigrator(pool as never);
    await expect(migrator.allMigrationsApplied()).resolves.toBe(false);
    await expect(migrator.runMigrations()).rejects.toThrow("ledger mismatch");
  });

  it("fails closed when the ledger filename does not match the real manifest", async () => {
    const [expected] = await new PubchiMigrator({ query: vi.fn() } as never).loadMigrations();
    const applied = [{ version: expected.version, filename: "001_tampered.sql", checksum: expected.checksum }];
    const pool = ledgerPool(applied);
    const migrator = new PubchiMigrator(pool as never);
    await expect(migrator.allMigrationsApplied()).resolves.toBe(false);
    await expect(migrator.runMigrations()).rejects.toThrow("ledger mismatch");
  });

  it("fails closed when the ledger has an extra row", async () => {
    const [expected] = await new PubchiMigrator({ query: vi.fn() } as never).loadMigrations();
    const applied = [
      { version: expected.version, filename: expected.filename, checksum: expected.checksum },
      { version: 2, filename: "002_extra.sql", checksum: "ab".repeat(32) },
    ];
    const pool = ledgerPool(applied);
    const migrator = new PubchiMigrator(pool as never);
    await expect(migrator.allMigrationsApplied()).resolves.toBe(false);
    await expect(migrator.runMigrations()).rejects.toThrow("ledger mismatch");
  });

  it("reports unreadiness when the ledger is missing the real manifest row", async () => {
    const pool = ledgerPool([]);
    const migrator = new PubchiMigrator(pool as never);
    await expect(migrator.allMigrationsApplied()).resolves.toBe(false);
    await expect(migrator.runMigrations()).resolves.toBeUndefined();
  });

  it("fails closed for an empty packaged manifest", async () => {
    const migrationsPath = await mkdtemp(path.join(tmpdir(), "pubchi-empty-"));
    try {
      const pool = {
        query: vi.fn(),
        connect: vi.fn(async () => ({
          query: vi.fn(),
          release: vi.fn(),
        })),
      };
      const migrator = new PubchiMigrator(pool as never, migrationsPath);
      await expect(migrator.loadMigrations()).rejects.toThrow("manifest is empty");
      await expect(migrator.runMigrations()).rejects.toThrow("manifest is empty");
    } finally {
      await rm(migrationsPath, { recursive: true, force: true });
    }
  });

  it("leaves the normal Jeb migrator on the historical migration directory", async () => {
    const migrator = new DatabaseMigrator({ query: vi.fn() } as never);
    const filenames = (await migrator.loadMigrations()).map((migration) => migration.filename);
    expect(filenames).toContain("020_knowledge.sql");
    expect(filenames).not.toContain("001_pubchi_foundation.sql");
  });

  it("applies the packaged manifest so scout_queries has the 030 columns and indexes", async () => {
    const pg = await import("pg");
    const url = process.env.DATABASE_URL;
    expect(url).toMatch(/\/jeb_vitest(?:\?|$)/);
    const pool = new pg.default.Pool({ connectionString: url });
    try {
      await pool.query("DELETE FROM public.pubchi_migrations WHERE version = 2");
      await pool.query("DROP TABLE IF EXISTS public.scout_queries CASCADE");
      await new PubchiMigrator(pool).runMigrations();
      const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'scout_queries'
         ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((row) => row.column_name)).toEqual([
        "id",
        "tool",
        "cypher_hash",
        "params_hash",
        "rows",
        "truncated",
        "duration_ms",
        "ok",
        "error_code",
        "mention_key",
        "created_at",
      ]);
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'scout_queries'
         ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "idx_scout_queries_created",
          "idx_scout_queries_mention",
          "idx_scout_queries_tool_created",
        ]),
      );
    } finally {
      await pool.end();
    }
  });
});
