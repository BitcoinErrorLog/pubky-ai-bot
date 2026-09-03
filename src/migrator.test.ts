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

  it("migration 050 dedupes pre-existing duplicate active rows before creating the indexes (R-07)", async () => {
    const dbName = `jeb_migdedupe_${Date.now()}`;
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
    const store = new Store(url);
    try {
      await store.migrate();
      // Simulate a database that ran the pre-fix race: make 050 pending again,
      // drop its indexes, and seed duplicate active rows.
      await store.pool.query("DELETE FROM migrations WHERE id = 50");
      await store.pool.query("DROP INDEX IF EXISTS work_queue_active_mention_key");
      await store.pool.query("DROP INDEX IF EXISTS publish_requests_active_mention_key");
      const dupWork = "pubky://dup/pub/pubky.app/posts/WORK000000001";
      const dupPub = "pubky://dup/pub/pubky.app/posts/PUB0000000001";
      for (let i = 0; i < 2; i++) {
        await store.pool.query(
          `INSERT INTO work_queue (mention_key, author, kind, payload, status) VALUES ($1, 'a', 'mention', '{}'::jsonb, 'queued')`,
          [dupWork],
        );
        await store.pool.query(
          `INSERT INTO publish_requests (mention_key, parent_uri, content, status) VALUES ($1, $1, 'c', 'queued')`,
          [dupPub],
        );
      }

      const migrator = new DatabaseMigrator(store.pool);
      await migrator.runMigrations();
      // Idempotent: a second run is a no-op success.
      await migrator.runMigrations();

      const work = await store.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM work_queue WHERE mention_key = $1",
        [dupWork],
      );
      const pubs = await store.pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM publish_requests WHERE mention_key = $1",
        [dupPub],
      );
      expect(work.rows[0]?.n).toBe(1);
      expect(pubs.rows[0]?.n).toBe(1);
      const indexes = await store.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
         AND indexname IN ('work_queue_active_mention_key', 'publish_requests_active_mention_key')`,
      );
      expect(indexes.rows.map((r) => r.indexname).sort()).toEqual([
        "publish_requests_active_mention_key",
        "work_queue_active_mention_key",
      ]);
      // The unique constraint is live again.
      await expect(
        store.pool.query(
          `INSERT INTO work_queue (mention_key, author, kind, payload, status) VALUES ($1, 'a', 'mention', '{}'::jsonb, 'queued')`,
          [dupWork],
        ),
      ).rejects.toThrow();
    } finally {
      await store.close();
    }
  });
});
