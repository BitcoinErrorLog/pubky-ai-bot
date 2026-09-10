import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { planConversational } from "../bot-kit/nlq/conversational-planner.js";
import { ScoutCallMeter } from "../bot-kit/scout/budget.js";
import { guardRawCypher } from "../bot-kit/scout/guard.js";
import { loadGoldenScoutGraph } from "../bot-kit/scout/schema-model.js";
import { resetScoutSchemaCacheForTests, setActiveScoutSchemaForTests } from "../bot-kit/scout/schema-cache.js";
import { COMPOSER_DENIED_COPY, executeConversationalPlan, executeTrendingFallback } from "./plan-executor.js";
import { TEST_FAKE, TEST_OWNER } from "./test-helpers.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "default" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};
const window = { since: scope.window.since_ms, until: scope.window.until_ms };
const tools = {
  rank_users: { parameters: z.object({ metric: z.string() }), description: "rank" },
  get_emerging_topics: { parameters: z.object({}), description: "emerging" },
};

const TOP_TAGGER_QUERY =
  "MATCH (u:User {id:$user})-[t:TAGGED]->(p:Post) WHERE t.indexed_at >= $since AND t.indexed_at <= $until RETURN t.label AS label,count(*) AS count ORDER BY count DESC LIMIT 10";
const TRENDING_QUERY =
  "MATCH (u:User)-[t:TAGGED]->(p:Post) WHERE t.indexed_at >= $since AND t.indexed_at <= $until RETURN t.label AS label,count(*) AS count ORDER BY count DESC LIMIT 10";
const MUTED_ENUMERATION_QUERY =
  "MATCH (u:User {id:$user})-[m:MUTED]->(v:User) WHERE m.indexed_at >= $since AND m.indexed_at <= $until RETURN v.id AS pubky LIMIT 10";

const brainFor = (plan: unknown) => ({
  temperature: 0.6,
  capabilities: { name: "golden", providerId: "golden", supportsTools: false, maxContextTokens: 4000, samplingDefaults: { temperature: 0.6 } },
  generate: async () => ({ text: JSON.stringify(plan), usage: { totalTokens: 1 } }),
});

/**
 * Scout stand-in that runs the canonical guard on whatever the composer
 * emitted. Rows are fixtures; the acceptance decision is production code.
 */
function guardedQueryGraph(calls: string[]) {
  return {
    parameters: z.object({ cypher: z.string(), params: z.record(z.unknown()), limit: z.number() }),
    execute: async (args: { cypher: string; params: Record<string, unknown> }) => {
      const guarded = guardRawCypher(args.cypher, args.params, {
        limitMax: 50,
        profilePropMax: 3,
        rawEnabled: true,
        schema: loadGoldenScoutGraph(),
      });
      if (!guarded.ok || !guarded.cypher) return { error: "QUERY_REJECTED", message: "query rejected" };
      calls.push(guarded.cypher);
      return { results: [{ label: "bitcoin", count: 4 }], tags: [{ label: "bitcoin", count: 4 }] };
    },
  };
}

function executorTools(calls: string[]) {
  return {
    rank_users: { parameters: z.object({ metric: z.string() }), execute: async () => ({ users: [{ pubky: TEST_FAKE }] }) },
    get_emerging_topics: { parameters: z.object({}), execute: async () => ({ topics: [] }) },
    query_graph: guardedQueryGraph(calls),
  };
}

describe("Pubchi golden planner and executor runner", () => {
  beforeEach(() => setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live"));
  afterEach(() => resetScoutSchemaCacheForTests());

  it("executes the three frozen cases and two screenshot questions through real planner and executor", async () => {
    const fixtures = ["top-tagger-top-tags.json", "trending-tags.json", "conversation.json"]
      .map((name) => JSON.parse(readFileSync(new URL(`./__fixtures__/golden/${name}`, import.meta.url), "utf8")) as {
        question: string;
        plan_kind?: string;
        expected?: { plan_kind: string };
      })
      .map((fixture) => ({ ...fixture, plan_kind: fixture.plan_kind ?? fixture.expected?.plan_kind ?? "answer" }));
    const cases = [
      ...fixtures,
      { question: "Which tags has the top tagger used the most?", plan_kind: "chain" },
      { question: "What tags are trending this week?", plan_kind: "chain" },
    ];
    for (const fixture of cases) {
      const topTagger = fixture.question.includes("top tagger");
      const trending = fixture.question.includes("trending");
      const answer = fixture.plan_kind === "answer"
        ? { kind: "answer", text: "Pubchi can answer graph questions.", reason: "conversational" }
        : topTagger
        ? {
            kind: "chain",
            steps: [
              { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
              {
                id: "s2",
                action: {
                  kind: "cypher",
                  query: TOP_TAGGER_QUERY,
                  params: { user: { from_step: "s1", path: "users[0].pubky" }, ...window },
                  rationale: "tag breakdown",
                  scope,
                },
              },
            ],
            scope,
          }
        : {
            kind: "chain",
            steps: [
              { id: "s1", action: { kind: "template", tool: "get_emerging_topics", params: {}, scope } },
              { id: "s2", action: { kind: "cypher", query: TRENDING_QUERY, params: { ...window }, rationale: "frequency fallback", scope } },
            ],
            scope,
          };
      const out = await planConversational({
        question: fixture.question,
        tools,
        nowMs: scope.window.until_ms,
        brain: brainFor(answer) as never,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.plan.kind).toBe(fixture.plan_kind);
        if (out.plan.kind === "chain") {
          const guarded: string[] = [];
          const executed = await executeConversationalPlan({
            owner: TEST_OWNER,
            nowMs: scope.window.until_ms,
            meter: new ScoutCallMeter(),
            plan: out.plan,
            composedCypherEnabled: true,
            schema: loadGoldenScoutGraph(),
            tools: executorTools(guarded),
          });
          expect(executed.complete).toBe(true);
          // The composer and the canonical guard both accepted the composed step.
          expect(guarded).toHaveLength(1);
          expect(guarded[0]).toContain("RETURN t.label AS label,count(*) AS count");
          if (topTagger) {
            expect(executed.tools).toEqual(["rank_users", "query_graph"]);
            expect(guarded[0]).toContain("(u:User {id:$user})");
          }
          if (trending) {
            const fallback = await executeTrendingFallback({
              emergingTopics: async () => ({ topics: [] }),
              compose: async () => executed.results[1],
            });
            expect(fallback.summary).toContain("most used this week");
          }
        }
      }
    }
  });

  it("refuses a golden case the canonical guard rejects", async () => {
    const plan = {
      kind: "cypher",
      query: MUTED_ENUMERATION_QUERY,
      params: { user: TEST_FAKE, ...window },
      rationale: "who they muted",
      scope,
    };
    const out = await planConversational({
      question: "Who has that user muted?",
      tools,
      nowMs: scope.window.until_ms,
      brain: brainFor(plan) as never,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const guarded: string[] = [];
    const executed = await executeConversationalPlan({
      owner: TEST_OWNER,
      nowMs: scope.window.until_ms,
      meter: new ScoutCallMeter(),
      plan: out.plan,
      composedCypherEnabled: true,
      schema: loadGoldenScoutGraph(),
      tools: executorTools(guarded),
    });
    // Both layers refuse it: the composer never emits it, and the canonical
    // guard would refuse the same text on its own.
    expect(guardRawCypher(MUTED_ENUMERATION_QUERY, { user: TEST_FAKE, ...window }, {
      limitMax: 50,
      profilePropMax: 3,
      rawEnabled: true,
      schema: loadGoldenScoutGraph(),
      requireOwnerAnchor: true,
    }).ok).toBe(false);
    expect(guarded).toEqual([]);
    expect(executed.complete).toBe(false);
    expect(executed.failureCode).toBe("COMPOSER_DENIED");
    expect(executed.message).toBe(COMPOSER_DENIED_COPY);
    expect(executed.tools).toEqual([]);
  });
});
