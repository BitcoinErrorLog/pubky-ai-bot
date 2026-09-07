import pg from "pg";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
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
  createMigrator: (pool: pg.Pool) => DatabaseMigrator = (pool) => new DatabaseMigrator(pool),
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
  migrator: Pick<DatabaseMigrator, "allMigrationsApplied">,
): Promise<boolean> {
  return migrator.allMigrationsApplied();
}

export async function requirePubchiMigrationsReady(
  migrator: Pick<DatabaseMigrator, "allMigrationsApplied">,
): Promise<void> {
  if (!(await pubchiMigrationsReady(migrator))) {
    throw new Error("Pubchi runtime requires all migrations to be applied by --role pubchi-migrate");
  }
}

export async function pubchiRuntimeReadiness(
  pool: { query: (sql: string) => Promise<unknown> },
  migrator: Pick<DatabaseMigrator, "allMigrationsApplied">,
): Promise<{ config: true; database: boolean; migrations: boolean }> {
  try {
    await pool.query("SELECT 1");
  } catch {
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
