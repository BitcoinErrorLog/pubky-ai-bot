import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Keypair } from "@synonymdev/pubky";
import { memoryTokenBudget, memoryTokenBucket, postgresTokenBudget } from "./budget.js";
import { ownerBudgetKey } from "./env.js";
import { TEST_OWNER, testTenant } from "./test-helpers.js";

const BOT_A = Keypair.fromSecret(new Uint8Array(32).fill(0xaa)).publicKey.z32();
const BOT_B = Keypair.fromSecret(new Uint8Array(32).fill(0xbb)).publicKey.z32();

describe("owner-keyed budgets", () => {
  it("two bindings under the same owner share one bucket and one daily ceiling", async () => {
    const t1 = testTenant({ bot: BOT_A, owner: TEST_OWNER });
    const t2 = testTenant({ bot: BOT_B, owner: TEST_OWNER });
    expect(ownerBudgetKey(t1.owner)).toBe(`pubchi:${TEST_OWNER}`);
    expect(ownerBudgetKey(t1.owner)).toBe(ownerBudgetKey(t2.owner));

    const bucket = memoryTokenBucket({ ratePerSec: 0.0001, burst: 1 });
    expect(bucket.take(t1)).toBe(true);
    expect(bucket.take(t2)).toBe(false);

    const budget = memoryTokenBudget({ dailyCeiling: 10, perRequestCap: 10 });
    const first = await budget.reserve(t1, 10);
    expect(first.ok).toBe(true);
    const second = await budget.reserve(t2, 1);
    expect(second).toEqual({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  it("concurrent reserve does not overshoot the ceiling", async () => {
    const tenant = testTenant();
    const budget = memoryTokenBudget({ dailyCeiling: 10, perRequestCap: 10 });
    const results = await Promise.all([budget.reserve(tenant, 8), budget.reserve(tenant, 8)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(budget.spent.get(ownerBudgetKey(tenant.owner))).toBe(8);
  });

  it("refund restores budget so a later reserve can succeed", async () => {
    const tenant = testTenant();
    const budget = memoryTokenBudget({ dailyCeiling: 10, perRequestCap: 10 });
    const reserved = await budget.reserve(tenant, 10);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await budget.refund(reserved.reservation);
    const again = await budget.reserve(tenant, 10);
    expect(again.ok).toBe(true);
  });
});

const pgUrl = process.env.DATABASE_URL?.trim() || "postgres://johncarvalho@127.0.0.1:5432/jeb_pubchi_w3";

describe("postgres token budget", () => {
  const pool = new pg.Pool({ connectionString: pgUrl });
  afterAll(async () => {
    await pool.end();
  });

  it("UTC-day window ignores session TimeZone", async () => {
    const client = await pool.connect();
    const key = `pubchi:k1-utc-${Date.now()}`;
    const tenant = testTenant({ owner: key.slice("pubchi:".length) });
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pubchi_budget_day (
          mention_key TEXT NOT NULL,
          utc_day DATE NOT NULL,
          reserved BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (mention_key, utc_day)
        )
      `);
      await client.query("DELETE FROM pubchi_budget_day WHERE mention_key = $1", [key]);
      await client.query("SET TIME ZONE 'Asia/Tokyo'");
      const days = await client.query<{ tokyo: string; utc: string }>(
        `SELECT CURRENT_DATE::text AS tokyo, (now() AT TIME ZONE 'UTC')::date::text AS utc`,
      );
      expect(days.rows[0]?.tokyo).toBeTruthy();
      expect(days.rows[0]?.utc).toBeTruthy();
      if (days.rows[0] && days.rows[0].tokyo !== days.rows[0].utc) {
        await client.query(
          `INSERT INTO pubchi_budget_day (mention_key, utc_day, reserved) VALUES ($1, CURRENT_DATE, 999999)`,
          [key],
        );
      }
      const budget = postgresTokenBudget(client, { dailyCeiling: 10, perRequestCap: 5 });
      const checkBefore = await budget.check(tenant);
      expect(checkBefore.ok).toBe(true);
      const reserved = await budget.reserve(tenant, 3);
      expect(reserved.ok).toBe(true);
      const stored = await client.query<{ utc_day: string }>(
        `SELECT utc_day::text FROM pubchi_budget_day
         WHERE mention_key = $1 AND utc_day = (now() AT TIME ZONE 'UTC')::date`,
        [key],
      );
      expect(stored.rows[0]?.utc_day).toBe(days.rows[0]?.utc);
      const checkAfter = await budget.check(tenant);
      expect(checkAfter.ok).toBe(true);
    } finally {
      await client.query("DELETE FROM pubchi_budget_day WHERE mention_key = $1", [key]);
      await client.query("SET TIME ZONE DEFAULT");
      client.release();
    }
  });

  it("atomic reserve rejects a concurrent overshoot", async () => {
    const client = await pool.connect();
    const owner = `k1owner${Date.now().toString(16).padEnd(52, "a").slice(0, 52)}`;
    const tenant = testTenant({ owner });
    const key = ownerBudgetKey(owner);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pubchi_budget_day (
          mention_key TEXT NOT NULL,
          utc_day DATE NOT NULL,
          reserved BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (mention_key, utc_day)
        )
      `);
      await client.query("DELETE FROM pubchi_budget_day WHERE mention_key = $1", [key]);
      const budget = postgresTokenBudget(pool, { dailyCeiling: 10, perRequestCap: 10 });
      const results = await Promise.all([budget.reserve(tenant, 8), budget.reserve(tenant, 8)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      const row = await client.query<{ reserved: string }>(
        `SELECT reserved::text FROM pubchi_budget_day WHERE mention_key = $1`,
        [key],
      );
      expect(row.rows[0]?.reserved).toBe("8");
    } finally {
      await client.query("DELETE FROM pubchi_budget_day WHERE mention_key = $1", [key]);
      client.release();
    }
  });
});
