import { describe, expect, it } from "vitest";
import { renderExecutionScope, runAsk } from "./ask.js";
import { countingBrain, TEST_NOW, TEST_OWNER, testTenant } from "./test-helpers.js";
import { nlqResult } from "../bot-kit/nlq/types.js";

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
    if (out.ok) expect(out.result.summary).toBe("The answer is Ada (7).");
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
});
