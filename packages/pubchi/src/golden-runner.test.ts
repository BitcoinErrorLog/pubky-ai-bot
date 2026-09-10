import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planConversational } from "../bot-kit/nlq/conversational-planner.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "default" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};
const tools = {
  rank_users: { parameters: z.object({ metric: z.string() }), description: "rank" },
  get_emerging_topics: { parameters: z.object({}), description: "emerging" },
};

describe("Pubchi golden planner runner", () => {
  it("executes the three frozen cases and asserts plan class", async () => {
    const fixtures = ["top-tagger-top-tags.json", "trending-tags.json", "conversation.json"]
      .map((name) => JSON.parse(readFileSync(new URL(`./__fixtures__/golden/${name}`, import.meta.url), "utf8")) as {
        question: string;
        plan_kind?: string;
        expected?: { plan_kind: string };
      })
      .map((fixture) => ({ ...fixture, plan_kind: fixture.plan_kind ?? fixture.expected?.plan_kind ?? "answer" }));
    for (const fixture of fixtures) {
      const answer = fixture.plan_kind === "answer"
        ? { kind: "answer", text: "Pubchi can answer graph questions.", reason: "conversational" }
        : {
            kind: "chain",
            steps: [
              { id: "s1", action: { kind: "template", tool: fixture.question.includes("trending") ? "get_emerging_topics" : "rank_users", params: fixture.question.includes("trending") ? {} : { metric: "tags_applied" }, scope } },
              { id: "s2", action: { kind: "template", tool: fixture.question.includes("trending") ? "rank_users" : "rank_users", params: { metric: "tags_applied" }, scope } },
            ],
            scope,
          };
      const out = await planConversational({
        question: fixture.question,
        tools,
        nowMs: scope.window.until_ms,
        brain: {
          temperature: 0.6,
          capabilities: { name: "golden", providerId: "golden", supportsTools: false, maxContextTokens: 4000, samplingDefaults: { temperature: 0.6 } },
          generate: async () => ({ text: JSON.stringify(answer), usage: { totalTokens: 1 } }),
        } as never,
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.plan.kind).toBe(fixture.plan_kind);
    }
  });
});
