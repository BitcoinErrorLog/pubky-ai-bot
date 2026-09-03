import { writeFileSync } from "node:fs";
import path from "node:path";
import { Store } from "../db.js";
import { configFromProcessEnv } from "../config.js";
import { ScoutClient } from "./client.js";
import { createScoutTools } from "./tools.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

async function main(): Promise<void> {
  const store = new Store(DB);
  await store.migrate();
  const cfg = {
    ...configFromProcessEnv({ requireSecret: false }),
    databaseUrl: DB,
    scoutUrl: process.env.JEB_SCOUT_URL?.trim() || "https://nexus-scout.pubky.app",
    scoutEnabled: true,
    scoutDailyCeiling: 10_000,
    scoutPerMentionCap: 100,
  };
  const client = new ScoutClient(cfg, store.pool);
  const tools = createScoutTools({
    cfg,
    pool: store.pool,
    mentionKey: "measure",
    storeSwitchOn: async () => false,
    client,
  });
  const rows: Array<Record<string, unknown>> = [];
  const time = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    const out = await fn();
    const ms = Date.now() - t0;
    const rec = out as { truncated?: boolean; posts?: unknown[]; users?: unknown[]; topics?: unknown[]; clusters?: unknown[] };
    rows.push({
      tool: name,
      ms,
      truncated: rec.truncated ?? false,
      n:
        rec.posts?.length ??
        rec.users?.length ??
        rec.topics?.length ??
        rec.clusters?.length ??
        (typeof (out as { count?: number }).count === "number" ? (out as { count: number }).count : 1),
    });
    return out;
  };
  const bitcoin = await time("search_posts:bitcoin", () => tools.search_posts.execute({ query: "bitcoin", limit: 5 }));
  const pubky = await time("search_posts:pubky", () => tools.search_posts.execute({ query: "pubky", limit: 5 }));
  const first = (bitcoin as { posts: { uri: string }[] }).posts[0];
  if (first) {
    await time("scout_get_thread", () => tools.scout_get_thread.execute({ uri: first.uri, depth: 2, include_profiles: true }));
    await time("get_related_posts", () =>
      tools.get_related_posts.execute({ uri: first.uri, relationship: "replied", limit: 5 }),
    );
  }
  await time("get_tag_landscape:bitcoin", () => tools.get_tag_landscape.execute({ tag: "bitcoin" }));
  await time("get_tag_landscape:pubky", () => tools.get_tag_landscape.execute({ tag: "pubky" }));
  await time("get_topic_brief:bitcoin", () => tools.get_topic_brief.execute({ topic: "bitcoin" }));
  await time("get_what_changed:pubky", () => tools.get_what_changed.execute({ topic: "pubky", since: Date.now() - 7 * 86400000 }));
  await time("get_emerging_topics", () => tools.get_emerging_topics.execute({}));
  await time("get_debate_map:bitcoin", () => tools.get_debate_map.execute({ topic: "bitcoin" }));
  const users = (await time("search_users_by_name", () =>
    tools.search_users_by_name.execute({ name: "John Carvalho", limit: 5 }),
  )) as { users: { pubky: string }[] };
  if (users.users[0]) {
    await time("get_identity_summary", () => tools.get_identity_summary.execute({ pubky: users.users[0]!.pubky }));
    if (users.users[1]) {
      await time("get_relationship", () =>
        tools.get_relationship.execute({ pubky_a: users.users[0]!.pubky, pubky_b: users.users[1]!.pubky }),
      );
    }
  }
  const cost = await store.pool.query(
    `SELECT tool, count(*) AS n, avg(duration_ms)::int AS avg_ms, sum(rows) AS rows, bool_or(truncated) AS any_trunc
     FROM scout_queries WHERE mention_key = 'measure' GROUP BY tool ORDER BY tool`,
  );
  console.log(JSON.stringify({ live: rows, cost: cost.rows }, null, 2));
  writeFileSync(path.join(process.cwd(), "tests/scout/fixtures/measure.json"), JSON.stringify({ live: rows, cost: cost.rows }, null, 2));
  await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
