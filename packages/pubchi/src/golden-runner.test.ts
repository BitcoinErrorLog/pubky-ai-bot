import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planConversational } from "../bot-kit/nlq/conversational-planner.js";
import { executeConversationalPlan, executeTrendingFallback } from "./plan-executor.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "default" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};
const tools = {
  rank_users: { parameters: z.object({ metric: z.string() }), description: "rank" },
  get_emerging_topics: { parameters: z.object({}), description: "emerging" },
};

const meter = () => ({
  record() {},
  assertBudget() {},
  snapshot: () => ({ calls: 0, scoutMs: 0 }),
});

const brainFor = (plan: unknown) => ({
  temperature: 0.6,
  capabilities: { name: "golden", providerId: "golden", supportsTools: false, maxContextTokens: 4000, samplingDefaults: { temperature: 0.6 } },
  generate: async () => ({ text: JSON.stringify(plan), usage: { totalTokens: 1 } }),
});

describe("Pubchi golden planner and executor runner", () => {
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
              { id: "s2", action: { kind: "cypher", query: "MATCH (u:User {id:$user}) RETURN u.id LIMIT 10", params: { user: { from_step: "s1", path: "users[0].pubky" } }, rationale: "tag breakdown", scope } },
            ],
            scope,
          }
        : {
            kind: "chain",
            steps: [
              { id: "s1", action: { kind: "template", tool: "get_emerging_topics", params: {}, scope } },
              { id: "s2", action: { kind: "cypher", query: "MATCH (t:Tag) RETURN t.label LIMIT 10", params: {}, rationale: "frequency fallback", scope } },
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
          const executed = await executeConversationalPlan({
            owner: "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u",
            nowMs: scope.window.until_ms,
            meter: meter(),
            plan: out.plan,
            composedCypherEnabled: true,
            composer: {
              revalidateResolvedParams() {},
              composeCypher: (input) => ({ ok: true, cypher: input.query, params: input.params, limit: 10, anchors: [] }),
            },
            tools: {
              rank_users: { parameters: z.object({ metric: z.string() }), execute: async () => ({ users: [{ pubky: "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u" }] }) },
              get_emerging_topics: { parameters: z.object({}), execute: async () => ({ topics: [] }) },
              query_graph: { parameters: z.object({ cypher: z.string(), params: z.record(z.unknown()), limit: z.number() }), execute: async () => ({ tags: [{ label: "bitcoin", count: 4 }] }) },
            },
          });
          expect(executed.complete).toBe(true);
          if (topTagger) expect(executed.tools).toEqual(["rank_users", "query_graph"]);
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
});
