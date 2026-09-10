import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHostedMoonshotBrain } from "../brain/moonshot.js";
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
  profile_card: {
    parameters: z.object({ pubky: z.string() }),
    description: "Profile card",
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
  it.each([
    ["build a feed of bitcoin posts from people I follow", "bitcoin", "following", "recent"],
    ["make a feed of bitcoin posts across the web of trust", "bitcoin", "wot", "recent"],
    ["I want a feed of bitcoin posts sorted by popularity", "bitcoin", "all", "popularity"],
  ])("maps feed-building phrasing: %s", async (question, tag, reach, sort) => {
    const result = await planConversational({ question, tools, nowMs: scope.window.until_ms });
    expect(result).toMatchObject({
      ok: true,
      calls: 0,
      plan: { kind: "feed", spec: { feed: { tags: [tag], reach, sort } } },
    });
  });

  it.each([
    "Which parameters can you use to build a feed?",
    "What sort options can a feed use?",
    "How do I build a feed?",
  ])("keeps feed catalog questions out of feed planning: %s", async (question) => {
    const fake = brain([JSON.stringify({ kind: "answer", text: "Feed catalog", reason: "conversational", basis: "model" })]);
    const result = await planConversational({ question, tools, nowMs: scope.window.until_ms, brain: fake.brain as never });
    expect(result).toMatchObject({ ok: true, plan: { kind: "answer" } });
  });

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
    expect(prompt).toContain("Return ONLY one JSON object");
    expect(prompt).toContain('"kind":"answer"');
    expect(prompt).toContain('"kind":"web"');
    expect(prompt).toContain('"basis":"mixed"');
    expect(prompt).toContain('"scope":{"window"');
    expect(prompt).toContain('"from_step":"s1"');
    expect(prompt).toContain("<question>");
    expect(prompt.indexOf("OWNER CONTEXT")).toBeLessThan(prompt.indexOf("<question>"));
  });

  it("keeps small talk compact and includes schema for other questions", () => {
    const casual = renderPlannerPrompt({
      question: "how are you?",
      tools,
      nowMs: scope.window.until_ms,
    });
    const graph = renderPlannerPrompt({
      question: "who are the top followers?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(Math.ceil(casual.length / 4)).toBeLessThan(1_200);
    expect(casual).toContain("graph schema omitted; ask again with a graph term to compose Cypher");
    expect(graph).toContain("LIVE SCOUT SCHEMA");
    expect(graph).not.toContain("graph schema omitted");
  });

  it.each([
    "hi, who tagged me?",
    "hello — most followed users this week?",
    "thanks, and what about last month?",
  ])("keeps schema for greeting-prefixed graph questions: %s", (question) => {
    expect(renderPlannerPrompt({ question, tools, nowMs: scope.window.until_ms })).toContain("\"labels\"");
  });

  it.each(["how are you?", "hi!", "thanks"])("omits schema for whole-question small talk: %s", (question) => {
    expect(renderPlannerPrompt({ question, tools, nowMs: scope.window.until_ms })).toContain("graph schema omitted");
  });

  it("names every validator tool in the compact catalog", () => {
    const prompt = renderPlannerPrompt({ question: "how are you?", tools, nowMs: scope.window.until_ms });
    for (const name of Object.keys(tools)) expect(prompt).toContain(`${name}:`);
  });

  it("repairs the real model web shape with the Zod issue path", async () => {
    const fake = brain([
      JSON.stringify({
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "web", tool: "search_web", params: { query: "latest Lightning Network news this week", k: 5 } } },
          {
            id: "s2",
            action: {
              kind: "answer",
              text: "Summarize the latest Lightning Network news from the search results with citations.",
              basis: "web",
              reason: "conversational",
            },
          },
        ],
        scope,
      }),
      JSON.stringify({
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "web", query: "latest Lightning Network news this week", k: 5 } },
          {
            id: "s2",
            action: {
              kind: "answer",
              text: "Here are the latest results.",
              basis: "mixed",
              reason: "conversational",
              refs: [{ from_step: "s1", path: "results[0].url" }],
            },
          },
        ],
        scope,
      }),
    ]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "What is the latest news about the Lightning Network this week?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: true, plan: { kind: "chain" } });
    expect(result.outcomes[0]).toMatchObject({
      validation_code: "SCHEMA_INVALID",
      validation_path: "steps.0.action.query",
    });
    expect(fake.prompts[1]).toContain("path steps.0.action.query");
  });

  it("includes the bounded screened conversation window before the question", () => {
    const prompt = renderPlannerPrompt({
      question: "and what about last month?",
      conversationWindow: "USER: Who were the most tagged users this week?\nASSISTANT: I can look that up.",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(prompt).toContain("CONVERSATION WINDOW");
    expect(prompt).toContain("last month");
    expect(prompt.indexOf("CONVERSATION WINDOW")).toBeLessThan(prompt.indexOf("<question>"));
  });

  it("uses the conversation window when resolving a relative follow-up", async () => {
    const lastMonthScope = {
      window: { since_ms: scope.window.until_ms - 2_592_000_000, until_ms: scope.window.until_ms - 1, source: "explicit" as const, label: "last month" },
      graph: { kind: "whole_graph" as const },
    };
    const result = await planConversational({
      brain: brain([JSON.stringify({ kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope: lastMonthScope })]).brain as never,
      question: "and what about last month?",
      conversationWindow: "USER: Who are the most tagged users this week?\nASSISTANT: I can look that up.",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: true, plan: { scope: { window: { label: "last month" } } } });
  });

  it("states the follow-up rule and previous user question in the model prompt", async () => {
    const fake = brain([JSON.stringify({ kind: "answer", text: "I need more context.", reason: "clarify", basis: "model" })]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "and what about last month?",
      conversationWindow: "USER: Tell me something interesting.\nASSISTANT: Here is a conversational answer.",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: true, plan: { kind: "answer" } });
    expect(fake.prompts[0]).toContain("plan for the PREVIOUS user question in CONVERSATION");
    expect(fake.prompts[0]).toContain("Tell me something interesting.");
  });

  it("uses the model path without inventing context when no user turn exists", async () => {
    const fake = brain([JSON.stringify({ kind: "answer", text: "I need more context.", reason: "clarify", basis: "model" })]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "and what about last month?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: true, calls: 1, plan: { kind: "answer" } });
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
    expect(result.outcomes[0]).toMatchObject({ parse: "ok", validation_code: "SCHEMA_INVALID", validation_path: "tool" });
    expect(fake.prompts[1]).toContain("path tool");
    expect(result.outcomes[1]).toMatchObject({ parse: "ok", validation_code: null });
  });

  it.skipIf(!process.env.JEB_MODEL_API_KEY)("diagnoses and accepts the real web plan", async () => {
    const realBrain = createHostedMoonshotBrain({
      model: process.env.JEB_MODEL ?? "kimi-k3",
      apiKey: process.env.JEB_MODEL_API_KEY,
      baseUrl: process.env.JEB_MODEL_BASE_URL,
    });
    const rawOutputs: string[] = [];
    const tracingBrain = {
      ...realBrain,
      generate: async (input: Parameters<typeof realBrain.generate>[0]) => {
        const output = await realBrain.generate(input);
        rawOutputs.push(output.text);
        return output;
      },
    };
    const result = await planConversational({
      brain: tracingBrain,
      question: "What is the latest news about the Lightning Network this week?",
      tools: {
        search_web: {
          description: "Search the live web for current events. Returns titles, URLs, and snippets. Does not fetch arbitrary pages.",
          parameters: z.object({
            query: z.string().min(1).max(300),
            k: z.number().int().min(1).max(5).optional(),
          }),
        },
      },
      nowMs: Date.parse("2026-09-10T00:00:00Z"),
    });
    for (const [index, raw] of rawOutputs.entries()) {
      console.log(`REAL_MODEL_RAW_${index + 1}_BEGIN\n${raw}\nREAL_MODEL_RAW_${index + 1}_END`);
    }
    console.log("REAL_MODEL_VALIDATION_PATHS", JSON.stringify(result.outcomes.map((outcome) => outcome.validation_path)));
    expect(result.ok).toBe(true);
    expect(result.plan.kind === "web" || result.plan.kind === "chain").toBe(true);
  });

  it("extracts fenced JSON and records the repair attempt", async () => {
    const fake = brain([
      "Here is the plan:\n```json\n{\"kind\":\"template\",\"tool\":\"rank-users\",\"params\":{\"metric\":\"tags_applied\"},\"scope\":{\"window\":{\"since_ms\":1,\"until_ms\":2,\"source\":\"default\",\"label\":\"last 7 days\"},\"graph\":{\"kind\":\"whole_graph\"}},\"notes\":\"ignore\"}\n```",
    ]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "top taggers",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes).toMatchObject([
      { attempt: 1, parse: "fenced", validation_code: null, tool_names_seen: ["rank_users"] },
    ]);
  });

  it("runs repair after a prose or malformed first response", async () => {
    const fake = brain([
      "I think this should be a graph lookup.",
      JSON.stringify({ kind: "answer", text: "I need a narrower question.", reason: "clarify" }),
    ]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "Which parameters can you use to build a feed?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({
      ok: true,
      calls: 2,
      outcomes: [
        { attempt: 1, parse: "no_json", validation_code: "NO_JSON", validation_path: "<root>" },
        { attempt: 2, parse: "ok", validation_code: null },
      ],
    });
  });

  it("normalizes the model's compact chain step shape", async () => {
    const fake = brain([JSON.stringify({
      kind: "chain",
      steps: [
        { id: "s1", action: { tool: "rank_users", params: { metric: "tags_applied" } } },
        { id: "s2", action: { tool: "profile_card", params: { pubky: { from_step: "s1", path: "users[0].pubky" } } } },
      ],
    })]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "top tagger tags",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: true, plan: { kind: "chain" } });
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
    const { outcomes: firstOutcomes, ...firstStable } = first;
    const { outcomes: secondOutcomes, ...secondStable } = second;
    expect(firstStable).toEqual(secondStable);
    expect(firstOutcomes.map(({ ms: _ms, ...outcome }) => outcome)).toEqual(
      secondOutcomes.map(({ ms: _ms, ...outcome }) => outcome),
    );
  });

  it("returns the exact invalid-plan-after-repair copy", async () => {
    const result = await planConversational({
      brain: brain(["not json", "still not json"]).brain as never,
      question: "make a safe graph lookup",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      hint: INVALID_PLAN_COPY,
      calls: 2,
      tokens: 22,
      failureCode: "NO_JSON",
    });
    expect(result.outcomes).toHaveLength(2);
  });

  it("rejects an invented graph claim returned by the repair attempt", async () => {
    const fake = brain([
      JSON.stringify({ kind: "template", tool: "unknown", params: {}, scope }),
      JSON.stringify({ kind: "answer", text: "Pubky has 12,345 users.", basis: "model", reason: "conversational" }),
    ]);
    const result = await planConversational({
      brain: fake.brain as never,
      question: "how many users are there?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid", failureCode: "GRAPH_CLAIM_WITHOUT_ACTION" });
    expect(result.outcomes.at(-1)).toMatchObject({ validation_code: "GRAPH_CLAIM_WITHOUT_ACTION" });
  });

  it("rejects graph claims regardless of answer basis, while allowing knowledge explanations", async () => {
    const rejected = await planConversational({
      brain: brain([
        JSON.stringify({ kind: "answer", text: "Pubky has 12,345 users.", basis: "knowledge", reason: "conversational" }),
        JSON.stringify({ kind: "answer", text: "Pubky has 12,345 users.", basis: "knowledge", reason: "conversational" }),
      ]).brain as never,
      question: "how many users are there?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(rejected).toMatchObject({ ok: false, failureCode: "GRAPH_CLAIM_WITHOUT_ACTION" });

    const accepted = await planConversational({
      brain: brain([JSON.stringify({
        kind: "answer",
        text: "Pubky homeservers store your data under your key.",
        basis: "knowledge",
        reason: "conversational",
      })]).brain as never,
      question: "where do homeservers store data?",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(accepted).toMatchObject({ ok: true, plan: { kind: "answer", basis: "knowledge" } });
  });

  it("redacts invalid tool names from planner telemetry", async () => {
    const result = await planConversational({
      brain: brain([
        JSON.stringify({ kind: "template", tool: "OWNER_MARKER_7X9 says hi", params: {}, scope }),
        "not json",
      ]).brain as never,
      question: "look up something",
      tools,
      nowMs: scope.window.until_ms,
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ tool_names_seen: [], tool_names_dropped: 1 });
    expect(JSON.stringify(result.outcomes)).not.toContain("OWNER_MARKER_7X9");
  });

  it("preserves exact clarification and out-of-scope answer copies", async () => {
    for (const [reason, text] of [
      ["clarify", "Do you mean people you follow, your 2-hop network, or the whole graph?"],
      ["out_of_scope", "I can help with Pubchi graph questions, feed ideas, and supported quick actions."],
    ] as const) {
      const result = await planConversational({
        brain: brain([JSON.stringify({ kind: "answer", text, basis: "model", reason })]).brain as never,
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
