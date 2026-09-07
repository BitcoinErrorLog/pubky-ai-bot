import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../../src/db.js";
import {
  adminDatabaseUrl,
  assertSuiteDatabaseIdle,
  collisionError,
  databaseName,
  DEFAULT_SUITE_DATABASE_URL,
  pinSuiteDatabaseEnv,
  rewriteDatabaseName,
  SUITE_DATABASE_NAME,
  suiteDatabaseUrl,
} from "./suite-database.js";

describe("suite database URL", () => {
  it("rewrites jeb_stage1_test to jeb_vitest keeping host and user", () => {
    expect(
      suiteDatabaseUrl({
        DATABASE_URL: "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test",
      }),
    ).toBe("postgres://johncarvalho@127.0.0.1:5432/jeb_vitest");
  });

  it("defaults to jeb_vitest when DATABASE_URL is unset", () => {
    expect(suiteDatabaseUrl({})).toBe(DEFAULT_SUITE_DATABASE_URL);
    expect(databaseName(DEFAULT_SUITE_DATABASE_URL)).toBe(SUITE_DATABASE_NAME);
  });

  it("pins DATABASE_URL and drops per-role URLs so a reason worker cannot inherit jeb_stage1_test", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test",
      JEB_DB_URL_REASON: "postgres://reason@127.0.0.1:5432/jeb_stage1_test",
      JEB_DB_URL_INGEST: "postgres://ingest@127.0.0.1:5432/jeb_stage1_test",
    };
    const url = pinSuiteDatabaseEnv(env);
    expect(url).toBe("postgres://johncarvalho@127.0.0.1:5432/jeb_vitest");
    expect(env.DATABASE_URL).toBe(url);
    expect(env.JEB_DB_URL_REASON).toBeUndefined();
    expect(env.JEB_DB_URL_INGEST).toBeUndefined();
    expect(env.JEB_EVAL_DATABASE_URL).toBe("postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test");
  });

  it("this worker is connected to jeb_vitest, not jeb_stage1_test", async () => {
    expect(databaseName(process.env.DATABASE_URL ?? "")).toBe(SUITE_DATABASE_NAME);
    const store = new Store(process.env.DATABASE_URL ?? "");
    try {
      const r = await store.pool.query<{ current_database: string }>("SELECT current_database()");
      expect(r.rows[0]?.current_database).toBe(SUITE_DATABASE_NAME);
      expect(r.rows[0]?.current_database).not.toBe("jeb_stage1_test");
    } finally {
      await store.close();
    }
  });
});

describe("collision guard", () => {
  const dbName = `jeb_vitest_guard_${Date.now()}`;
  const created: string[] = [];

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: adminDatabaseUrl(process.env.DATABASE_URL ?? DEFAULT_SUITE_DATABASE_URL) });
    await admin.connect();
    try {
      for (const name of created) {
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      }
    } finally {
      await admin.end();
    }
  });

  it("fails loudly when another client is connected or owned tables have rows", async () => {
    const template = process.env.DATABASE_URL ?? DEFAULT_SUITE_DATABASE_URL;
    const url = rewriteDatabaseName(template, dbName);
    const admin = new pg.Client({ connectionString: adminDatabaseUrl(template) });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      created.push(dbName);
    } finally {
      await admin.end();
    }
    const store = new Store(url);
    const holder = new pg.Client({ connectionString: url, application_name: "stray-reason" });
    try {
      await store.migrate();
      await holder.connect();
      await store.claim("pubky://guard/pub/pubky.app/posts/GUARD00000001", "a", "bot");
      await expect(assertSuiteDatabaseIdle(url, dbName)).rejects.toThrow(/Jeb test database collision/);
      await expect(assertSuiteDatabaseIdle(url, dbName)).rejects.toThrow(/stray-reason|not empty|other client/i);
    } finally {
      await holder.end().catch(() => undefined);
      await store.close();
    }
  });

  it("collisionError names the stray-bot cause", () => {
    const err = collisionError({
      database: SUITE_DATABASE_NAME,
      foreign: [{ pid: 9, application_name: "stray-reason", state: "idle" }],
      rows: [{ table: "handled_mentions", n: 1 }],
    });
    expect(err.message).toMatch(/jeb_vitest/);
    expect(err.message).toMatch(/--role reason/);
    expect(err.message).toMatch(/jeb_stage1_test/);
  });
});
