import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromProcessEnv } from "../config.js";
import { Store } from "../db.js";
import { runWeeklyCli } from "./cli.js";
import { upsertFeedbackItem } from "./store.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const AUTHOR = "gggggggggggggggggggggggggggggggggggggggggggggggggggg";
const URI = `pubky://${AUTHOR}/pub/pubky.app/posts/WEEKLYCLI0001`;
const ENV_KEYS = ["DATABASE_URL", "JEB_WEEKLY_ENABLED", "JEB_WEEKLY_TZ", "JEB_NEXUS_URL"] as const;

describe("weekly dry-run CLI", () => {
  let store: Store;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.DATABASE_URL = DB;
    process.env.JEB_WEEKLY_ENABLED = "1";
    process.env.JEB_WEEKLY_TZ = "Europe/London";
    process.env.JEB_NEXUS_URL = "http://127.0.0.1:9";
    store = new Store(DB);
    await store.migrate();
    await store.pool.query(`DELETE FROM feedback_items WHERE post_uri = $1`, [URI]);
    await upsertFeedbackItem(store.pool, {
      postUri: URI,
      authorPk: AUTHOR,
      kinds: ["advice"],
      quote: "ship weekly notes",
      weekKey: "2026-W36",
      source: "classifier",
    });
    await store.pool.query(`UPDATE feedback_items SET detected_at = TIMESTAMPTZ '2026-09-04T12:00:00Z' WHERE post_uri = $1`, [URI]);
  });
  afterAll(async () => {
    await store.pool.query(`DELETE FROM feedback_items WHERE post_uri = $1`, [URI]);
    await store.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prints Markdown and does not enqueue a publish request", async () => {
    const cfg = configFromProcessEnv({ requireSecret: false, role: "weekly" });
    const before = await store.pool.query(`SELECT count(*)::int AS n FROM publish_requests`);
    const result = await runWeeklyCli(cfg, [
      "node",
      "main.js",
      "--role",
      "weekly",
      "run",
      "feedback",
      "--week",
      "2026-W36",
      "--dry-run",
    ]);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("Community feedback");
    expect(result.lines.join("\n")).toContain("ship weekly notes");
    const after = await store.pool.query(`SELECT count(*)::int AS n FROM publish_requests`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const slots = await store.pool.query(
      `SELECT count(*)::int AS n FROM weekly_posts WHERE series = 'feedback' AND week_key = '2026-W36'`,
    );
    expect(slots.rows[0].n).toBe(0);
  });

  it("rejects a bad series", async () => {
    const cfg = configFromProcessEnv({ requireSecret: false, role: "weekly" });
    const result = await runWeeklyCli(cfg, ["node", "main.js", "--role", "weekly", "run", "nope"]);
    expect(result.ok).toBe(false);
  });
});
