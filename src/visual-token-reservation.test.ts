import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import {
  cleanStaleVisualReservations,
  refundVisualTokens,
  reserveVisualTokens,
  settleVisualTokens,
} from "./visual-token-reservation.js";
import { createVisualReservationReaper } from "./reason.js";

const PREFIX = "visual-reservation-test:";
const USER = "visual-user";
let store: Store;
let baselineGlobal = 0;

beforeAll(async () => {
  store = new Store(process.env.DATABASE_URL!);
  await store.migrate();
  await store.pool.query("DELETE FROM token_usage WHERE mention_key LIKE $1", [`${PREFIX}%`]);
});

afterAll(async () => {
  await store.pool.query("DELETE FROM token_usage WHERE mention_key LIKE $1", [`${PREFIX}%`]);
  await store.close();
});

afterEach(async () => {
  await store.pool.query("DELETE FROM token_usage WHERE mention_key LIKE $1", [`${PREFIX}%`]);
});

beforeEach(async () => {
  await store.pool.query("DELETE FROM token_usage WHERE mention_key LIKE $1", [`${PREFIX}%`]);
  const result = await store.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(total_tokens), 0)::text AS total FROM token_usage
     WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
  );
  baselineGlobal = Number(result.rows[0]!.total);
});

function reserve(
  mentionKey: string,
  targetTokens: number,
  overrides: Partial<Parameters<typeof reserveVisualTokens>[1]> = {},
) {
  return reserveVisualTokens(store.pool, {
    mentionKey,
    publicKey: USER,
    targetTokens,
    globalCeiling: baselineGlobal + 1_000,
    userCeiling: 1_000,
    staleAfterMs: 300_000,
    ...overrides,
  });
}

describe("Postgres visual-token reservations", () => {
  it("refuses both global and per-user ceiling overflow", async () => {
    await store.pool.query(
      `INSERT INTO token_usage (mention_key, public_key, phase, total_tokens)
       VALUES ($1, 'other-user', 'answer', 95), ($2, $3, 'answer', 95)`,
      [`${PREFIX}global-spend`, `${PREFIX}user-spend`, `${USER}-limited`],
    );
    expect(await reserve(`${PREFIX}global-refused`, 10, {
      publicKey: "fresh-user", globalCeiling: baselineGlobal + 100, userCeiling: 1_000,
    })).toBeNull();
    expect(await reserve(`${PREFIX}user-refused`, 10, {
      publicKey: `${USER}-limited`, globalCeiling: baselineGlobal + 1_000, userCeiling: 100,
    })).toBeNull();
  });

  it("serializes concurrent processes so they cannot race past a ceiling", async () => {
    const user = `${USER}-race`;
    const [a, b] = await Promise.all([
      reserve(`${PREFIX}race-a`, 60, { publicKey: user, globalCeiling: baselineGlobal + 100, userCeiling: 100 }),
      reserve(`${PREFIX}race-b`, 60, { publicKey: user, globalCeiling: baselineGlobal + 100, userCeiling: 100 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const total = await store.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::text AS total
         FROM token_usage WHERE mention_key IN ($1, $2)`,
      [`${PREFIX}race-a`, `${PREFIX}race-b`],
    );
    expect(Number(total.rows[0]!.total)).toBe(60);
  });

  it("serializes distinct users against the global ceiling", async () => {
    const [a, b] = await Promise.all([
      reserve(`${PREFIX}global-race-a`, 60, {
        publicKey: `${USER}-global-a`, globalCeiling: baselineGlobal + 100, userCeiling: 1_000,
      }),
      reserve(`${PREFIX}global-race-b`, 60, {
        publicKey: `${USER}-global-b`, globalCeiling: baselineGlobal + 100, userCeiling: 1_000,
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("serializes one user's concurrent calls against the user ceiling", async () => {
    const user = `${USER}-user-race`;
    const [a, b] = await Promise.all([
      reserve(`${PREFIX}user-race-a`, 60, {
        publicKey: user, globalCeiling: baselineGlobal + 1_000, userCeiling: 100,
      }),
      reserve(`${PREFIX}user-race-b`, 60, {
        publicKey: user, globalCeiling: baselineGlobal + 1_000, userCeiling: 100,
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("resizes while accounting for its existing row", async () => {
    const first = await reserve(`${PREFIX}resize`, 40, { globalCeiling: baselineGlobal + 200, userCeiling: 200 });
    expect(first?.estimatedTokens).toBe(40);
    const resized = await reserve(`${PREFIX}resize`, 80, {
      globalCeiling: baselineGlobal + 200, userCeiling: 200, reservation: first!,
    });
    expect(resized?.estimatedTokens).toBe(80);
    const total = await store.pool.query<{ total_tokens: number }>(
      "SELECT total_tokens FROM token_usage WHERE id = $1",
      [resized!.id],
    );
    expect(total.rows[0]!.total_tokens).toBe(80);
  });

  it("refunds and settles the exact reservation idempotently", async () => {
    const refunded = await reserve(`${PREFIX}refund`, 30);
    expect(await refundVisualTokens(store.pool, refunded!)).toBe(true);
    expect(await refundVisualTokens(store.pool, refunded!)).toBe(false);

    const settled = await reserve(`${PREFIX}settle`, 70);
    expect(await settleVisualTokens(store.pool, settled!, {
      phase: "answer", model: "fake", totalTokens: 20,
    })).toBe(20);
    expect(await settleVisualTokens(store.pool, settled!, {
      phase: "answer", model: "fake", totalTokens: 100,
    })).toBeNull();
    const row = await store.pool.query<{ phase: string; total_tokens: number; reserved: string }>(
      `SELECT phase, total_tokens, meta_json->>'reserved_hard_upper_bound' AS reserved
         FROM token_usage WHERE id = $1`,
      [settled!.id],
    );
    expect(row.rows[0]).toMatchObject({ phase: "answer", total_tokens: 20, reserved: "70" });

    const actualHigher = await reserve(`${PREFIX}settle-higher`, 20);
    await expect(settleVisualTokens(store.pool, actualHigher!, {
      phase: "answer", model: "fake", totalTokens: 90,
    })).rejects.toThrow("provider usage exceeded reserved hard upper bound");
    const invariant = await store.pool.query<{ phase: string; total_tokens: number; actual: string }>(
      `SELECT phase, total_tokens, meta_json->>'reported_total_tokens' AS actual
         FROM token_usage WHERE id = $1`,
      [actualHigher!.id],
    );
    expect(invariant.rows[0]).toMatchObject({
      phase: "image_usage_invariant", total_tokens: 20, actual: "90",
    });
  });

  it("charges the conservative reserve when provider usage is missing", async () => {
    const reservation = await reserve(`${PREFIX}missing-usage`, 55);
    expect(await settleVisualTokens(store.pool, reservation!, {
      phase: "answer", model: "fake", totalTokens: null,
    })).toBe(55);
  });

  it("cleans only crashed reservations older than the deadline bound", async () => {
    const stale = await reserve(`${PREFIX}stale`, 25);
    const fresh = await reserve(`${PREFIX}fresh`, 25);
    await store.pool.query(
      "UPDATE token_usage SET created_at = now() - interval '10 minutes' WHERE id = $1",
      [stale!.id],
    );
    expect(await cleanStaleVisualReservations(store.pool, 300_000)).toBe(1);
    const rows = await store.pool.query<{ id: string }>(
      "SELECT id::text FROM token_usage WHERE id IN ($1, $2) ORDER BY id",
      [stale!.id, fresh!.id],
    );
    expect(rows.rows.map((row) => row.id)).toEqual([fresh!.id]);
  });

  it("production reason reaper cleans stale reservations without another reserve", async () => {
    const stale = await reserve(`${PREFIX}production-reaper`, 25);
    await store.pool.query(
      "UPDATE token_usage SET created_at = now() - interval '10 minutes' WHERE id = $1",
      [stale!.id],
    );
    const reaper = createVisualReservationReaper(store, 300_000, 1);
    await reaper.tick();
    reaper.stop();
    const row = await store.pool.query("SELECT 1 FROM token_usage WHERE id = $1", [stale!.id]);
    expect(row.rowCount).toBe(0);
  });

  it("uses the UTC day even when the database session timezone is non-UTC", async () => {
    const user = `${USER}-timezone`;
    await store.pool.query("SET TIME ZONE 'America/Los_Angeles'");
    try {
      await store.pool.query(
        `INSERT INTO token_usage (mention_key, public_key, phase, total_tokens, created_at)
         VALUES ($1, $2, 'answer', 31,
           (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 minute')`,
        [`${PREFIX}utc-early`, user],
      );
      expect(await store.userDailyTokens(user)).toBe(31);
      expect(await reserve(`${PREFIX}utc-reserve`, 20, {
        publicKey: user, globalCeiling: baselineGlobal + 100, userCeiling: 50,
      })).toBeNull();
    } finally {
      await store.pool.query("SET TIME ZONE 'UTC'");
    }
  });

  it("keeps a crossing-midnight answer on its reservation UTC day", async () => {
    const user = `${USER}-midnight`;
    const first = await reserve(`${PREFIX}midnight`, 20, {
      publicKey: user, globalCeiling: baselineGlobal + 1_000, userCeiling: 1_000,
    });
    await store.pool.query(
      `UPDATE token_usage SET created_at =
        (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 minute'
       WHERE id = $1`,
      [first!.id],
    );
    await store.pool.query(
      `INSERT INTO token_usage (mention_key, public_key, phase, total_tokens, created_at)
       VALUES ($1, $2, 'answer', 15,
        (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '2 minutes')`,
      [`${PREFIX}midnight-spend`, user],
    );
    expect(await reserve(`${PREFIX}midnight`, 40, {
      publicKey: user, globalCeiling: 1_000_000_000, userCeiling: 50,
      staleAfterMs: 86_400_000, reservation: first!,
    })).toBeNull();
    const resized = await reserve(`${PREFIX}midnight`, 40, {
      publicKey: user, globalCeiling: 1_000_000_000, userCeiling: 60,
      staleAfterMs: 86_400_000, reservation: first!,
    });
    expect(resized?.estimatedTokens).toBe(40);
    const day = await store.pool.query<{ previous: boolean }>(
      `SELECT created_at < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS previous
         FROM token_usage WHERE id = $1`,
      [first!.id],
    );
    expect(day.rows[0]!.previous).toBe(true);
  });
});
