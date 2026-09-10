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

const ASKER = "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy";

const CASES = [
  ["Who are the most followed users on Pubky?", "rank_users", "user"],
  ["Who has the most tags from different people on their posts and profile?", "rank_users", "user"],
  ["Who are the most tagged profiles?", "rank_users", "user"],
  ["Who are the top taggers?", "rank_users", "user"],
  ["Who tagged me this week, and what did they tag me as?", "get_tag_landscape", "tag"],
  ["Who tagged me?", "get_user_tags", "tag"],
  ["has anyone tagged me", "get_user_tags", "tag"],
  ["did anyone tag me?", "get_user_tags", "tag"],
  ["who has tagged me", "get_user_tags", "tag"],
  ["who's tagged me?", "get_user_tags", "tag"],
  ["am I tagged", "get_user_tags", "tag"],
  ["what am I tagged as", "get_user_tags", "tag"],
  ["how am I tagged?", "get_user_tags", "tag"],
  ["what tags do I have", "get_user_tags", "tag"],
  ["my tags", "get_user_tags", "tag"],
  ["tags on me?", "get_user_tags", "tag"],
  ["any new tags on me", "get_user_tags", "tag"],
  ["show me my tags?", "get_user_tags", "tag"],
  ["which tags have people given me", "get_user_tags", "tag"],
  ["What are the trending tags in my graph neighborhood?", "get_emerging_topics", "tag"],
  ["What tags are trending this week?", "get_emerging_topics", "tag"],
  ["Show me what the top taggers are saying about Bitcoin scaling this week", "get_topic_brief", "post"],
  ["What are people saying on nostr?", "get_topic_brief", "post"],
  ["Show me posts about bitcoin", "get_topic_brief", "post"],
  ["Summarize the most active threads from people I follow", "top_posts", "post"],
  ["What are the most active threads right now?", "top_posts", "post"],
  ["Who am I connected to within 2 hops who is tagged builder?", "trust_view", "user"],
  ["Who should I follow?", "recommend_follows", "user"],
  ["Which of the people I follow have gone quiet?", "stale_follows", "user"],
  ["Which accounts I follow have gone quiet?", "stale_follows", "user"],
  ["What changed in my network this week?", "get_what_changed", "post"],
  ["What did I miss", "get_what_did_i_miss", "post"],
  ["What did I miss since 2026-09-09T20:00:00Z", "get_what_did_i_miss", "post"],
  ["Catch me up", "get_what_did_i_miss", "post"],
  ["Anything new since yesterday", "get_what_did_i_miss", "post"],
  [`summarize this thread pubky://${ASKER}/pub/pubky.app/posts/0035NV17R994G`, "scout_get_thread", "post"],
  [`summarize pubky://${ASKER}/pub/pubky.app/posts/0035NV17R994G`, "scout_get_thread", "post"],
  [`what's this thread about https://pubky.app/post/${ASKER}/0035NV17R994G`, "scout_get_thread", "post"],
  [`summarize https://bots.pubky.app/post/${ASKER}/0035NV17R994G`, "scout_get_thread", "post"],
] as const;

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
        nexus: tool === "get_user_tags"
          ? ({
              host: () => "nexus.test",
              userTags: async () => [{ label: "builder", taggers: [ASKER], taggers_count: 1, relationship: false }],
            } as never)
          : undefined,
        nlqDailyQueries: 100,
      },
    );
    try {
      expect(out.outcome).toBe("ok");
      expect(out.planned.map((call) => call.tool)).toContain(tool);
      expect(out.results).toHaveLength(1);
      if (tool === "rank_users") {
        const args = out.planned.find((call) => call.tool === "rank_users")?.args;
        expect(args?.metric).toBe(question.includes("tagger") ? "tags_applied" : question.includes("tag") ? "tags_received" : "followers");
        expect(args?.order).toBe("desc");
        if (question.includes("tag")) expect(args?.limit).toBe(10);
      }
      if (question === "What are people saying on nostr?") {
        expect(out.planned[0]?.args.topic).toBe("nostr");
      }
      if (question === "Show me posts about bitcoin") {
        expect(out.planned[0]?.args.topic).toBe("bitcoin");
      }
      if (tool === "get_user_tags") return;
      const evidenceField = {
        rank_users: "users",
        get_tag_landscape: "claims",
        get_user_tags: "tags",
        get_emerging_topics: "topics",
        get_topic_brief: "posts",
        get_what_changed: "posts",
        top_posts: "posts",
        scout_get_thread: "posts",
        get_what_did_i_miss: "posts",
        trust_view: "claims",
        recommend_follows: "users",
        stale_follows: "users",
      }[tool];
      expect(["user", "tag", "post"]).toContain(kind);
      expect(Array.isArray((out.results[0] as Record<string, unknown>)[evidenceField])).toBe(true);
      expect((out.results[0] as Record<string, unknown>)[evidenceField]).toHaveLength(tool === "scout_get_thread" ? 2 : 1);
    } finally {
      await new Promise<void>((resolve) => stub.close(resolve));
    }
  });

  it.each([
    "who tagged bitcoin",
    "tags on bitcoin",
    "what did I miss in the bitcoin price",
  ])("%s does not route to owner tags", async (question) => {
    setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live");
    const stub = await startScoutFixture();
    const config = configFromProcessEnv({ requireSecret: false });
    const pool = { query: async () => ({ rows: [{ n: "0" }] }) } as never;
    try {
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
      expect(out.planned.map((call) => call.tool)).not.toContain("get_user_tags");
      if (question.includes("what did I miss")) {
        expect(out.planned.map((call) => call.tool)).not.toContain("get_what_changed");
      }
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
          author_id: ASKER,
          author_name: "Ada",
          post_id: "0035NV17R994G",
          content: "A thread fixture post.",
          event_kind: "post",
          indexed_at: Date.now(),
          label: "builder",
          uri: `pubky://${ASKER}/pub/pubky.app/profile.json`,
          count: 1,
          distinct_taggers: calls === 1 ? 2 : 1,
          uses: 1,
        },
      ],
      tags: [{ label: "builder", taggers: [ASKER], taggers_count: 1 }],
      count: 1,
      truncated: false,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return { url: `http://127.0.0.1:${address.port}`, close: (callback) => server.close(callback) };
}
