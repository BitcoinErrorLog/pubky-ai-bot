import pg from "pg";
import { Store } from "../../src/db.js";

/** Database name reserved for `vitest` / `npm test`. Never a live bot. */
export const SUITE_DATABASE_NAME = "jeb_vitest";

/** Shared local-dev default; host/user come from DATABASE_URL when set. */
export const DEFAULT_SUITE_DATABASE_URL = `postgres://johncarvalho@127.0.0.1:5432/${SUITE_DATABASE_NAME}`;

const FORBIDDEN_DATABASE_NAMES = new Set(["jeb_stage1_test", "jeb", "postgres"]);

export function databaseName(url: string): string {
  const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
  return decodeURIComponent(u.pathname.replace(/^\//, ""));
}

export function postgresProtocol(url: string): "postgres" | "postgresql" {
  return url.startsWith("postgresql://") ? "postgresql" : "postgres";
}

export function formatPostgresUrl(url: string, pathname: string): string {
  const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
  u.pathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const proto = postgresProtocol(url);
  const auth = u.username
    ? `${u.username}${u.password ? `:${u.password}` : ""}@`
    : "";
  return `${proto}://${auth}${u.host}${u.pathname}${u.search}`;
}

export function rewriteDatabaseName(url: string, name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing unsafe database name ${name}`);
  }
  return formatPostgresUrl(url, `/${name}`);
}

export function adminDatabaseUrl(url: string): string {
  return formatPostgresUrl(url, "/postgres");
}

/**
 * Resolve the suite URL from this repo's existing env idiom: take host and
 * credentials from `JEB_SUITE_DATABASE_URL` or `DATABASE_URL`, then force the
 * database name to `jeb_vitest` so a shell leftover pointing at
 * `jeb_stage1_test` cannot be inherited by the suite.
 */
export function suiteDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const template =
    env.JEB_SUITE_DATABASE_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    DEFAULT_SUITE_DATABASE_URL;
  const url = rewriteDatabaseName(template, SUITE_DATABASE_NAME);
  const name = databaseName(url);
  if (FORBIDDEN_DATABASE_NAMES.has(name) || name !== SUITE_DATABASE_NAME) {
    throw new Error(`tests must not use database ${name}; expected ${SUITE_DATABASE_NAME}`);
  }
  return url;
}

export function pinSuiteDatabaseEnv(env: NodeJS.ProcessEnv = process.env): string {
  const originalDb = env.DATABASE_URL?.trim();
  const url = suiteDatabaseUrl(env);
  if (!env.JEB_EVAL_DATABASE_URL?.trim()) {
    if (originalDb && databaseName(originalDb) !== SUITE_DATABASE_NAME) {
      env.JEB_EVAL_DATABASE_URL = originalDb;
    } else {
      env.JEB_EVAL_DATABASE_URL = rewriteDatabaseName(url, "jeb_eval");
    }
  }
  env.DATABASE_URL = url;
  delete env.JEB_DB_URL_REASON;
  delete env.JEB_DB_URL_INGEST;
  return url;
}

function postgresUnreachableError(url: string, cause: unknown): Error {
  const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
  const role = u.username || "(default role)";
  const hint =
    `Jeb tests need a reachable Postgres to create and migrate database "${SUITE_DATABASE_NAME}". ` +
    `Start Postgres (e.g. brew services start postgresql@17) and ensure role "${role}" can connect to ${u.host}. ` +
    `Do not skip these tests; a green skip hides the same class of failure as a shared database.`;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${hint} (${detail})`);
}

export async function ensureSuiteDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  if (name !== SUITE_DATABASE_NAME) {
    throw new Error(`refusing to create database ${name}`);
  }
  const admin = new pg.Client({ connectionString: adminDatabaseUrl(url) });
  try {
    await admin.connect();
  } catch (e) {
    throw postgresUnreachableError(url, e);
  }
  try {
    const found = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [name],
    );
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } catch (e) {
    throw postgresUnreachableError(url, e);
  } finally {
    await admin.end();
  }
}

export async function migrateSuiteDatabase(url: string): Promise<void> {
  const store = new Store(url);
  try {
    await store.migrate();
  } catch (e) {
    throw postgresUnreachableError(url, e);
  } finally {
    await store.close();
  }
}

export async function ownedPublicTables(client: pg.Client): Promise<string[]> {
  const r = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname <> 'migrations'
      ORDER BY c.relname`,
  );
  return r.rows.map((row) => row.relname);
}

export type ForeignClient = { pid: number; application_name: string; state: string };

export async function foreignClientBackends(client: pg.Client): Promise<ForeignClient[]> {
  const r = await client.query<ForeignClient>(
    `SELECT pid, coalesce(application_name, '') AS application_name, coalesce(state, '') AS state
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`,
  );
  return r.rows;
}

/**
 * Tables a live bot writes while answering. Migration seed rows
 * (`kill_switch`, `collection_rules`, `tracked_projects`) are expected and
 * are not treated as a collision.
 */
export const SUITE_COLLISION_TABLES = [
  "handled_mentions",
  "work_queue",
  "publish_requests",
  "evidence",
  "token_usage",
  "scout_queries",
  "web_queries",
  "corrections",
] as const;

export async function nonemptyOwnedTables(client: pg.Client): Promise<Array<{ table: string; n: number }>> {
  const present = new Set(await ownedPublicTables(client));
  const out: Array<{ table: string; n: number }> = [];
  for (const table of SUITE_COLLISION_TABLES) {
    if (!present.has(table)) continue;
    const r = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)}`);
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) out.push({ table, n });
  }
  return out;
}

function quoteIdent(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`refusing to quote ${name}`);
  return `"${name}"`;
}

export function collisionError(opts: {
  database: string;
  foreign: ForeignClient[];
  rows: Array<{ table: string; n: number }>;
}): Error {
  const bits: string[] = [];
  if (opts.foreign.length > 0) {
    const detail = opts.foreign
      .map((f) => `pid=${f.pid} app=${f.application_name || "(none)"} state=${f.state || "(none)"}`)
      .join("; ");
    bits.push(
      `${opts.foreign.length} other client connection(s) to "${opts.database}" (${detail}). ` +
        `A stray bot (for example \`--role reason\` inherited from a sibling worktree) or another test run is using this database.`,
    );
  }
  if (opts.rows.length > 0) {
    const detail = opts.rows.map((r) => `${r.table}=${r.n}`).join(", ");
    bits.push(
      `database "${opts.database}" is not empty at suite start (${detail}). ` +
        `A previous suite crashed before teardown, or another process wrote rows. ` +
        `This used to surface as scattered assertion failures and was misread as leftover row pollution.`,
    );
  }
  return new Error(
    `Jeb test database collision: ${bits.join(" ")} ` +
      `Kill the extra process (or drop leftover rows in ${opts.database}) and re-run. ` +
      `Tests never use jeb_stage1_test; live bots must not be pointed at ${opts.database}.`,
  );
}

export async function assertSuiteDatabaseIdle(
  url: string,
  expectedName: string = SUITE_DATABASE_NAME,
): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: "jeb-vitest-setup" });
  try {
    await client.connect();
  } catch (e) {
    throw postgresUnreachableError(url, e);
  }
  try {
    const current = await client.query<{ current_database: string }>("SELECT current_database()");
    const name = current.rows[0]?.current_database ?? "";
    if (name !== expectedName) {
      throw new Error(`suite connected to ${name}, expected ${expectedName}`);
    }
    const foreign = await foreignClientBackends(client);
    const rows = await nonemptyOwnedTables(client);
    if (foreign.length > 0 || rows.length > 0) {
      throw collisionError({ database: name, foreign, rows });
    }
  } finally {
    await client.end();
  }
}

export async function truncateOwnedTables(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: "jeb-vitest-teardown" });
  await client.connect();
  try {
    const present = new Set(await ownedPublicTables(client));
    const tables = SUITE_COLLISION_TABLES.filter((t) => present.has(t));
    if (tables.length === 0) return;
    const list = tables.map(quoteIdent).join(", ");
    await client.query(`TRUNCATE ${list} CASCADE`);
  } finally {
    await client.end();
  }
}
