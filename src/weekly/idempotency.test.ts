import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import { claimWeeklySlot, finishWeeklySlot, getWeeklyPost, upsertFeedbackItem } from "./store.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const AUTHOR = "ffffffffffffffffffffffffffffffffffffffffffffffffffff";
const URI = `pubky://${AUTHOR}/pub/pubky.app/posts/WEEKLYIDEMP01`;

describe("weekly_posts idempotency", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W36'`);
    await store.pool.query(`DELETE FROM feedback_items WHERE post_uri = $1`, [URI]);
  });
  afterAll(async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W36'`);
    await store.pool.query(`DELETE FROM feedback_items WHERE post_uri = $1`, [URI]);
    await store.close();
  });

  it("claims a series/week once", async () => {
    expect(await claimWeeklySlot(store.pool, "feedback", "2026-W36")).toBe(true);
    expect(await claimWeeklySlot(store.pool, "feedback", "2026-W36")).toBe(false);
    expect(await claimWeeklySlot(store.pool, "updates", "2026-W36")).toBe(true);
    await finishWeeklySlot(store.pool, "feedback", "2026-W36", {
      status: "published",
      postUri: URI,
    });
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W36");
    expect(row?.status).toBe("published");
    expect(row?.post_uri).toBe(URI);
  });

  it("merges kinds on the same post_uri", async () => {
    expect(
      await upsertFeedbackItem(store.pool, {
        postUri: URI,
        authorPk: AUTHOR,
        kinds: ["advice"],
        quote: "shorter",
        weekKey: "2026-W36",
        source: "classifier",
      }),
    ).toBe("inserted");
    expect(
      await upsertFeedbackItem(store.pool, {
        postUri: URI,
        authorPk: AUTHOR,
        kinds: ["praise"],
        quote: "ignored",
        weekKey: "2026-W36",
        source: "tag",
      }),
    ).toBe("merged");
    const r = await store.pool.query<{ kinds: string[] }>(`SELECT kinds FROM feedback_items WHERE post_uri = $1`, [URI]);
    expect(r.rows[0].kinds.sort()).toEqual(["advice", "praise"]);
    const quote = await store.pool.query<{ quote: string }>(`SELECT quote FROM feedback_items WHERE post_uri = $1`, [URI]);
    expect(quote.rows[0].quote).toBe("shorter");
  });
});
