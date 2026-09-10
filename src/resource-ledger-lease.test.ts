import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import {
  REAP_STALE_RUNS_SQL,
  RUN_LEASE_RENEW_SQL,
  RUN_METER_SQL,
  RUN_START_SQL,
  ResourceLedger,
  resourceSchemaReady,
} from "./resource-ledger.js";
import { STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";
import {
  adminDatabaseUrl,
  databaseName,
  rewriteDatabaseName,
} from "../tests/helpers/suite-database.js";

function runRow(overrides: Partial<Parameters<ResourceLedger["startRun"]>[0]> = {}) {
  return {
    runId: randomUUID(),
    target: "staging" as const,
    family: "canon" as const,
    configVersion: STAGING_RESOURCE_PROFILE.signedConfigVersion,
    pinSetVersion: STAGING_RESOURCE_PROFILE.pinSetVersion,
    distHash: "a".repeat(64),
    publisherPk: STAGING_RESOURCE_PROFILE.publisherPk,
    estimatedUsd: 0.5,
    ...overrides,
  };
}

describe("resource run leases and the crash reaper", () => {
  let store: Store;
  let ledger: ResourceLedger;

  beforeAll(async () => {
    store = new Store(process.env.DATABASE_URL ?? "");
    await store.migrate();
    ledger = new ResourceLedger(store.pool);
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.pool.query("DELETE FROM resource_plan_consumptions");
    await store.pool.query("DELETE FROM resource_runs");
    await store.pool.query("DELETE FROM resource_spend_day");
  });

  it("opens every run with a bounded lease and renews it on heartbeat", async () => {
    const run = runRow({ leaseMs: 60_000 });
    await ledger.startRun(run);
    const first = await store.pool.query<{ lease_expires_at: Date }>(
      "SELECT lease_expires_at FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(first.rows[0]?.lease_expires_at).toBeInstanceOf(Date);
    await store.pool.query("UPDATE resource_runs SET lease_expires_at = now() WHERE run_id = $1", [run.runId]);
    await ledger.renewLease(run.runId, 60_000);
    const renewed = await store.pool.query<{ remaining_ms: number }>(
      "SELECT EXTRACT(EPOCH FROM lease_expires_at - now()) * 1000 AS remaining_ms FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(Number(renewed.rows[0]?.remaining_ms)).toBeGreaterThan(30_000);
  });

  it("refuses a non-positive lease instead of writing an unbounded row", async () => {
    await expect(ledger.startRun(runRow({ leaseMs: 0 }))).rejects.toThrow(/positive finite/);
  });

  // A crashed run's row is closed as abandoned; it is never silently reused,
  // and its reservation stays conservative for the operator to reconcile.
  it("reaps an expired running row as abandoned and refuses its later settlement", async () => {
    const reservation = await ledger.reserve("staging", 1, { runUsdCap: 2, dailyUsdCap: 5 });
    const run = runRow({ leaseMs: 60_000 });
    await ledger.startRun(run);
    await store.pool.query(
      "UPDATE resource_runs SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1",
      [run.runId],
    );
    expect(await ledger.reapStaleRuns("staging")).toBe(1);
    const row = await store.pool.query<{ status: string; finished_at: Date | null }>(
      "SELECT status, finished_at FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(row.rows[0]?.status).toBe("abandoned");
    expect(row.rows[0]?.finished_at).toBeInstanceOf(Date);
    // Not reusable: neither a late finish nor a heartbeat finds the row.
    await expect(
      ledger.finishRun(run.runId, {
        status: "succeeded", actualUsd: 0, accepted: 0, processed: 0, unprocessed: 0,
        written: 0, skipped: 0, failed: 0, puts: 0, deletes: 0, verified: false,
      }),
    ).rejects.toThrow(/not found/);
    await expect(ledger.renewLease(run.runId)).rejects.toThrow(/not found/);
    // The reservation is NOT released: a crashed run never frees budget
    // without terminal-manifest proof.
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0, reservedUsd: 1 });
    await ledger.settle(reservation, 0, 1);
  });

  it("leaves live runs and other targets alone", async () => {
    const live = runRow({ leaseMs: 60_000 });
    await ledger.startRun(live);
    const otherTarget = runRow({ target: "production", leaseMs: 60_000 });
    await ledger.startRun(otherTarget);
    await store.pool.query(
      "UPDATE resource_runs SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1",
      [otherTarget.runId],
    );
    expect(await ledger.reapStaleRuns("staging")).toBe(0);
    const statuses = await store.pool.query<{ run_id: string; status: string }>("SELECT run_id, status FROM resource_runs");
    expect(statuses.rows.find((r) => r.run_id === live.runId)?.status).toBe("running");
    expect(statuses.rows.find((r) => r.run_id === otherTarget.runId)?.status).toBe("running");
    expect(await ledger.reapStaleRuns("production")).toBe(1);
  });

  // The lease arithmetic must come from the database clock everywhere: an
  // app-clock timestamp would let a skewed process fight the reaper.
  it("drives every lease timestamp from the database clock", () => {
    for (const sql of [RUN_START_SQL, RUN_LEASE_RENEW_SQL, RUN_METER_SQL, REAP_STALE_RUNS_SQL]) {
      expect(sql).toMatch(/now\(\)/);
      expect(sql).not.toMatch(/\$\d+.*lease_expires_at/);
    }
    expect(RUN_START_SQL).toMatch(/started_at[\s\S]*date_trunc\('milliseconds', now\(\)\)/);
    expect(RUN_LEASE_RENEW_SQL).toMatch(/lease_expires_at = now\(\)/);
    expect(RUN_METER_SQL).toMatch(/lease_expires_at = now\(\)/);
    expect(REAP_STALE_RUNS_SQL).toMatch(/finished_at = now\(\)/);
    expect(REAP_STALE_RUNS_SQL).toMatch(/lease_expires_at < now\(\)/);
  });

  it("reads first-production-write state from successful rows with writes only", async () => {
    expect(await ledger.hasSuccessfulWriteRun("production")).toBe(false);
    const planned = runRow({ target: "production" });
    await ledger.startRun(planned);
    // A successful plan with zero writes is still a first-write state.
    await ledger.finishRun(planned.runId, {
      status: "succeeded", actualUsd: 0, accepted: 1, processed: 1, unprocessed: 0,
      written: 0, skipped: 0, failed: 0, puts: 0, deletes: 0, verified: false,
    });
    expect(await ledger.hasSuccessfulWriteRun("production")).toBe(false);
    const written = runRow({ target: "production" });
    await ledger.startRun(written);
    await ledger.finishRun(written.runId, {
      status: "succeeded", actualUsd: 0, accepted: 1, processed: 1, unprocessed: 0,
      written: 1, skipped: 0, failed: 0, puts: 1, deletes: 0, verified: true,
    });
    expect(await ledger.hasSuccessfulWriteRun("production")).toBe(true);
  });
});

describe("migrations 111 and 112", () => {
  it("is applied on the current suite database with the lease column and consumption table ready", async () => {
    const store = new Store(process.env.DATABASE_URL ?? "");
    try {
      const applied = await new DatabaseMigrator(store.pool).getAppliedMigrations();
      expect(applied).toContain(110);
      expect(applied).toContain(111);
      expect(applied).toContain(112);
      const readiness = await resourceSchemaReady(store.pool);
      expect(readiness).toEqual({ ready: true, missing: [] });
      // Re-applying the migrations is harmless (idempotent DDL).
      for (const file of ["111_resource_run_leases.sql", "112_resource_plan_consumptions.sql"]) {
        const path = new URL(`./infrastructure/database/migrations/${file}`, import.meta.url);
        await store.pool.query(await readFile(path, "utf8"));
      }
      expect((await resourceSchemaReady(store.pool)).ready).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("migrates a database that is at 111 forward to 112", { timeout: 180_000 }, async () => {
    const suiteUrl = process.env.DATABASE_URL ?? "";
    const name = `jeb_vitest_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const freshUrl = rewriteDatabaseName(suiteUrl, name);
    const admin = new pg.Client({ connectionString: adminDatabaseUrl(suiteUrl) });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const pool = new pg.Pool({ connectionString: freshUrl });
    try {
      const migrator = new DatabaseMigrator(pool);
      // Bring the database to exactly 111 by replaying the stream up to it.
      const all = await migrator.loadMigrations();
      await migrator.createMigrationsTable();
      for (const migration of all.filter((m) => m.id <= 111)) {
        await pool.query(migration.sql);
        await pool.query("INSERT INTO public.migrations (id, filename) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
          migration.id,
          migration.filename,
        ]);
      }
      const before = await pool.query(
        `SELECT to_regclass('public.resource_plan_consumptions')::text AS table_name`,
      );
      expect(before.rows[0]?.table_name).toBeNull();
      // The normal migrator carries it forward; the runtime never does DDL.
      await migrator.runMigrations();
      expect(await migrator.allMigrationsApplied()).toBe(true);
      expect((await resourceSchemaReady(pool)).ready).toBe(true);
      // The unique plan hash is what makes a confirmed plan single-use.
      const constraint = await pool.query(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = 'resource_plan_consumptions' AND constraint_type = 'PRIMARY KEY'`,
      );
      expect(constraint.rowCount).toBe(1);
    } finally {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminDatabaseUrl(suiteUrl) });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await cleanup.end();
      }
    }
    expect(databaseName(freshUrl)).toBe(name);
  });

  it("migrates a fresh database through the whole stream", { timeout: 180_000 }, async () => {
    const suiteUrl = process.env.DATABASE_URL ?? "";
    const name = `jeb_vitest_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const freshUrl = rewriteDatabaseName(suiteUrl, name);
    const admin = new pg.Client({ connectionString: adminDatabaseUrl(suiteUrl) });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const pool = new pg.Pool({ connectionString: freshUrl });
    try {
      const migrator = new DatabaseMigrator(pool);
      await migrator.runMigrations();
      expect(await migrator.allMigrationsApplied()).toBe(true);
      expect(await migrator.getAppliedMigrations()).toContain(112);
      const readiness = await resourceSchemaReady(pool);
      expect(readiness).toEqual({ ready: true, missing: [] });
      // The lease column and the abandoned status exist from scratch.
      const lease = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'resource_runs' AND column_name = 'lease_expires_at'`,
      );
      expect(lease.rowCount).toBe(1);
      const run = {
        runId: randomUUID(), target: "staging", family: "canon",
        configVersion: "v", pinSetVersion: "p", distHash: "d", publisherPk: "k", estimatedUsd: 0,
      };
      await new ResourceLedger(pool).startRun(run);
      await pool.query("UPDATE resource_runs SET status = 'abandoned' WHERE run_id = $1", [run.runId]);
    } finally {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminDatabaseUrl(suiteUrl) });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await cleanup.end();
      }
    }
    expect(databaseName(freshUrl)).toBe(name);
  });
});
