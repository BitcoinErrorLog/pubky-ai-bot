import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  discoverResources,
  RESOURCE_RECORD_MAX,
  type ExternalResourceInput,
  type ResourceRun,
} from "./external-resources.js";

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
}

interface ReadOnlyDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options: { readOnly: boolean }) => ReadOnlyDatabase;

function loadDatabaseSync(): DatabaseSyncCtor {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: DatabaseSyncCtor;
    };
    return DatabaseSync;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ERR_UNKNOWN_BUILTIN_MODULE" || message.includes("node:sqlite")) {
      throw new Error("--role resources requires Node >= 22.13 for node:sqlite");
    }
    throw error;
  }
}

const REQUIRED_COLUMNS = new Set([
  "url",
  "post_id",
  "title",
  "description",
  "image_url",
  "site_name",
  "domain",
  "language",
  "published_at",
  "source",
]);

export interface CrawlerResourceSelection {
  dbPath: string;
  source: string;
  labels: string[];
  limit?: number;
}

interface CrawlerRow {
  url?: unknown;
  title?: unknown;
  source?: unknown;
}

function corpusSource(source: string): string {
  return `web-index-${source}`;
}

function rowToInput(row: CrawlerRow, source: string, labels: string[]): ExternalResourceInput {
  const input: Record<string, unknown> = {
    family: "url",
    value: row.url,
    source: corpusSource(source),
    labels,
  };
  if (row.title !== null && row.title !== undefined) input.title = row.title;
  return input as unknown as ExternalResourceInput;
}

function assertSchema(database: ReadOnlyDatabase): void {
  const columns = database
    .prepare("PRAGMA table_info(urls)")
    .all() as Array<{ name?: unknown }>;
  const actual = new Set(columns.map((column) => column.name).filter((name): name is string => typeof name === "string"));
  const missing = [...REQUIRED_COLUMNS].filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(`crawler corpus schema is missing urls columns: ${missing.join(", ")}`);
  }
}

export async function discoverCrawlerResources(selection: CrawlerResourceSelection): Promise<ResourceRun> {
  if (!selection.dbPath.trim()) throw new Error("crawler corpus requires --db <sqlite-file>");
  if (!selection.source.trim()) throw new Error("crawler corpus requires --source <crawler-source>");
  if (selection.labels.length === 0) throw new Error("crawler corpus requires at least one explicit --label");

  const file = await stat(selection.dbPath);
  if (!file.isFile()) throw new Error("crawler corpus database must be a regular file");

  const DatabaseSync = loadDatabaseSync();
  let database: ReadOnlyDatabase;
  try {
    database = new DatabaseSync(selection.dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `crawler corpus database could not be opened read-only: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    assertSchema(database);
    const countRow = database
      .prepare("SELECT COUNT(*) AS count FROM urls WHERE source = ?")
      .get(selection.source) as { count?: number | bigint };
    const count = Number(countRow?.count ?? 0);
    if (!Number.isSafeInteger(count)) throw new Error("crawler corpus selection count is not a safe integer");
    if (count > RESOURCE_RECORD_MAX) {
      throw new Error(`crawler corpus selection contains ${count} records; maximum is ${RESOURCE_RECORD_MAX}`);
    }
    if (selection.limit !== undefined && selection.limit < count) {
      throw new Error(`crawler corpus selection contains ${count} records but limit is ${selection.limit}; refusing to drop rows`);
    }

    const rows = database
      .prepare("SELECT url, title, source FROM urls WHERE source = ? ORDER BY url")
      .all(selection.source) as CrawlerRow[];
    if (rows.length !== count) {
      throw new Error(`crawler corpus selection count changed while reading: counted ${count}, read ${rows.length}`);
    }
    const inputs = rows.map((row) => rowToInput(row, selection.source, [...selection.labels]));
    return discoverResources(inputs, {
      category: "pubky",
      limit: selection.limit ?? RESOURCE_RECORD_MAX,
      configVersion: "external-resources-v1",
    });
  } finally {
    database.close();
  }
}
