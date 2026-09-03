import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import { Store } from "./db.js";

const adminUrl = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

function adminConnection(): string {
  const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
  u.pathname = "/postgres";
  return `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}${u.pathname}`;
}

describe("DatabaseMigrator advisory lock", () => {
  const dbName = `jeb_miglock_${Date.now()}`;
  const created: string[] = [];

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: adminConnection() });
    await admin.connect();
    try {
      for (const name of created) {
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      }
    } finally {
      await admin.end();
    }
  });

  it("two concurrent migrate calls on a fresh database both succeed", async () => {
    const admin = new pg.Client({ connectionString: adminConnection() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      created.push(dbName);
    } finally {
      await admin.end();
    }
    const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    const url = `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}/${dbName}`;
    const a = new Store(url);
    const b = new Store(url);
    try {
      await Promise.all([a.migrate(), b.migrate()]);
      const applied = await a.pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM migrations");
      expect(applied.rows[0]?.n).toBeGreaterThan(0);
      const migrator = new DatabaseMigrator(a.pool);
      const files = await migrator.loadMigrations();
      const ids = await migrator.getAppliedMigrations();
      expect(ids).toEqual(files.map((m) => m.id));
    } finally {
      await a.close();
      await b.close();
    }
  });
});
