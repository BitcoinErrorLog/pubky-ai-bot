import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import { CodedResourceError } from "./resource-error-code.js";
import {
  PUBLISHER_LOCK_DOMAIN,
  RESOURCE_LEDGER_TABLES,
  ResourceLedger,
  RunSpendMeter,
  acquirePublisherLock,
  assertResourceSchemaReady,
  estimateRunUsd,
  meteredStepUsd,
  publisherLockKey,
  resourceSchemaReady,
} from "./resource-ledger.js";
import { PRODUCTION_RESOURCE_PROFILE, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";

const CAPS = { runUsdCap: 2, dailyUsdCap: 5 };

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

describe("resource ledger pure functions", () => {
  it("treats a cache hit as an explicit zero and missing metering as a failure", () => {
    expect(meteredStepUsd({ cached: true })).toBe(0);
    expect(meteredStepUsd({ cached: false, usd: 0.25 })).toBe(0.25);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, undefined as unknown as number]) {
      expect(() => meteredStepUsd({ cached: false, usd: bad })).toThrow("no finite usage cost");
    }
    expect(() => meteredStepUsd({ cached: false, usd: Number.NaN })).toThrow(CodedResourceError);
  });

  it("stops the run at the cap instead of publishing the resource that crosses it", () => {
    const meter = new RunSpendMeter(2);
    meter.record({ cached: false, usd: 1.2 });
    meter.record({ cached: true });
    expect(meter.spentUsd).toBeCloseTo(1.2, 6);
    expect(() => meter.record({ cached: false, usd: 0.9 })).toThrow("run USD cap would be exceeded");
    // The refused step is not counted, and the meter stays terminal for the run.
    expect(meter.spentUsd).toBeCloseTo(1.2, 6);
    expect(() => meter.record({ cached: false, usd: 0.9 })).toThrow(CodedResourceError);
  });

  it("refuses a non-positive run cap", () => {
    for (const bad of [0, -1, Number.NaN]) expect(() => new RunSpendMeter(bad)).toThrow("positive finite");
  });

  it("estimates with the greater of configured and observed cost, clamped to the run cap", () => {
    expect(estimateRunUsd({ perResourceEstimateUsd: 0.01, recentAverageUsd: 0, limit: 50, runUsdCap: 2 })).toBeCloseTo(0.5, 6);
    // An expensive recent history raises the reservation.
    expect(estimateRunUsd({ perResourceEstimateUsd: 0.01, recentAverageUsd: 0.02, limit: 50, runUsdCap: 2 })).toBeCloseTo(1, 6);
    // And no estimate may reserve more than one run is allowed to spend.
    expect(estimateRunUsd({ perResourceEstimateUsd: 1, recentAverageUsd: 0, limit: 100, runUsdCap: 2 })).toBe(2);
  });

  it("derives a domain-separated, publisher-specific lock key", () => {
    const staging = publisherLockKey(STAGING_RESOURCE_PROFILE.publisherPk);
    const production = publisherLockKey(PRODUCTION_RESOURCE_PROFILE.publisherPk);
    expect(staging).not.toBe(production);
    expect(publisherLockKey(STAGING_RESOURCE_PROFILE.publisherPk)).toBe(staging);
    expect(PUBLISHER_LOCK_DOMAIN).toBe("jeb-resource-publisher-lock-v1");
    expect(() => publisherLockKey("  ")).toThrow("requires a publisher");
    // Signed 64-bit range, so Postgres can accept it as a bigint.
    expect(staging).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(staging).toBeLessThan(2n ** 63n);
  });
});

describe("resource ledger against Postgres", () => {
  const url = process.env.DATABASE_URL ?? "";
  let store: Store;
  let ledger: ResourceLedger;

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    ledger = new ResourceLedger(store.pool);
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.pool.query("DELETE FROM resource_plan_consumptions");
    await store.pool.query("DELETE FROM resource_spend_day");
    await store.pool.query("DELETE FROM resource_runs");
  });

  it("migration 110 creates both tables with every column the runtime reads", async () => {
    const readiness = await resourceSchemaReady(store.pool);
    expect(readiness).toEqual({ ready: true, missing: [] });
    await expect(assertResourceSchemaReady(store.pool)).resolves.toBeUndefined();
  });

  // Deliberate negative: the runtime never runs DDL, so an unmigrated database
  // must stop it before Nexus, model, or key access.
  it("reports not ready when the migration stream is behind", async () => {
    const behind = { allMigrationsApplied: async () => false };
    const readiness = await resourceSchemaReady(store.pool, behind);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("migrations");
    await expect(assertResourceSchemaReady(store.pool, behind)).rejects.toThrow("resource schema is not ready");
    await expect(assertResourceSchemaReady(store.pool, behind)).rejects.toMatchObject({ code: "database_failed" });
  });

  // Owner rule: a new table must be classified. Neither table is owner-scoped
  // identity state, so no identity-clear wipe applies; if a wipe path is ever
  // added, this enumeration forces the decision again.
  it("classifies every public table, including the two this migration adds", async () => {
    const rows = await store.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tables = new Set(rows.rows.map((row) => row.table_name));
    for (const name of Object.keys(RESOURCE_LEDGER_TABLES)) expect(tables.has(name)).toBe(true);
    const operatorRetained = new Set(Object.keys(RESOURCE_LEDGER_TABLES));
    const identityScoped = [...tables].filter((name) => operatorRetained.has(name) && name.startsWith("identity_"));
    expect(identityScoped).toEqual([]);
  });

  it("reserves, settles, and reports the day's spend", async () => {
    const reservation = await ledger.reserve("staging", 1, CAPS);
    expect(reservation).toMatchObject({ target: "staging", reservedUsd: 1 });
    expect(reservation.utcDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0, reservedUsd: 1 });
    await ledger.settle(reservation, 0.4, 0.4);
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0.4, reservedUsd: 0.6 });
    await ledger.releaseReservation(reservation, 0.6);
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0.4, reservedUsd: 0 });
  });

  // Deliberate negative: the day cap counts reservations, not just settled spend.
  it("refuses a reservation that would cross the daily cap", async () => {
    await ledger.reserve("staging", 2, CAPS);
    await ledger.reserve("staging", 2, CAPS);
    await expect(ledger.reserve("staging", 2, CAPS)).rejects.toThrow("daily USD cap would be exceeded");
    await expect(ledger.reserve("staging", 2, CAPS)).rejects.toMatchObject({ code: "spend_cap_exceeded" });
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0, reservedUsd: 4 });
  });

  // Deliberate negative: the fresh-row path has no ON CONFLICT guard, so a
  // single oversized estimate must be refused before the insert.
  it("refuses a first reservation of the day that alone exceeds the cap", async () => {
    await expect(ledger.reserve("production", 6, CAPS)).rejects.toThrow("alone exceeds the daily USD cap");
    expect(await ledger.spentToday("production")).toEqual({ actualUsd: 0, reservedUsd: 0 });
  });

  it("keeps targets on separate day rows", async () => {
    await ledger.reserve("staging", 4, CAPS);
    await ledger.reserve("production", 4, CAPS);
    expect((await ledger.spentToday("staging")).reservedUsd).toBe(4);
    expect((await ledger.spentToday("production")).reservedUsd).toBe(4);
  });

  it("refuses to settle unmeasurable spend", async () => {
    const reservation = await ledger.reserve("staging", 1, CAPS);
    await expect(ledger.settle(reservation, Number.NaN, 0)).rejects.toMatchObject({ code: "metering_missing" });
  });

  it("writes one manifest row per run and closes it with bounded counts", async () => {
    const run = runRow({ planSha256: "b".repeat(64) });
    await ledger.startRun(run);
    const running = await store.pool.query<{ status: string; finished_at: Date | null }>(
      "SELECT status, finished_at FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(running.rows[0]?.status).toBe("running");
    expect(running.rows[0]?.finished_at).toBeNull();
    await ledger.finishRun(run.runId, {
      status: "failed",
      actualUsd: 0.25,
      accepted: 10,
      processed: 4,
      unprocessed: 6,
      written: 3,
      skipped: 1,
      failed: 1,
      puts: 3,
      deletes: 0,
      verified: false,
      failureCode: "spend_cap_exceeded",
    });
    const done = await store.pool.query<{ status: string; failure_code: string; unprocessed_count: number; plan_sha256: string }>(
      "SELECT status, failure_code, unprocessed_count, plan_sha256 FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(done.rows[0]).toMatchObject({
      status: "failed",
      failure_code: "spend_cap_exceeded",
      unprocessed_count: 6,
      plan_sha256: "b".repeat(64),
    });
  });

  // Deliberate negative: the manifest schema has no free-text column that an
  // SDK error, header, or authorization URL could be poured into.
  it("rejects a status outside the bounded set", async () => {
    const run = runRow();
    await ledger.startRun(run);
    await expect(
      store.pool.query("UPDATE resource_runs SET status = 'partially-ok' WHERE run_id = $1", [run.runId]),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("averages only recent succeeded runs of the same family", async () => {
    for (const [family, actual, processed] of [
      ["canon", 1, 10],
      ["places", 2, 10],
    ] as const) {
      const run = runRow({ family });
      await ledger.startRun(run);
      await ledger.finishRun(run.runId, {
        status: "succeeded",
        actualUsd: actual,
        accepted: processed,
        processed,
        unprocessed: 0,
        written: processed,
        skipped: 0,
        failed: 0,
        puts: processed,
        deletes: 0,
        verified: true,
      });
    }
    expect(await ledger.recentAverageUsd("staging", "canon")).toBeCloseTo(0.1, 6);
    expect(await ledger.recentAverageUsd("staging", "places")).toBeCloseTo(0.2, 6);
    expect(await ledger.recentAverageUsd("staging", "discover")).toBe(0);
    expect(await ledger.recentAverageUsd("production", "canon")).toBe(0);
  });

  it("ignores a failed run when estimating, so a crash cannot deflate the reservation", async () => {
    const failed = runRow();
    await ledger.startRun(failed);
    await ledger.finishRun(failed.runId, {
      status: "failed",
      actualUsd: 0,
      accepted: 10,
      processed: 10,
      unprocessed: 0,
      written: 0,
      skipped: 0,
      failed: 10,
      puts: 0,
      deletes: 0,
      verified: false,
      failureCode: "model_failed",
    });
    expect(await ledger.recentAverageUsd("staging", "canon")).toBe(0);
  });

  it("serializes two publishers on the same key and records the loser", async () => {
    const first = await acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk);
    try {
      await expect(acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk)).rejects.toMatchObject({
        code: "overlap_refused",
      });
      // A different publisher is a different key and must not be blocked.
      const other = await acquirePublisherLock(store.pool, PRODUCTION_RESOURCE_PROFILE.publisherPk);
      await other.release();
    } finally {
      await first.release();
    }
    const again = await acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk);
    await again.release();
  });

  it("does not leak the pool connection when the lock is refused", async () => {
    const held = await acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk);
    const before = store.pool.idleCount + store.pool.totalCount;
    for (let i = 0; i < 3; i += 1) {
      await expect(acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk)).rejects.toThrow();
    }
    expect(store.pool.totalCount).toBeLessThanOrEqual(before + 1);
    await held.release();
  });

  it("records overlap_refused terminally, with no spend", async () => {
    const run = runRow({ estimatedUsd: 1.5 });
    await ledger.recordOverlapRefused(run);
    const row = await store.pool.query<{ status: string; estimated_usd: string; actual_usd: string; failure_code: string }>(
      "SELECT status, estimated_usd::text, actual_usd::text, failure_code FROM resource_runs WHERE run_id = $1",
      [run.runId],
    );
    expect(row.rows[0]).toMatchObject({ status: "overlap_refused", failure_code: "overlap_refused" });
    expect(Number(row.rows[0]?.estimated_usd)).toBe(0);
    expect(Number(row.rows[0]?.actual_usd)).toBe(0);
    expect(await ledger.spentToday("staging")).toEqual({ actualUsd: 0, reservedUsd: 0 });
  });

  it("keeps reservations correct without the publisher lock", async () => {
    const results = await Promise.allSettled([
      ledger.reserve("staging", 2, CAPS),
      ledger.reserve("staging", 2, CAPS),
      ledger.reserve("staging", 2, CAPS),
    ]);
    const granted = results.filter((r) => r.status === "fulfilled").length;
    expect(granted).toBe(2);
    expect((await ledger.spentToday("staging")).reservedUsd).toBe(4);
  });

  it("never holds a transaction open across the reserve call", async () => {
    await ledger.reserve("staging", 1, CAPS);
    const idle = await store.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    expect(idle.rows[0]?.n).toBe(0);
  });
});
