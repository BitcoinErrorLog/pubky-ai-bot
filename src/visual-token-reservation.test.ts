import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import {
  cleanStaleVisualReservations,
  refundVisualTokens,
  reserveVisualTokens,
  settleVisualTokens,
} from "./visual-token-reservation.js";

const PREFIX = "visual-reservation-test:";
const USER = "visual-user";
let store: Store;

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

function reserve(
  mentionKey: string,
  targetTokens: number,
  overrides: Partial<Parameters<typeof reserveVisualTokens>[1]> = {},
) {
  return reserveVisualTokens(store.pool, {
    mentionKey,
    publicKey: USER,
    targetTokens,
    globalCeiling: 1_000,
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
      publicKey: "fresh-user", globalCeiling: 100, userCeiling: 1_000,
    })).toBeNull();
    expect(await reserve(`${PREFIX}user-refused`, 10, {
      publicKey: `${USER}-limited`, globalCeiling: 1_000, userCeiling: 100,
    })).toBeNull();
  });

  it("serializes concurrent processes so they cannot race past a ceiling", async () => {
    const user = `${USER}-race`;
    const [a, b] = await Promise.all([
      reserve(`${PREFIX}race-a`, 60, { publicKey: user, globalCeiling: 100, userCeiling: 100 }),
      reserve(`${PREFIX}race-b`, 60, { publicKey: user, globalCeiling: 100, userCeiling: 100 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const total = await store.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::text AS total
         FROM token_usage WHERE mention_key IN ($1, $2)`,
      [`${PREFIX}race-a`, `${PREFIX}race-b`],
    );
    expect(Number(total.rows[0]!.total)).toBe(60);
  });

  it("resizes while accounting for its existing row", async () => {
    const first = await reserve(`${PREFIX}resize`, 40, { globalCeiling: 200, userCeiling: 200 });
    expect(first?.estimatedTokens).toBe(40);
    const resized = await reserve(`${PREFIX}resize`, 80, {
      globalCeiling: 200, userCeiling: 200, reservation: first!,
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
    })).toBe(70);
    expect(await settleVisualTokens(store.pool, settled!, {
      phase: "answer", model: "fake", totalTokens: 100,
    })).toBeNull();
    const row = await store.pool.query<{ phase: string; total_tokens: number; reserved: string }>(
      `SELECT phase, total_tokens, meta_json->>'reserved_visual_tokens' AS reserved
         FROM token_usage WHERE id = $1`,
      [settled!.id],
    );
    expect(row.rows[0]).toMatchObject({ phase: "answer", total_tokens: 70, reserved: "70" });

    const actualHigher = await reserve(`${PREFIX}settle-higher`, 20);
    expect(await settleVisualTokens(store.pool, actualHigher!, {
      phase: "answer", model: "fake", totalTokens: 90,
    })).toBe(90);
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
});
