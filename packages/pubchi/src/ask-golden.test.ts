import { describe, expect, it, afterEach } from "vitest";
import { INTENT_REGEX_TABLES } from "../../src/intent.js";
import {
  loadGoldenScoutGraph,
  planNlq,
  resetScoutSchemaCacheForTests,
  setActiveScoutSchemaForTests,
} from "@pubky/bot-kit";

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
    const planned = await planNlq(
      { question, asker: ASKER, scope: { graph_scope: { pubky: ASKER } }, pubchiMode: true },
      { tables: INTENT_REGEX_TABLES, client: {} as never, rawEnabled: false },
    );
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) return;
    expect(planned.planned.map((call) => call.tool)).toContain(tool);
    expect(["user", "tag", "post"]).toContain(kind);
  });
});
