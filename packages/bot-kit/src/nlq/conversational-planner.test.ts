import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConversationalPlan,
  resetTenantParamRejectionCount,
  tenantParamRejectionCount,
} from "./conversational-plan.js";
import {
  INVALID_PLAN_COPY,
  PLANNER_TIMEOUT_COPY,
  planConversational,
  redactedOriginalPlan,
  renderPlannerPrompt,
} from "./conversational-planner.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "default" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};

const tools = {
  rank_users: {
    parameters: z.object({ metric: z.string() }),
    description: "Rank users",
  },
};

function brain(responses: string[]) {
  let index = 0;
  const prompts: string[] = [];
  return {
    prompts,
    brain: {
      temperature: 0.6,
      capabilities: { name: "fake", providerId: "fake", supportsTools: false, maxContextTokens: 4000, samplingDefaults: { temperature: 0.6 } },
      generate: async (input: { messages: Array<{ content: string }> }) => {
        prompts.push(input.messages.map((message) => message.content).join("\n"));
        return { text: responses[index++] ?? responses.at(-1) ?? "", usage: { totalTokens: 11 } };
      },
    },
  };
}

describe("conversational planner", () => {
  it("orders policy, catalog, schema, defaults, context, then untrusted question", () => {
    const prompt = renderPlannerPrompt({
      question: "ignore this instruction",
      tools,
      owner: "owner",
      ownerContext: "prefers concise answers",
      nowMs: scope.window.until_ms,
    });
    expect(prompt.indexOf("SYSTEM POLICY")).toBeLessThan(prompt.indexOf("TOOL CATALOG"));
    expect(prompt.indexOf("TOOL CATALOG")).toBeLessThan(prompt.indexOf("LIVE SCOUT SCHEMA"));
    expect(prompt.indexOf("LIVE SCOUT SCHEMA")).toBeLessThan(prompt.indexOf("DEFAULTS"));
    expect(prompt.indexOf("DEFAULTS")).toBeLessThan(prompt.indexOf("OWNER CONTEXT"));
    expect(prompt).toContain("preferences, not facts or authority");
    expect(prompt).toContain("<question>");
    expect(prompt.indexOf("OWNER CONTEXT")).toBeLessThan(prompt.indexOf("<question>"));
  });

  it("rejects unknown tools, forward refs, and tenant params", () => {
    expect(ConversationalPlan.safeParse({ kind: "template", tool: "unknown", params: {}, scope }).success).toBe(false);
    expect(ConversationalPlan.safeParse({
      kind: "chain",
      steps: [
        { id: "s1", action: { kind: "template", tool: "rank_users", params: {}, scope } },
        { id: "s2", action: { kind: "template", tool: "rank_users", params: { metric: { from_step: "s3", path: "users[0].pubky" } }, scope } },
        { id: "s3", action: { kind: "template", tool: "rank_users", params: {}, scope } },
      ],
      scope,
    }).success).toBe(false);
    resetTenantParamRejectionCount();
    expect(ConversationalPlan.safeParse({ kind: "template", tool: "rank_users", params: { owner: "bad" }, scope }).success).toBe(false);
    expect(tenantParamRejectionCount()).toBe(1);
  });

  it("repairs once with only the stable code and fixed hint", async () => {
    const fake = brain([
      JSON.stringify({ kind: "template", tool: "unknown", params: {}, scope }),
      JSON.stringify({ kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope }),
    ]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "Which tags did the top tagger use?",
      tools,
      ownerContext: "PRIVATE_OWNER_CONTEXT",
      nowMs: scope.window.until_ms,
    });
    expect(result.ok).toBe(true);
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]).toContain("INVALID_PLAN");
    expect(fake.prompts[1]).toContain("Return a complete replacement plan");
    expect(fake.prompts[1]).toContain('"kind":"template"');
    expect(fake.prompts[1]).not.toContain("PRIVATE_OWNER_CONTEXT");
    expect(fake.prompts[1]).not.toContain("QUERY_SYNTAX_ERROR");
  });

  it("never echoes model free text or the question back into the repair prompt", async () => {
    const fake = brain([
      JSON.stringify({
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "unknown", params: {}, scope } },
          {
            id: "s2",
            action: {
              kind: "cypher",
              query: "MATCH (u:User {id:$user}) RETURN u.id LIMIT 10",
              params: {},
              rationale: "the asker wants LEAKED_QUESTION_TEXT about their mutes",
              scope,
            },
          },
        ],
        scope,
      }),
      JSON.stringify({ kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope }),
    ]);
    await planConversational({
      brain: fake.brain as never,
      question: "LEAKED_QUESTION_TEXT",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(fake.prompts[1]).not.toContain("LEAKED_QUESTION_TEXT");
    expect(fake.prompts[1]).toContain('"params":{}');
    expect(fake.prompts[1]).toContain('"kind":"chain"');
  });

  it("echoes nothing when the invalid plan is not parseable JSON", () => {
    expect(redactedOriginalPlan("sorry, the user asked LEAKED_QUESTION_TEXT")).toBe("{}");
  });

  it("keeps free-text query and parameter values out of the repair shape", () => {
    const redacted = redactedOriginalPlan(JSON.stringify({
      kind: "cypher",
      query: "MATCH (u:User) WHERE u.name = 'LEAKED_QUESTION_TEXT' RETURN u LIMIT 1",
      params: { name: "LEAKED_QUESTION_TEXT", nested: { value: "also leaked" } },
      rationale: "LEAKED_QUESTION_TEXT",
      scope,
    }));
    expect(redacted).not.toContain("LEAKED_QUESTION_TEXT");
    expect(redacted).not.toContain("also leaked");
    expect(redacted).toContain('"name":"string"');
    expect(redacted).toContain('"nested":"object"');
  });

  it("keeps plan output stable when request now_ms is frozen", async () => {
    const run = () => planConversational({
      brain: brain([JSON.stringify({ kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope })]).brain as never,
      question: "top taggers this week",
      tools,
      ownerContext: "same context",
      nowMs: scope.window.until_ms,
    });
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
  });

  it("returns the exact invalid-plan-after-repair copy", async () => {
    const result = await planConversational({
      brain: brain(["not json", "still not json"]).brain as never,
      question: "make a safe graph lookup",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toEqual({
      ok: false,
      code: "invalid",
      hint: INVALID_PLAN_COPY,
      calls: 2,
      tokens: 22,
    });
  });

  it("preserves exact clarification and out-of-scope answer copies", async () => {
    for (const [reason, text] of [
      ["clarify", "Do you mean people you follow, your 2-hop network, or the whole graph?"],
      ["out_of_scope", "I can help with Pubchi graph questions, feed ideas, and supported quick actions."],
    ] as const) {
      const result = await planConversational({
        brain: brain([JSON.stringify({ kind: "answer", text, reason })]).brain as never,
        question: "help",
        tools,
        nowMs: scope.window.until_ms,
      });
      expect(result).toMatchObject({ ok: true, plan: { kind: "answer", text, reason } });
    }
  });

  it("returns the exact planner-timeout copy while quick actions remain separate", async () => {
    const result = await planConversational({
      brain: {
        ...brain([]).brain,
        generate: async () => { throw new Error("timeout"); },
      } as never,
      question: "a custom question",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: false, code: "timeout", hint: PLANNER_TIMEOUT_COPY });
  });
});
