import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import { Store } from "./db.js";

const adminUrl = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_vitest";

function adminConnection(): string {
  const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
  u.pathname = "/postgres";
  return `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}${u.pathname}`;
}

describe("DatabaseMigrator advisory lock", () => {
  const dbName = `jeb_miglock_${Date.now()}`;
  const created: string[] = [];
  const fixtureDirectories: string[] = [];

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
    for (const directory of fixtureDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

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
      const persona = await a.pool.query<{ bot_pk: string; current_version: string }>(
        "SELECT bot_pk, current_version FROM personas WHERE id = 'jeb'",
      );
      expect(persona.rows).toEqual([
        {
          bot_pk: "9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y",
          current_version: "1.1.0",
        },
      ]);
      const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs");
      const preflightSql = fs
        .readFileSync(path.join(docsDir, "persona-migration-preflight.sql"), "utf8")
        .replace(/^\\set ON_ERROR_STOP on\s*/m, "");
      await a.pool.query(
        `SET jeb.bot_pk = '9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y';\n${preflightSql}`,
      );
      const verifySql = fs
        .readFileSync(path.join(docsDir, "persona-migration-verify.sql"), "utf8")
        .replace(/^\\set ON_ERROR_STOP on\s*/m, "");
      await expect(a.pool.query(verifySql)).resolves.toBeDefined();
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
      await store.pool.query("DROP INDEX IF EXISTS work_queue_active_persona_mention");
      await store.pool.query("DROP INDEX IF EXISTS publish_requests_active_persona_mention");
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

  it("persona migrations preserve and constrain legacy Jeb rows idempotently", async () => {
    const personaDbName = `jeb_persona_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminConnection() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${personaDbName}`);
      created.push(personaDbName);
    } finally {
      await admin.end();
    }

    const migrationSource = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "infrastructure/database/migrations",
    );
    const legacyMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-migrations-pre-110-"));
    fixtureDirectories.push(legacyMigrations);
    for (const filename of fs.readdirSync(migrationSource)) {
      const id = Number(filename.match(/^(\d+)_/)?.[1] ?? Number.NaN);
      if (filename.endsWith(".sql") && Number.isFinite(id) && id < 110) {
        fs.copyFileSync(path.join(migrationSource, filename), path.join(legacyMigrations, filename));
      }
    }

    const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    const url = `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}/${personaDbName}`;
    const store = new Store(url);
    const stagingBotPk = "a".repeat(52);
    const historicalBotPk = "3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy";
    const previousBotPk = process.env.JEB_BOT_PK;
    process.env.JEB_BOT_PK = stagingBotPk;
    const tables = [
      "handled_mentions",
      "work_queue",
      "evidence",
      "publish_requests",
      "token_usage",
      "routing_audit",
      "web_queries",
      "scout_queries",
      "artifact_tags",
      "knowledge_answer_evidence",
    ] as const;
    try {
      await new DatabaseMigrator(store.pool, legacyMigrations).runMigrations();
      await store.pool.query(
        "INSERT INTO cursor_state (bot_id, nexus_url) VALUES ($1, 'https://nexus.staging.pubky.app')",
        [stagingBotPk],
      );
      await store.pool.query(
        "INSERT INTO handled_mentions (mention_key, status, bot_id) VALUES ('legacy-handled', 'published', $1)",
        [stagingBotPk],
      );
      await store.pool.query(
        "INSERT INTO handled_mentions (mention_key, status, bot_id) VALUES ('legacy-old-bot', 'published', $1)",
        [historicalBotPk],
      );
      await store.pool.query(
        "INSERT INTO work_queue (mention_key, author, kind, payload, status) VALUES ('legacy-work', 'author', 'mention', '{}'::jsonb, 'done')",
      );
      await store.pool.query(
        "INSERT INTO evidence (mention_key, intent) VALUES ('legacy-evidence', 'answer')",
      );
      await store.pool.query(
        "INSERT INTO publish_requests (mention_key, parent_uri, content, status) VALUES ('legacy-publish', 'pubky://parent', 'answer', 'published')",
      );
      await store.pool.query(
        "INSERT INTO token_usage (mention_key, public_key, phase, total_tokens) VALUES ('legacy-token', 'author', 'answer', 10)",
      );
      await store.pool.query(
        "INSERT INTO routing_audit (mention_key, intent) VALUES ('legacy-routing', 'answer')",
      );
      await store.pool.query(
        "INSERT INTO web_queries (provider, query_hash, ok, duration_ms, mention_key) VALUES ('kimi', 'hash', true, 1, 'legacy-web')",
      );
      await store.pool.query(
        "INSERT INTO scout_queries (tool, cypher_hash, params_hash, duration_ms, ok, mention_key) VALUES ('top_posts', 'cypher', 'params', 1, true, 'legacy-scout')",
      );
      await store.pool.query(
        "INSERT INTO artifact_tags (post_uri, label, approved_by, status) VALUES ('pubky://post', 'answer', 'operator', 'published')",
      );
      await store.pool.query(
        "INSERT INTO knowledge_answer_evidence (mention_key, score) VALUES ('legacy-knowledge', 1)",
      );
      const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs");
      const preflightSql = fs
        .readFileSync(path.join(docsDir, "persona-migration-preflight.sql"), "utf8")
        .replace(/^\\set ON_ERROR_STOP on\s*/m, "");
      await store.pool.query(`SET jeb.bot_pk = '${stagingBotPk}';\n${preflightSql}`);

      const before = new Map<string, number>();
      for (const table of tables) {
        const result = await store.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        before.set(table, result.rows[0]!.n);
      }

      const migrator = new DatabaseMigrator(store.pool);
      await migrator.runMigrations();
      for (const table of tables) {
        const result = await store.pool.query<{ n: number; incomplete: number }>(
          `SELECT count(*)::int AS n,
                  count(*) FILTER (
                    WHERE persona_id IS NULL
                       OR persona_version IS NULL
                       OR persona_manifest_hash IS NULL
                       OR target_bot_pk IS NULL
                  )::int AS incomplete
           FROM ${table}`,
        );
        expect(result.rows[0]).toEqual({ n: before.get(table), incomplete: 0 });
        const identity = await store.pool.query<{
          persona_id: string;
          persona_version: string;
          target_bot_pk: string;
        }>(
          `SELECT DISTINCT persona_id, persona_version, target_bot_pk FROM ${table}`,
        );
        expect(identity.rows).toEqual([
          { persona_id: "jeb", persona_version: "1.0.0", target_bot_pk: stagingBotPk },
        ]);
      }
      const verifySql = fs
        .readFileSync(path.join(docsDir, "persona-migration-verify.sql"), "utf8")
        .replace(/^\\set ON_ERROR_STOP on\s*/m, "");
      await expect(store.pool.query(verifySql)).resolves.toBeDefined();

      const orphans = await store.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM (
           SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM handled_mentions
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM work_queue
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM evidence
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM publish_requests
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM token_usage
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM routing_audit
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM web_queries
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM scout_queries
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM artifact_tags
           UNION ALL SELECT persona_id, persona_version, persona_manifest_hash, target_bot_pk FROM knowledge_answer_evidence
         ) r
         LEFT JOIN persona_versions pv
           ON pv.persona_id = r.persona_id
          AND pv.version = r.persona_version
          AND pv.manifest_hash = r.persona_manifest_hash
         LEFT JOIN personas p
           ON p.id = r.persona_id
          AND p.bot_pk = r.target_bot_pk
         WHERE pv.persona_id IS NULL OR p.id IS NULL`,
      );
      expect(orphans.rows[0]!.n).toBe(0);

      const defaulted = await store.pool.query<{
        persona_id: string;
        persona_version: string;
        target_bot_pk: string;
      }>(
        "INSERT INTO routing_audit (mention_key, intent) VALUES ('post-migration-default', 'answer') RETURNING persona_id, persona_version, target_bot_pk",
      );
      expect(defaulted.rows[0]).toEqual({
        persona_id: "jeb",
        persona_version: "1.1.0",
        target_bot_pk: stagingBotPk,
      });
      await expect(
        store.pool.query(
          "UPDATE routing_audit SET target_bot_pk = $1 WHERE mention_key = 'post-migration-default'",
          ["b".repeat(52)],
        ),
      ).rejects.toThrow();

      const constraints = await store.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM pg_constraint
         WHERE conname ~ '_persona_(version_fk|identity_fk|identity_present)$'
           AND convalidated`,
      );
      expect(constraints.rows[0]!.n).toBe(tables.length * 3);
      const indexes = await store.pool.query<{ name: string; valid: boolean }>(
        `SELECT c.relname AS name, i.indisvalid AS valid
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname IN (
           'handled_mentions_persona_mention',
           'work_queue_active_persona_mention',
           'publish_requests_active_persona_mention',
           'artifact_tags_active_persona_uri_label',
           'token_usage_persona_created',
           'web_queries_persona_created',
           'scout_queries_persona_created',
           'knowledge_answer_evidence_persona_created'
         )
         ORDER BY c.relname`,
      );
      expect(indexes.rows).toHaveLength(8);
      expect(indexes.rows.every((row) => row.valid)).toBe(true);

      const nextHash = "d".repeat(64);
      await store.pool.query(
        `INSERT INTO persona_versions (
           persona_id, version, manifest_hash, profile_json, capability_json,
           tag_json, corpus_namespace, status, reviewed_at
         )
         SELECT persona_id, '1.2.0', $1, profile_json, capability_json,
                tag_json, 'persona/jeb/1.2.0', 'active', now()
         FROM persona_versions
         WHERE persona_id = 'jeb' AND version = '1.0.0'`,
        [nextHash],
      );
      await store.pool.query(
        "UPDATE personas SET current_version = '1.2.0', manifest_hash = $1 WHERE id = 'jeb'",
        [nextHash],
      );
      const rolledDefault = await store.pool.query<{ persona_version: string; persona_manifest_hash: string }>(
        `INSERT INTO routing_audit (mention_key, intent)
         VALUES ('post-version-default', 'answer')
         RETURNING persona_version, persona_manifest_hash`,
      );
      expect(rolledDefault.rows[0]).toEqual({
        persona_version: "1.2.0",
        persona_manifest_hash: nextHash,
      });

      await store.pool.query("DELETE FROM public.migrations WHERE id BETWEEN 110 AND 115");
      await new DatabaseMigrator(store.pool).runMigrations();
      const applied = await store.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.migrations WHERE id BETWEEN 110 AND 115",
      );
      expect(applied.rows[0]!.n).toBe(6);
      for (const table of tables) {
        const result = await store.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        const extra = table === "routing_audit" ? 2 : 0;
        expect(result.rows[0]!.n).toBe(before.get(table)! + extra);
      }
    } finally {
      if (previousBotPk === undefined) delete process.env.JEB_BOT_PK;
      else process.env.JEB_BOT_PK = previousBotPk;
      await store.close();
    }
  }, 180_000);

  it("rejects an unreviewed key in Jeb identity history", async () => {
    const rogueDbName = `jeb_persona_rogue_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminConnection() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${rogueDbName}`);
      created.push(rogueDbName);
    } finally {
      await admin.end();
    }
    const migrationSource = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "infrastructure/database/migrations",
    );
    const legacyMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-migrations-rogue-pre-110-"));
    fixtureDirectories.push(legacyMigrations);
    for (const filename of fs.readdirSync(migrationSource)) {
      const id = Number(filename.match(/^(\d+)_/)?.[1] ?? Number.NaN);
      if (filename.endsWith(".sql") && Number.isFinite(id) && id < 110) {
        fs.copyFileSync(path.join(migrationSource, filename), path.join(legacyMigrations, filename));
      }
    }
    const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    const url = `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}/${rogueDbName}`;
    const store = new Store(url);
    const currentBot = "a".repeat(52);
    const previousBotPk = process.env.JEB_BOT_PK;
    process.env.JEB_BOT_PK = currentBot;
    try {
      await new DatabaseMigrator(store.pool, legacyMigrations).runMigrations();
      await store.pool.query(
        "INSERT INTO cursor_state (bot_id, nexus_url) VALUES ($1, 'https://nexus.example')",
        [currentBot],
      );
      await store.pool.query(
        "INSERT INTO handled_mentions (mention_key, status, bot_id) VALUES ('rogue-history', 'failed', $1)",
        ["c".repeat(52)],
      );
      await expect(new DatabaseMigrator(store.pool).runMigrations()).rejects.toThrow(
        /outside the reviewed Jeb allowlist/,
      );
      const personaTable = await store.pool.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.personas')::text AS table_name",
      );
      expect(personaTable.rows[0]?.table_name).toBeNull();
    } finally {
      if (previousBotPk === undefined) delete process.env.JEB_BOT_PK;
      else process.env.JEB_BOT_PK = previousBotPk;
      await store.close();
    }
  }, 60_000);

  it("expands one table per transaction and fails fast on a blocked table", async () => {
    const lockDbName = `jeb_persona_lock_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminConnection() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${lockDbName}`);
      created.push(lockDbName);
    } finally {
      await admin.end();
    }

    const migrationSource = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "infrastructure/database/migrations",
    );
    const legacyMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "jeb-migrations-lock-pre-110-"));
    fixtureDirectories.push(legacyMigrations);
    for (const filename of fs.readdirSync(migrationSource)) {
      const id = Number(filename.match(/^(\d+)_/)?.[1] ?? Number.NaN);
      if (filename.endsWith(".sql") && Number.isFinite(id) && id < 110) {
        fs.copyFileSync(path.join(migrationSource, filename), path.join(legacyMigrations, filename));
      }
    }

    const u = new URL(adminUrl.replace(/^postgres(ql)?:\/\//, "http://"));
    const url = `postgres://${u.username}${u.password ? `:${u.password}` : ""}@${u.host}/${lockDbName}`;
    const store = new Store(url);
    const blocker = new pg.Client({ connectionString: url });
    const previousBotPk = process.env.JEB_BOT_PK;
    process.env.JEB_BOT_PK = "a".repeat(52);
    try {
      await new DatabaseMigrator(store.pool, legacyMigrations).runMigrations();
      await store.pool.query(
        "INSERT INTO cursor_state (bot_id, nexus_url) VALUES ($1, 'https://nexus.staging.pubky.app')",
        ["a".repeat(52)],
      );
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE evidence IN ACCESS EXCLUSIVE MODE");

      const started = Date.now();
      await expect(new DatabaseMigrator(store.pool).runMigrations()).rejects.toMatchObject({
        code: "55P03",
      });
      expect(Date.now() - started).toBeLessThan(8_000);

      const expanded = await store.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('handled_mentions', 'work_queue', 'evidence')
           AND column_name = 'persona_id'
         ORDER BY table_name`,
      );
      expect(expanded.rows).toEqual([
        { table_name: "handled_mentions", column_name: "persona_id" },
        { table_name: "work_queue", column_name: "persona_id" },
      ]);
      const proofClient = await store.pool.connect();
      try {
        await proofClient.query("SET lock_timeout = '500ms'");
        await expect(
          proofClient.query(
          "INSERT INTO handled_mentions (mention_key, status, bot_id) VALUES ('lock-release-proof', 'processing', $1)",
          ["a".repeat(52)],
          ),
        ).resolves.toBeDefined();
      } finally {
        await proofClient.query("RESET lock_timeout").catch(() => undefined);
        proofClient.release();
      }

      await blocker.query("ROLLBACK");
      await new DatabaseMigrator(store.pool).runMigrations();
      const phases = await store.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM migrations WHERE id BETWEEN 110 AND 115",
      );
      expect(phases.rows[0]!.n).toBe(6);
    } finally {
      if (previousBotPk === undefined) delete process.env.JEB_BOT_PK;
      else process.env.JEB_BOT_PK = previousBotPk;
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await store.close();
    }
  }, 30_000);
});
