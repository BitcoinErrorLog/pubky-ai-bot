import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeConversationalPlan, executeTrendingFallback } from "./plan-executor.js";

const scope = {
  window: { since_ms: 1_694_000_000_000, until_ms: 1_694_604_800_000, source: "explicit" as const, label: "last 7 days" },
  graph: { kind: "whole_graph" as const },
};
const firstUser = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u";

function meter(opts: { calls?: number; ms?: number; abort?: boolean } = {}) {
  let calls = opts.calls ?? 0;
  let scoutMs = opts.ms ?? 0;
  return {
    record(durationMs: number) { calls += 1; scoutMs += durationMs; },
    assertBudget() {
      if (opts.abort || calls > 10 || scoutMs > 20_000) throw new Error("SCOUT_TIME_CAP");
    },
    snapshot: () => ({ calls, scoutMs }),
  };
}

describe("typed plan executor", () => {
  it("resolves the top tagger reference into composed Cypher", async () => {
    const captured: Record<string, unknown> = {};
    const result = await executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter(),
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
    expect(result.message).toBe("I found the top tagger, but the follow-up tag lookup timed out; I can't answer the second part yet.");
  });

  it("aborts at the call and time meter boundaries", async () => {
    const plan = { kind: "template", tool: "rank_users", params: { metric: "tags_applied" }, scope } as const;
    await expect(executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter({ calls: 10 }),
      tools: {
        rank_users: { parameters: z.object({ metric: z.string() }), execute: async () => ({ users: [] }) },
      },
      plan,
    })).rejects.toThrow("SCOUT_TIME_CAP");
    await expect(executeConversationalPlan({
      owner: firstUser,
      nowMs: scope.window.until_ms,
      meter: meter({ ms: 20_001 }),
      tools: {
        rank_users: { parameters: z.object({ metric: z.string() }), execute: async () => ({ users: [] }) },
      },
      plan,
    })).rejects.toThrow("SCOUT_TIME_CAP");
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
