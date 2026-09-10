import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadGoldenScoutGraph } from "../scout/schema-model.js";
import { resetScoutSchemaCacheForTests, setActiveScoutSchemaForTests } from "../scout/schema-cache.js";
import { WHAT_DID_I_MISS, type IntentRegexTables } from "./intent.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { planNlq } from "./planner.js";

const OWNER = "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy";
const TABLES: IntentRegexTables = {
  decline: /$a/,
  declineMnemonicAsk: /$a/,
  summarize: /$a/,
  whatDidIMiss: WHAT_DID_I_MISS,
  summarizeThread: /$a/,
  explain: /$a/,
  researchPubky: /$a/,
  researchPubkyPhrase: /$a/,
  researchWeb: /$a/,
  currentEvents: /$a/,
  evidence: /$a/,
  find: /$a/,
  compare: /$a/,
  translate: /$a/,
};

const CHIP_ROUTES = [
  ["What did I miss?", "get_what_did_i_miss"],
  ["Who tagged me?", "get_user_tags"],
  ["Who are the most followed users on Pubky?", "rank_users"],
  ["Who has the most tags?", "rank_users"],
  ["Who are the top taggers?", "rank_users"],
  ["What are the most active threads right now?", "top_posts"],
  ["What tags are trending this week?", "get_emerging_topics"],
  ["Who should I follow?", "recommend_follows"],
  ["Which accounts I follow have gone quiet?", "stale_follows"],
] as const;

describe("Pubchi App chip routing", () => {
  beforeEach(() => setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live"));
  afterEach(() => resetScoutSchemaCacheForTests());

  it.each(CHIP_ROUTES)("routes %s to %s", async (question, tool) => {
    const result = await planNlq(
      { question, asker: OWNER, pubchiMode: true, now_ms: 1_757_500_000_000 },
      { tables: TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (result.ok) expect(result.planned[0]?.tool).toBe(tool);
  });

  it("keeps graph questions and catalog questions out of deterministic feed routing", async () => {
    const graph = await planNlq(
      { question: "What are people posting about bitcoin?", asker: OWNER, pubchiMode: true, now_ms: 1_757_500_000_000 },
      { tables: TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(graph).toMatchObject({ ok: true });
    if (graph.ok) expect(graph.planned[0]?.tool).toBe("get_topic_brief");

    const jeb = await planNlq(
      { question: "explain pubky using nexus scout", now_ms: 1_757_500_000_000 },
      { tables: INTENT_REGEX_TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(jeb).toMatchObject({ ok: true });
    if (jeb.ok) expect(jeb.planned[0]?.tool).toBe("get_emerging_topics");
  });
});
