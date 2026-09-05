import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import {
  claimWeeklySlot,
  countStaleWeeklyQueued,
  finishWeeklySlot,
  getWeeklyPost,
  lastSkippedWeeklyBySeries,
  markWeeklyPublished,
  reapStaleWeeklyQueued,
  reclaimSkippedWeeklySlot,
  upsertFeedbackItem,
} from "./store.js";

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

  it("reaps a queued weekly_posts row older than the fire day", async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W35'`);
    await store.pool.query(
      `INSERT INTO weekly_posts (series, week_key, status, created_at)
       VALUES ('feedback', '2026-W35', 'queued', '2026-08-30T08:00:00Z')`,
    );
    const cutoff = new Date("2026-09-06T00:00:00Z");
    expect(await countStaleWeeklyQueued(store.pool, cutoff)).toBeGreaterThanOrEqual(1);
    expect(await reapStaleWeeklyQueued(store.pool, cutoff)).toBeGreaterThanOrEqual(1);
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W35");
    expect(row?.status).toBe("skipped");
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W35'`);
  });

  it("writes mention_key at claim time", async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W40'`);
    const key = "standalone:" + "ab".repeat(32);
    expect(await claimWeeklySlot(store.pool, "feedback", "2026-W40", key)).toBe(true);
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W40");
    expect(row?.mention_key).toBe(key);
    expect(row?.status).toBe("queued");
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W40'`);
  });

  it("does not reap a queued week that already has a post_uri", async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W34'`);
    await store.pool.query(
      `INSERT INTO weekly_posts (series, week_key, status, post_uri, created_at)
       VALUES ('feedback', '2026-W34', 'queued', $1, '2026-08-23T08:00:00Z')`,
      [URI],
    );
    const cutoff = new Date("2026-09-06T00:00:00Z");
    const before = await countStaleWeeklyQueued(store.pool, cutoff);
    expect(await reapStaleWeeklyQueued(store.pool, cutoff)).toBeGreaterThanOrEqual(0);
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W34");
    expect(row?.status).toBe("queued");
    expect(row?.post_uri).toBe(URI);
    expect(await countStaleWeeklyQueued(store.pool, cutoff)).toBe(before);
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W34'`);
  });

  it("marks a weekly row published by mention_key and lists last skipped", async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key IN ('2026-W32', '2026-W33')`);
    await store.pool.query(`DELETE FROM weekly_posts WHERE series = 'updates' AND status = 'skipped'`);
    const key = "standalone:" + "cd".repeat(32);
    await store.pool.query(
      `INSERT INTO weekly_posts (series, week_key, status, mention_key)
       VALUES ('feedback', '2026-W32', 'queued', $1)`,
      [key],
    );
    await store.pool.query(
      `INSERT INTO weekly_posts (series, week_key, status)
       VALUES ('updates', '2026-W33', 'skipped')`,
    );
    expect(await markWeeklyPublished(store.pool, key)).toBe(1);
    expect((await getWeeklyPost(store.pool, "feedback", "2026-W32"))?.status).toBe("published");
    const skipped = await lastSkippedWeeklyBySeries(store.pool);
    expect(skipped.updates).toBe("2026-W33");
    expect(await reclaimSkippedWeeklySlot(store.pool, "updates", "2026-W33")).toBe(true);
    expect(await getWeeklyPost(store.pool, "updates", "2026-W33")).toBeNull();
    expect(await reclaimSkippedWeeklySlot(store.pool, "updates", "2026-W33")).toBe(false);
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key IN ('2026-W32', '2026-W33')`);
  });
});
