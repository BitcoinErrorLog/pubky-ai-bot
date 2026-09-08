import pg from "pg";
import { PubchiMigrator } from "./infrastructure/database/pubchi-migrator.js";
import { flushLog, log } from "./log.js";

export const PUBCHI_RUNTIME_ROLE = "pubchi";
export const PUBCHI_MIGRATOR_ROLE = "pubchi-migrate";

const ALTERNATE_DATABASE_ENV_NAMES = ["PUBCHI_RUNTIME_DATABASE_URL", "PUBCHI_MIGRATOR_DATABASE_URL"] as const;
const JEB_DATABASE_ENV_NAMES = ["JEB_DB_URL_INGEST", "JEB_DB_URL_REASON"] as const;
const MIGRATION_DISALLOWED_ENV_NAMES = [
  "JEB_SKIP_MIGRATIONS",
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_SECRET_KEY_FILE",
  "PUBKY_BOT_MNEMONIC",
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_HOMESERVER",
  "JEB_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "JEB_MODEL_API_KEY",
  "JEB_BRAVE_API_KEY",
] as const;

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("Pubchi migration requires DATABASE_URL");
  return url;
}

export function assertPubchiMigrationConfig(env: NodeJS.ProcessEnv = process.env): void {
  requireDatabaseUrl(env);
  for (const name of ALTERNATE_DATABASE_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi migration forbids ${name}`);
  }
  for (const name of JEB_DATABASE_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi migration forbids ${name}`);
  }
  for (const name of MIGRATION_DISALLOWED_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi migration forbids ${name}`);
  }
  if (env.PUBCHI_BIND !== undefined || env.PUBCHI_PORT !== undefined) {
    throw new Error("Pubchi migration forbids HTTP bind configuration");
  }
}

export function assertPubchiRuntimeDatabaseConfig(env: NodeJS.ProcessEnv = process.env): void {
  requireDatabaseUrl(env);
  for (const name of ALTERNATE_DATABASE_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi runtime forbids ${name}`);
  }
  for (const name of JEB_DATABASE_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi runtime forbids ${name}`);
  }
}

export async function runPubchiMigrations(
  databaseUrl: string,
  createMigrator: (pool: pg.Pool) => PubchiMigrator = (pool) => new PubchiMigrator(pool),
  createPool: (connectionString: string) => pg.Pool = (connectionString) => new pg.Pool({ connectionString }),
): Promise<void> {
  const pool = createPool(databaseUrl);
  let thrown: unknown;
  try {
    await createMigrator(pool).runMigrations();
    log.info({ role: PUBCHI_MIGRATOR_ROLE, mode: "migration" }, "Pubchi migrations applied");
  } catch (error) {
    thrown = error;
    log.info(
      { err: String(error), role: PUBCHI_MIGRATOR_ROLE, mode: "migration" },
      "Pubchi migrations failed",
    );
  } finally {
    try {
      await flushLog();
    } catch (flushError) {
      thrown ??= flushError;
    }
    try {
      await pool.end();
    } catch (endError) {
      thrown ??= endError;
    }
  }
  if (thrown !== undefined) throw thrown;
}

export async function pubchiMigrationsReady(
  migrator: Pick<PubchiMigrator, "allMigrationsApplied">,
): Promise<boolean> {
  return migrator.allMigrationsApplied();
}

export async function requirePubchiMigrationsReady(
  migrator: Pick<PubchiMigrator, "allMigrationsApplied">,
): Promise<void> {
  if (!(await pubchiMigrationsReady(migrator))) {
    throw new Error("Pubchi runtime requires all migrations to be applied by --role pubchi-migrate");
  }
}

export const PUBCHI_RUNTIME_TABLES = [
  "pubchi_nonces",
  "pubchi_budget_day",
  "token_usage",
  "kill_switch",
  "switches",
  "scout_queries",
] as const;

function pgCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

export const PUBCHI_RUNTIME_TABLE_EXISTS_SQL =
  "SELECT to_regclass($1) IS NOT NULL AS present";

type RuntimeTableProbeOk = { ok: true };
type RuntimeTableProbeFail = {
  ok: false;
  table: string;
  kind: "missing" | "privilege" | "error";
  name?: string;
  pgCode?: string;
};

function qualifiedRuntimeTable(table: (typeof PUBCHI_RUNTIME_TABLES)[number]): string {
  return `public.${table}`;
}

function probeFailureMessage(probed: RuntimeTableProbeFail): string {
  const qualified = qualifiedRuntimeTable(probed.table as (typeof PUBCHI_RUNTIME_TABLES)[number]);
  if (probed.kind === "missing") return `Pubchi runtime requires table ${qualified}`;
  if (probed.kind === "privilege") {
    return `Pubchi runtime insufficient privilege on ${qualified}${probed.pgCode ? ` ${probed.pgCode}` : ""}`;
  }
  return `Pubchi runtime probe failed: ${probed.name ?? "error"} ${probed.pgCode ?? ""}`.trim();
}

export async function probePubchiRuntimeTables(pool: {
  query: (sql: string, values?: unknown[]) => Promise<{ rows?: Array<{ present?: boolean }> } | unknown>;
}): Promise<RuntimeTableProbeOk | RuntimeTableProbeFail> {
  for (const table of PUBCHI_RUNTIME_TABLES) {
    try {
      const result = (await pool.query(PUBCHI_RUNTIME_TABLE_EXISTS_SQL, [qualifiedRuntimeTable(table)])) as {
        rows?: Array<{ present?: boolean }>;
      };
      if (result.rows?.[0]?.present !== true) {
        log.warn(
          { event: "pubchi_runtime_table_missing", table, kind: "missing" },
          "Pubchi runtime table probe failed",
        );
        return { ok: false, table, kind: "missing" };
      }
    } catch (error) {
      const pgCode = pgCodeOf(error);
      const name = error instanceof Error ? error.name : "error";
      const kind = pgCode === "42501" ? "privilege" : "error";
      log.warn(
        {
          event: kind === "privilege" ? "pubchi_runtime_table_privilege" : "pubchi_runtime_table_probe_failed",
          table,
          kind,
          name,
          message: error instanceof Error ? error.message : String(error),
          pgCode,
        },
        "Pubchi runtime table probe failed",
      );
      return { ok: false, table, kind, name, pgCode };
    }
  }
  return { ok: true };
}

export async function requirePubchiRuntimeTables(pool: {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const probed = await probePubchiRuntimeTables(pool);
  if (!probed.ok) {
    throw new Error(probeFailureMessage(probed));
  }
}

export async function pubchiRuntimeReadiness(
  pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  migrator: Pick<PubchiMigrator, "allMigrationsApplied">,
): Promise<{ config: true; database: boolean; migrations: boolean }> {
  try {
    await pool.query("SELECT 1");
  } catch {
    return { config: true, database: false, migrations: false };
  }
  const tables = await probePubchiRuntimeTables(pool);
  if (!tables.ok) {
    return { config: true, database: false, migrations: false };
  }
  try {
    return {
      config: true,
      database: true,
      migrations: await pubchiMigrationsReady(migrator),
    };
  } catch {
    return { config: true, database: true, migrations: false };
  }
}
