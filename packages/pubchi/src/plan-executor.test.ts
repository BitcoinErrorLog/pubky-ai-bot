import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeConversationalPlan, executeTrendingFallback } from "./plan-executor.js";
import { ScoutCallBudgetError, ScoutCallMeter } from "../bot-kit/scout/budget.js";

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
          execute: async () => { throw new Error("timeout"); },
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
      "I completed 1 of 2 steps (rank_users), but step s2 failed, so I can't answer the rest yet.",
    );
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
      "I completed 1 of 2 steps (rank_users), but step s2 failed, so I can't answer the rest yet.",
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
    const executedSince = 1_694_500_000_000;
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
      tools: {
        rank_users: {
          parameters: z.object({ metric: z.string(), time_range: z.object({ since: z.number(), until: z.number() }) }),
          execute: async () => ({ users: [] }),
        },
      },
      plan: {
        kind: "template",
        tool: "rank_users",
        params: { metric: "tags_applied", time_range: { since: executedSince, until: scope.window.until_ms } },
        scope: { ...scope, window: { ...scope.window, label: "MODEL LABEL", since_ms: 0 } },
      },
    });
    expect(result.scope.time).toEqual({
      since_ms: executedSince,
      until_ms: scope.window.until_ms,
      label: "execution window",
      source: "explicit",
    });
  });

  it("falls back from empty emerging topics to most-used tags", async () => {
    const out = await executeTrendingFallback({
      emergingTopics: async () => ({ topics: [] }),
      compose: async () => ({ tags: [{ label: "bitcoin", count: 4 }] }),
    });
    expect(out.summary).toContain("most used this week");
    expect(out.summary).not.toContain("rising");
  });
});
