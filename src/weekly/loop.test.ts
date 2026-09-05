import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { Store } from "../db.js";
import type { Nexus } from "../nexus.js";
import { weeklyTick } from "./loop.js";
import { getWeeklyPost } from "./store.js";
import { runWeeklySeries, type WeeklyRunResult } from "./run.js";

vi.mock("./run.js", () => ({
  runWeeklySeries: vi.fn(),
}));

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const AUTHOR = "ffffffffffffffffffffffffffffffffffffffffffffffffffff";

function emptyResult(): WeeklyRunResult {
  return {
    markdown: "# ok",
    published: true,
    skipped: false,
    weekKey: "2026-W37",
    window: { sinceMs: 0, untilMs: 1 },
  };
}

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

  it("retries once then latches skipped so a later tick does not refire", async () => {
    vi.mocked(runWeeklySeries).mockReset();
    vi.mocked(runWeeklySeries).mockRejectedValue(new Error("compose boom"));
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
    await weeklyTick({ cfg, store, nexus, now, lastTagCollectMs: now.getTime(), composeRetryMs: 5 });
    expect(runWeeklySeries).toHaveBeenCalledTimes(2);
    const row = await getWeeklyPost(store.pool, "feedback", "2026-W37");
    expect(row?.status).toBe("skipped");
    await weeklyTick({ cfg, store, nexus, now, lastTagCollectMs: now.getTime(), composeRetryMs: 5 });
    const again = await getWeeklyPost(store.pool, "feedback", "2026-W37");
    expect(again?.status).toBe("skipped");
  });

  it("does not latch when the first compose throw succeeds on retry", async () => {
    await store.pool.query(`DELETE FROM weekly_posts WHERE week_key = '2026-W37'`);
    vi.mocked(runWeeklySeries).mockReset();
    vi.mocked(runWeeklySeries).mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(emptyResult());
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
    await weeklyTick({ cfg, store, nexus, now, lastTagCollectMs: now.getTime(), composeRetryMs: 5 });
    expect(runWeeklySeries).toHaveBeenCalledTimes(2);
    expect(await getWeeklyPost(store.pool, "feedback", "2026-W37")).toBeNull();
  });
});
