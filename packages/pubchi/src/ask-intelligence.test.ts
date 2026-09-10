import { describe, expect, it, vi } from "vitest";
import { renderExecutionScope, runAsk } from "./ask.js";
import { countingBrain, TEST_NOW, TEST_OWNER, testTenant } from "./test-helpers.js";
import { nlqResult } from "../bot-kit/nlq/types.js";
import { log } from "../bot-kit/log.js";

const USER = TEST_OWNER;

function rankedResult() {
  return nlqResult({
    outcome: "ok",
    reason: "ok",
    intent: "research_pubky",
    planned: [{ tool: "rank_users", args: { metric: "followers" } }],
    results: [{ users: [{ pubky: USER, name: "Ada", followers: 7 }] }],
  });
}

describe("Pubchi ask intelligence", () => {
  it("emits source sections only for what-did-i-miss evidence", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what did I miss?" },
      now: TEST_NOW,
      runId: "sections",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "what_did_i_miss",
        planned: [{ tool: "get_what_did_i_miss", args: { since: TEST_NOW - 86_400_000, until: TEST_NOW } }],
        results: [{
          posts: [{ author_id: USER, author_name: "Ada", content: "post", post_id: "ABCDEFGHIJKLM" }],
          replies: [{ author_id: USER, author_name: "Ada", content: "reply", post_id: "ABCDEFGHIJKLM" }],
          tags: [{ author_id: USER, author_name: "Ada", content: "tag" }],
        }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => JSON.stringify({ summary: "Summary." })).brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.evidence.map((item) => item.section)).toEqual([
        "followed_posts",
        "replies_to_you",
        "tags_on_you",
      ]);
    }
  });

  it("omits source sections on non-C3 routes", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "no-sections",
      nlq: async () => rankedResult(),
      nlqOpts: {} as never,
      brain: countingBrain(() => JSON.stringify({ summary: "Summary." })).brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.evidence.every((item) => item.section === undefined)).toBe(true);
  });

  it("returns the exact Scout-timeout copy", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "scout-timeout",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "No answer was inferred",
        intent: "research_pubky",
        planned: [],
        results: [],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => "unused").brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.summary).toBe(
        "The graph lookup timed out before I had enough evidence. No answer was inferred. Try a smaller window or scope.",
      );
      expect(out.result.scope?.complete).toBe(false);
    }
  });

  it("returns the exact empty-valid-result copy", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "empty-result",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "rank_users", args: {} }],
        results: [{ users: [] }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => "unused").brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).toContain("I looked at rank_users and found no usable evidence");
  });

  it("keeps deterministic evidence and scope when summary generation fails", async () => {
    const brain = countingBrain(async () => { throw new Error("summary failed"); });
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "summary-failure",
      nlq: async () => rankedResult(),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.summary).toContain("The users in this result are Ada (7)");
      expect(out.result.summary).toContain("last 30 days");
    }
  });

  it("redacts question, context, rationale, and Cypher from pubchi_ask telemetry", async () => {
    const info = vi.spyOn(log, "info");
    const question = "PRIVATE QUESTION TEXT";
    const ownerContext = { instructions: "PRIVATE OWNER CONTEXT" };
    const out = await runAsk({
      tenant: testTenant(),
      body: { question },
      now: TEST_NOW,
      runId: "telemetry-redaction",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "answer",
        planned: [{ tool: "query_graph", args: { cypher: "MATCH (u:User) RETURN u LIMIT 1", rationale: "PRIVATE RATIONALE" } }],
        results: [{ results: [] }],
        brainTokens: 13,
      }),
      nlqOpts: {} as never,
      ownerContext,
      brain: countingBrain(() => "unused").brain,
    });
    expect(out.ok).toBe(true);
    const record = info.mock.calls.find(([value]) => (value as { event?: string }).event === "pubchi_ask")?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      plan_kind: "template",
      tools: ["query_graph"],
      chain_len: 0,
      repair_reason: null,
      scope_kind: "whole_graph",
      window_days: expect.any(Number),
      meter_calls: 1,
      meter_ms: expect.any(Number),
      tenant_param_rejected: 0,
      planner_tokens: 13,
      query_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      brain_prompt_tokens: null,
      brain_completion_tokens: null,
      brain_reasoning_tokens: null,
      budget_settled: 13,
    });
    expect(JSON.stringify(record)).not.toContain(question);
    expect(JSON.stringify(record)).not.toContain(ownerContext.instructions);
    expect(JSON.stringify(record)).not.toContain("PRIVATE RATIONALE");
    expect(JSON.stringify(record)).not.toContain("MATCH (u:User)");
  });

  it("settles planner and style usage together", async () => {
    const brain = {
      temperature: 0.6,
      capabilities: { name: "usage", providerId: "usage", supportsTools: false, maxContextTokens: 4000, samplingDefaults: { temperature: 0.6 } },
      generate: async () => ({ text: JSON.stringify({ summary: "The answer is Ada (7)." }), usage: { totalTokens: 11 } }),
    } as never;
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "settlement-sum",
      nlq: async () => ({ ...rankedResult(), brainTokens: 7 }),
      nlqOpts: {} as never,
      ownerContext: { instructions: "Use a calm tone." },
      brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.settlementTokens).toBe(18);
  });

  it("runs and accepts the bounded owner-context style pass", async () => {
    const brain = countingBrain(() => JSON.stringify({ summary: "The answer is Ada (7)." }));
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "style-accepted",
      nlq: async () => rankedResult(),
      nlqOpts: {} as never,
      ownerContext: { instructions: "Use a calm tone." },
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    expect(brain.calls).toBe(1);
    if (out.ok) expect(out.result.summary).toBe("The answer is Ada (7). (in the last 30 days across the whole graph).");
    expect(brain.lastMaxOutputTokens).toBe(250);
  });

  it("rejects a style pass that changes evidence counts", async () => {
    const brain = countingBrain(() => JSON.stringify({ summary: "Ada has 999 followers." }));
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "style-rejected",
      nlq: async () => rankedResult(),
      nlqOpts: {} as never,
      ownerContext: { instructions: "Use a calm tone." },
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).toContain("Ada (7)");
  });

  it("renders metadata scopes and ignores model labels", () => {
    expect(renderExecutionScope({
      time: { since_ms: Date.UTC(2026, 8, 3), until_ms: Date.UTC(2026, 8, 10) },
      graph: { kind: "whole_graph" },
    })).toBe("Scope: last 7 days (Sep 3–10 UTC), whole graph.");
    expect(renderExecutionScope({
      time: { since_ms: Date.UTC(2026, 8, 3), until_ms: Date.UTC(2026, 8, 10) },
      graph: { kind: "owner_network", hops: 2 },
    })).toContain("your 2-hop network");
    expect(renderExecutionScope({ time: null, graph: { kind: "none" } })).toBe("Scope: no graph lookup.");
  });

  it("renders owner scope for owner-tag evidence", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "hi, who tagged me?" },
      now: TEST_NOW,
      runId: "owner-tags-scope",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "get_user_tags", args: { pubky: USER } }],
        results: [{ pubky: USER, tags: [] }],
        scope: {
          time: null,
          graph: { kind: "owner_network", hops: 1 },
          filters: [],
          complete: true,
        },
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => "unused").brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.scope.graph.kind).toBe("owner_network");
      expect(out.result.summary).not.toContain("whole graph");
    }
  });
});
