import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../../src/db.js";
import {
  adminDatabaseUrl,
  assertSuiteDatabaseIdle,
  collisionError,
  databaseName,
  defaultSuiteDatabaseSuffix,
  DEFAULT_SUITE_DATABASE_URL,
  pinSuiteDatabaseEnv,
  rewriteDatabaseName,
  SUITE_DATABASE_NAME,
  suiteDatabaseName,
  suiteDatabaseUrl,
} from "./suite-database.js";

describe("suite database URL", () => {
  it("rewrites jeb_stage1_test to the legacy jeb_vitest name when suffix is empty", () => {
    expect(
      suiteDatabaseUrl({
        DATABASE_URL: "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test",
        JEB_SUITE_DATABASE_SUFFIX: "",
      }),
    ).toBe("postgres://johncarvalho@127.0.0.1:5432/jeb_vitest");
  });

  it("derives a stable default suffix from the worktree root", () => {
    const root = "/worktrees/alpha";
    expect(suiteDatabaseName({}, root)).toBe(`${SUITE_DATABASE_NAME}_${defaultSuiteDatabaseSuffix(root)}`);
    expect(suiteDatabaseName({}, root)).toBe(suiteDatabaseName({}, root));
  });

  it("uses an explicit suffix and rejects unsafe suffixes", () => {
    expect(suiteDatabaseName({ JEB_SUITE_DATABASE_SUFFIX: "feature_1" })).toBe("jeb_vitest_feature_1");
    expect(() => suiteDatabaseName({ JEB_SUITE_DATABASE_SUFFIX: "BAD-NAME" })).toThrow(/unsafe suite database suffix/);
    expect(() => suiteDatabaseName({ JEB_SUITE_DATABASE_SUFFIX: "x".repeat(17) })).toThrow(/unsafe suite database suffix/);
  });

  it("keeps forbidden database names rejected", () => {
    for (const forbidden of ["jeb_stage1_test", "jeb", "postgres"]) {
      expect(() => suiteDatabaseUrl({ JEB_SUITE_DATABASE_SUFFIX: forbidden })).toThrow(/unsafe suite database suffix/);
    }
  });

  it("uses different names for different fake worktree roots", () => {
    expect(suiteDatabaseUrl({}, "/worktrees/one")).not.toBe(suiteDatabaseUrl({}, "/worktrees/two"));
  });

  it("defaults to a per-worktree name when DATABASE_URL is unset", () => {
    const url = suiteDatabaseUrl({}, "/worktrees/alpha");
    expect(url).toBe(`postgres://johncarvalho@127.0.0.1:5432/${SUITE_DATABASE_NAME}_${defaultSuiteDatabaseSuffix("/worktrees/alpha")}`);
    expect(databaseName(DEFAULT_SUITE_DATABASE_URL)).toBe(SUITE_DATABASE_NAME);
  });

  it("pins DATABASE_URL and drops per-role URLs so a reason worker cannot inherit jeb_stage1_test", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test",
      JEB_DB_URL_REASON: "postgres://reason@127.0.0.1:5432/jeb_stage1_test",
      JEB_DB_URL_INGEST: "postgres://ingest@127.0.0.1:5432/jeb_stage1_test",
    };
    const url = pinSuiteDatabaseEnv(env);
    expect(url).toMatch(/\/jeb_vitest_[a-z0-9]{6}$/);
    expect(env.DATABASE_URL).toBe(url);
    expect(env.JEB_DB_URL_REASON).toBeUndefined();
    expect(env.JEB_DB_URL_INGEST).toBeUndefined();
    expect(env.JEB_EVAL_DATABASE_URL).toBe("postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test");
  });

  it("this worker is connected to jeb_vitest, not jeb_stage1_test", async () => {
    expect(databaseName(process.env.DATABASE_URL ?? "")).toMatch(/^jeb_vitest(?:_[a-z0-9]{6})?$/);
    const store = new Store(process.env.DATABASE_URL ?? "");
    try {
      const r = await store.pool.query<{ current_database: string }>("SELECT current_database()");
    expect(r.rows[0]?.current_database).toBe(databaseName(process.env.DATABASE_URL ?? ""));
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
