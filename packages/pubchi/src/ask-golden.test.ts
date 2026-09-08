import { describe, expect, it, afterEach } from "vitest";
import { INTENT_REGEX_TABLES } from "../../src/intent.js";
import {
  ScoutClient,
  loadGoldenScoutGraph,
  queryNlq,
  resetScoutSchemaCacheForTests,
  setActiveScoutSchemaForTests,
} from "@pubky/bot-kit";
import { configFromProcessEnv } from "../../src/config.js";

const CASES = [
  ["Who are the most followed users on Pubky?", "rank_users", "user"],
  ["Who tagged me this week, and what did they tag me as?", "get_tag_landscape", "tag"],
  ["What are the trending tags in my graph neighborhood?", "get_emerging_topics", "tag"],
  ["Show me what the top taggers are saying about Bitcoin scaling this week", "get_topic_brief", "post"],
  ["Summarize the most active threads from people I follow", "top_posts", "post"],
  ["Who am I connected to within 2 hops who is tagged builder?", "trust_view", "user"],
  ["Who should I follow?", "recommend_follows", "user"],
  ["Which of the people I follow have gone quiet?", "stale_follows", "user"],
] as const;

const ASKER = "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy";

describe("Pubchi ask golden routing", () => {
  afterEach(() => resetScoutSchemaCacheForTests());

  it.each(CASES)("%s routes to %s and produces %s evidence", async (question, tool, kind) => {
    setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live");
    const stub = await startScoutFixture();
    process.env.DATABASE_URL ??= "postgres://unit-test.invalid/pubchi";
    const config = configFromProcessEnv({ requireSecret: false });
    const pool = { query: async () => ({ rows: [{ n: "0" }] }) } as never;
    const out = await queryNlq(
      { question, asker: ASKER, scope: { graph_scope: { pubky: ASKER } }, pubchiMode: true },
      {
        cfg: { ...config, scoutEnabled: true, scoutRawEnabled: false, scoutUrl: stub.url },
        pool,
        tables: INTENT_REGEX_TABLES,
        client: new ScoutClient({ ...config, scoutEnabled: true, scoutRawEnabled: false, scoutUrl: stub.url }, pool),
        nlqDailyQueries: 100,
      },
    );
    try {
      expect(out.outcome).toBe("ok");
      expect(out.planned.map((call) => call.tool)).toContain(tool);
      expect(out.results).toHaveLength(1);
      const evidenceField = {
        rank_users: "users",
        get_tag_landscape: "claims",
        get_emerging_topics: "topics",
        get_topic_brief: "posts",
        top_posts: "posts",
        trust_view: "claims",
        recommend_follows: "users",
        stale_follows: "users",
      }[tool];
      expect(["user", "tag", "post"]).toContain(kind);
      expect(Array.isArray((out.results[0] as Record<string, unknown>)[evidenceField])).toBe(true);
      expect((out.results[0] as Record<string, unknown>)[evidenceField]).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => stub.close(resolve));
    }
  });
});

async function startScoutFixture(): Promise<{ url: string; close: (callback: () => void) => void }> {
  const { createServer } = await import("node:http");
  let calls = 0;
  const server = createServer((_, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      results: [
        {
          id: ASKER,
          label: "builder",
          uri: `pubky://${ASKER}/pub/pubky.app/profile.json`,
          count: 1,
          distinct_taggers: calls === 1 ? 2 : 1,
          uses: 1,
        },
      ],
      count: 1,
      truncated: false,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return { url: `http://127.0.0.1:${address.port}`, close: (callback) => server.close(callback) };
}
