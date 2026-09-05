import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { Store } from "../db.js";
import type { Nexus } from "../nexus.js";
import { weeklyTick } from "./loop.js";
import { getWeeklyPost } from "./store.js";

vi.mock("./run.js", () => ({
  runWeeklySeries: vi.fn(async () => {
    throw new Error("compose boom");
  }),
}));

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const AUTHOR = "ffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("weeklyTick compose-failure latch", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W37'`);
  });
  afterAll(async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W37'`);
    await store.close();
  });

  it("claims the slot as skipped so a later tick does not refire", async () => {
    const cfg = {
      weeklyEnabled: true,
      weeklyTz: "Europe/London",
      weeklyTokenCap: 400_000,
      dailyTokenBudget: 1_000_000,
      botPk: AUTHOR,
      model: "test",
    } as Config;
    const nexus = { notifications: async () => [], post: async () => null } as unknown as Nexus;
    const now = new Date("2026-09-13T10:00:00+01:00");
    await weeklyTick({ cfg, store, nexus, now, lastTagCollectMs: now.getTime() });
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W37");
    expect(row?.status).toBe("skipped");
    await weeklyTick({ cfg, store, nexus, now, lastTagCollectMs: now.getTime() });
    const again = await getWeeklyPost(store.pool, "feedback", "2026-W37");
    expect(again?.status).toBe("skipped");
  });
});
