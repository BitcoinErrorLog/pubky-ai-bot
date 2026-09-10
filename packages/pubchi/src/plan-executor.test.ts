import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeConversationalPlan, executeTrendingFallback } from "./plan-executor.js";
import { ScoutCallBudgetError, ScoutCallMeter } from "../bot-kit/scout/budget.js";
import { ScoutToolError } from "../bot-kit/scout/client.js";
import { renderExecutionWindow } from "./execution-scope.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "explicit" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};
const firstUser = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u";

function meter(opts: { calls?: number; ms?: number } = {}) {
  const instance = new ScoutCallMeter();
  for (let i = 0; i < (opts.calls ?? 0); i += 1) instance.record(0);
  if (opts.ms) instance.record(opts.ms);
  return instance;
}

describe("typed plan executor", () => {
  it("resolves the top tagger reference into composed Cypher", async () => {
    const captured: Record<string, unknown> = {};
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      composedCypherEnabled: true,
      schema: {},
      composer: {
        composeCypher(input) {
          Object.assign(captured, input);
          return { ok: true, cypher: "MATCH (u:User {id:$user}) RETURN u.id LIMIT 10", params: input.params, limit: 10, anchors: ["user"] };
        },
        revalidateResolvedParams() {},
      },
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        query_graph: {
          parameters: z.object({ cypher: z.string(), params: z.record(z.unknown()), limit: z.number() }),
          execute: async (args) => ({ results: [{ label: "tag", count: 3 }], args }),
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          {
            id: "s2",
            action: {
              kind: "cypher",
              query: "MATCH (u:User {id:$user}) RETURN u.id LIMIT 10",
              params: { user: { from_step: "s1", path: "users[0].pubky" } },
              rationale: "tag breakdown",
              scope,
            },
          },
        ],
        scope,
      },
    });
    expect(result.complete).toBe(true);
    expect(captured.tenant).toEqual({ owner: firstUser });
    expect(captured.scopeKind).toBe("whole_graph");
    expect((captured.params as Record<string, unknown>).user).toBe(firstUser);
  });

  it("returns partial evidence and marks an incomplete chain", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        get_user_tags: {
          parameters: z.object({ pubky: z.string() }),
          execute: async () => { throw new ScoutToolError("QUERY_TIMEOUT", "timed out"); },
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "get_user_tags", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
        ],
        scope,
      },
    });
    expect(result.complete).toBe(false);
    expect(result.failedStep).toBe("s2");
    expect(result.results).toHaveLength(1);
    expect(result.scope.complete).toBe(false);
    expect(result.message).toBe(
      "I completed step 1 (ranked taggers) but step 2 (their tags) timed out; I can't answer the second part yet.",
    );
  });

  it("names the failed third part for a three-step chain", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      composedCypherEnabled: true,
      schema: {},
      composer: {
        composeCypher: () => ({ ok: true, cypher: "MATCH (u:User) RETURN u.id LIMIT 1", params: {}, limit: 1, anchors: [] }),
        revalidateResolvedParams() {},
      },
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        get_user_tags: {
          parameters: z.object({ pubky: z.string() }),
          execute: async () => ({ tags: [{ label: "bitcoin" }] }),
        },
        query_graph: {
          parameters: z.object({ cypher: z.string(), params: z.record(z.unknown()), limit: z.number() }),
          execute: async () => { throw new ScoutToolError("QUERY_TIMEOUT", "timed out"); },
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "get_user_tags", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
          { id: "s3", action: { kind: "cypher", query: "MATCH (u:User) RETURN u.id LIMIT 1", params: {}, rationale: "follow-up", scope } },
        ],
        scope,
      },
    });
    expect(result.failedStep).toBe("s3");
    expect(result.message).toContain("the third part yet");
  });

  it("keeps partial evidence and names the failed step when the Scout budget aborts", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        get_user_tags: {
          parameters: z.object({ pubky: z.string() }),
          execute: async () => { throw new ScoutCallBudgetError("SCOUT_CALL_CAP"); },
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "get_user_tags", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
        ],
        scope,
      },
    });
    expect(result.results).toHaveLength(1);
    expect(result.failureCode).toBe("SCOUT_CALL_CAP");
    expect(result.message).toBe(
      "I completed step 1 (ranked taggers) but step 2 (their tags) couldn't be completed; I can't answer the second part yet.",
    );
  });

  it("keeps composed Cypher disabled when its rollout flag is unset", async () => {
    delete process.env.PUBCHI_COMPOSED_CYPHER_ENABLED;
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      plan: {
        kind: "cypher",
        query: "MATCH (u:User {id:$owner}) RETURN u.id LIMIT 1",
        params: {},
        rationale: "test",
        scope,
      },
    });
    expect(result.kind).toBe("cypher");
    expect(result.failureCode).toBe("COMPOSER_DISABLED");
    expect(result.message).toBe("I couldn't make a safe read-only query for that request. I did not run it.");
  });

  it("derives scope from executed parameters, not from the model's plan label", async () => {
    const executedSince = scope.window.until_ms - 30 * 24 * 60 * 60 * 1000;
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({
            metric: z.string(),
            time_range: z.object({ since: z.number(), until: z.number() }),
            graph_scope: z.object({ pubky: z.string() }),
          }),
          execute: async () => ({ users: [] }),
        },
      },
      plan: {
        kind: "template",
        tool: "rank_users",
        params: {
          metric: "tags_applied",
          time_range: { since: executedSince, until: scope.window.until_ms },
          graph_scope: { pubky: firstUser },
        },
        scope: {
          window: { ...scope.window, label: "all time, whole graph", since_ms: 0 },
          graph: { kind: "whole_graph" },
        },
      },
    });
    expect(result.scope.time).toMatchObject({
      since_ms: executedSince,
      until_ms: scope.window.until_ms,
      label: renderExecutionWindow({ since_ms: executedSince, until_ms: scope.window.until_ms }),
      source: "explicit",
    });
    expect(result.scope.graph).toEqual({ kind: "owner_network" });
  });

  it("treats an empty chain step as returned-nothing failure", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        get_user_tags: {
          parameters: z.object({ pubky: z.string() }),
          execute: async () => ({ tags: [] }),
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "get_user_tags", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
        ],
        scope,
      },
    });
    expect(result.failureCode).toBe("EMPTY_RESULT");
    expect(result.message).toBe(
      "I completed step 1 (ranked taggers) but step 2 (their tags) returned nothing; I can't answer the second part yet.",
    );
  });

  it("names a failed first lookup and its failure class", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => { throw new ScoutToolError("QUERY_TIMEOUT", "timed out"); },
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
        ],
        scope,
      },
    });
    expect(result.message).toBe("I couldn't complete the first lookup (ranked taggers): it timed out.");
  });

  it("names an unsafe chain-step rejection", async () => {
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string() }),
          execute: async () => ({ users: [{ pubky: firstUser }] }),
        },
        get_user_tags: {
          parameters: z.object({ pubky: z.string() }),
          execute: async () => ({ error: "QUERY_REJECTED" }),
        },
      },
      plan: {
        kind: "chain",
        steps: [
          { id: "s1", action: { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } },
          { id: "s2", action: { kind: "template", tool: "get_user_tags", params: { pubky: { from_step: "s1", path: "users[0].pubky" } }, scope } },
        ],
        scope,
      },
    });
    expect(result.message).toBe(
      "I completed step 1 (ranked taggers) but step 2 (their tags) was rejected as unsafe; I can't answer the second part yet.",
    );
  });

  it("falls back from empty emerging topics to most-used tags", async () => {
    const out = await executeTrendingFallback({
      emergingTopics: async () => ({ topics: [] }),
      compose: async () => ({ tags: [{ label: "bitcoin", count: 4 }] }),
    });
    expect(out.summary).toContain("most used this week");
    expect(out.summary).not.toContain("rising");
  });

  it("executes bounded knowledge and web actions without Scout", async () => {
    const knowledge = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {},
      knowledge: {
        search: async (query, k) => ({
          audience: "public",
          chunks: [{ title: query, url: "https://docs.pubky.app/", source_id: "docs", corpus_version: "1", snippet: "Pubky docs" }],
          truncated: k === 6,
        }),
      },
      plan: { kind: "knowledge", query: "Explain Pubky", k: 6 },
    });
    const web = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {},
      webSearch: { search: async () => ({ results: [{ title: "Pubky", url: "https://pubky.app/", snippet: "Pubky" }] }) },
      plan: { kind: "web", query: "Pubky news", k: 5 },
    });
    expect(knowledge.tools).toEqual(["knowledge"]);
    expect(web.tools).toEqual(["web"]);
    expect(knowledge.scope.graph.kind).toBe("none");
    expect(web.scope.graph.kind).toBe("none");
  });

  it("blocks owner-context markers before knowledge or web retrieval", async () => {
    const queries: string[] = [];
    const ownerContext = "<owner_context>\nAbout: OWNER_MARKER_7X9 homeservers\n</owner_context>";
    const blockedQueries = [
      "OWNER_MARKER_7X9 homeservers",
      "ＯＷＮＥＲ＿ＭＡＲＫＥＲ＿７Ｘ９",
      "owner marker 7x9",
      "marker_7x9",
    ];
    for (const query of blockedQueries) {
      const blocked = await executeConversationalPlan({
        owner: firstUser,
        ownerContext,
        nowMs: scope.window.until_ms,
        meter: meter(),
        tools: {},
        knowledge: { search: async (value) => { queries.push(value); return {}; } },
        plan: { kind: "knowledge", query, k: 1 },
      });
      expect(blocked.message).toBe("I can't use your private notes in an outside search.");
    }
    const distinctive = await executeConversationalPlan({
      owner: firstUser,
      ownerContext: "<owner_context>\nAbout: My private constellation is nebula-7x9.\n</owner_context>",
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {},
      knowledge: { search: async (query) => { queries.push(query); return {}; } },
      plan: { kind: "knowledge", query: "constellation is nebula", k: 1 },
    });
    const benign = await executeConversationalPlan({
      owner: firstUser,
      ownerContext,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {},
      knowledge: { search: async (query) => { queries.push(query); return {}; } },
      plan: { kind: "knowledge", query: "homeservers", k: 1 },
    });
    expect(distinctive.message).toBe("I can't use your private notes in an outside search.");
    expect(queries).toEqual(["homeservers"]);
    expect(benign.tools).toEqual(["knowledge"]);
  });
});
