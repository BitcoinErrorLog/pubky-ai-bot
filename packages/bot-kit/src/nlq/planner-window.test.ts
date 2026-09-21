import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRankingScope, parseRankingWindow, planNlq } from "./planner.js";
import { rankUsersTemplate } from "../scout/templates.js";
import { loadGoldenScoutGraph } from "../scout/schema-model.js";
import { resetScoutSchemaCacheForTests, setActiveScoutSchemaForTests } from "../scout/schema-cache.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";

const NOW = 1_700_000_000_000;

describe("ranking window parsing", () => {
  it.each([
    ["this week", 7],
    ["today", 1],
    ["this month", 30],
    ["last 30 days", 30],
    ["unspecified", 30],
  ])("%s uses %s days", (phrase, days) => {
    const window = parseRankingWindow(phrase, NOW);
    expect(window).toEqual({ since: NOW - days * 24 * 60 * 60 * 1000, until: NOW });
  });

  it("clamps oversized windows to the service maximum", () => {
    expect(parseRankingWindow("last 1000000000 days", NOW)).toEqual({
      since: NOW - 365 * 24 * 60 * 60 * 1000,
      until: NOW,
    });
  });

  it("uses the default window for zero and negative windows", () => {
    expect(parseRankingWindow("last 0 days", NOW)).toEqual({
      since: NOW - 30 * 24 * 60 * 60 * 1000,
      until: NOW,
    });
    expect(parseRankingWindow("last -4 days", NOW)).toEqual({
      since: NOW - 30 * 24 * 60 * 60 * 1000,
      until: NOW,
    });
  });

  it("uses no since bound for all-time questions", () => {
    expect(parseRankingWindow("who has the most tags ever", NOW)).toBe("all_time");
  });

  it("classifies network and graph scope", () => {
    expect(parseRankingScope("most tagged users in my network")).toBe("network");
    expect(parseRankingScope("most tagged users")).toBe("graph");
    expect(parseRankingScope("most active users I follow")).toBe("network");
    expect(parseRankingScope("most active people I follow")).toBe("network");
  });

  it("passes the plan-time millisecond window to the Scout template unchanged", () => {
    const window = parseRankingWindow("this week", NOW);
    if (window === "all_time") throw new Error("expected bounded window");
    const query = rankUsersTemplate({ metric: "tags_received", order: "desc", time: window, limit: 10 });
    expect(query.params).toMatchObject({ since: window.since, until: window.until });
    expect(query.cypher).toContain("$since");
    expect(window.since).toBeGreaterThan(1_000_000_000_000);
  });

  it("restricts network rankings to the asker's graph", () => {
    const query = rankUsersTemplate({
      metric: "followers",
      order: "desc",
      time: { since: 0, until: NOW },
      graphScope: { pubky: "owner" },
      limit: 10,
    });
    expect(query.params).toMatchObject({ scope_id: "owner" });
    expect(query.cypher).toContain("$scope_id");
  });
});

describe("most-active people I follow", () => {
  beforeEach(() => setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live"));
  afterEach(() => resetScoutSchemaCacheForTests());

  it.each([
    "who are the most active people I follow",
    "Who are the most active people I follow?",
    "most active users I follow",
    "most active accounts in my network",
  ])("maps %s to rank_users posts over the network window", async (question) => {
    const result = await planNlq(
      {
        question,
        asker: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy",
        pubchiMode: true,
        now_ms: NOW,
        scope: { graph_scope: { pubky: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy" } },
      },
      { tables: INTENT_REGEX_TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.planned[0]).toMatchObject({
      tool: "rank_users",
      args: {
        metric: "posts",
        order: "desc",
        limit: 10,
        scope: "network",
        graph_scope: { pubky: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy" },
      },
    });
    expect(result.planned[0]?.args).toMatchObject({
      time_range: { since: NOW - 30 * 24 * 60 * 60 * 1000, until: NOW },
    });
  });

  it("does not steal most-active taggers or threads", async () => {
    const taggers = await planNlq(
      { question: "who are the most active taggers", asker: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy", pubchiMode: true, now_ms: NOW },
      { tables: INTENT_REGEX_TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(taggers).toMatchObject({ ok: true });
    if (taggers.ok) expect(taggers.planned[0]).toMatchObject({ tool: "rank_users", args: { metric: "tags_applied" } });

    const threads = await planNlq(
      { question: "What are the most active threads right now?", asker: "fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy", pubchiMode: true, now_ms: NOW },
      { tables: INTENT_REGEX_TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(threads).toMatchObject({ ok: true });
    if (threads.ok) expect(threads.planned[0]?.tool).toBe("top_posts");
  });

  it("leaves Jeb (non-pubchi) routing off the rank_users posts arm", async () => {
    const result = await planNlq(
      { question: "who are the most active people I follow", pubchiMode: false, now_ms: NOW },
      { tables: INTENT_REGEX_TABLES, client: { schema: async () => loadGoldenScoutGraph() }, rawEnabled: false },
    );
    expect(result).toMatchObject({ ok: true, planned: [{ tool: "get_emerging_topics" }] });
    if (result.ok) expect(result.planned[0]).not.toMatchObject({ tool: "rank_users", args: { metric: "posts" } });
  });
});
