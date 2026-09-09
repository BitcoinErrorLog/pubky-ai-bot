import { describe, expect, it } from "vitest";
import { parseFeedProposalV1, PHASE0_BUDGETS } from "@pubky/pubchi-schemas";
import { estimateInputTokens, runFeed } from "./feed.js";
import { countingBrain, TEST_NOW, TWO_HOP_BITCOIN_FEED, testTenant } from "./test-helpers.js";

describe("runFeed", () => {
  it("overwrites model-supplied created_at with server now", async () => {
    const brain = countingBrain(() =>
      JSON.stringify({ ...TWO_HOP_BITCOIN_FEED, created_at: 1_750_000_000 }),
    );
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "make a two-hop bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const parsed = parseFeedProposalV1(out.result);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.feed.created_at).toBe(TEST_NOW);
    expect(brain.lastMaxOutputTokens).toBe(300);
  });

  it("rejects a question over the per-request input budget before calling the brain", async () => {
    const brain = countingBrain(() => JSON.stringify(TWO_HOP_BITCOIN_FEED));
    const question = "x".repeat(PHASE0_BUDGETS.per_request_input_tokens * 4 + 4);
    expect(estimateInputTokens(question)).toBeGreaterThan(PHASE0_BUDGETS.per_request_input_tokens);
    const out = await runFeed({
      tenant: testTenant(),
      body: { question },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: false, code: "SCHEMA_INVALID", cause: "input_tokens" });
    expect(brain.calls).toBe(0);
  });

  it("keeps the feed prompt byte-identical when owner context is absent", async () => {
    const brain = countingBrain(() => JSON.stringify(TWO_HOP_BITCOIN_FEED));
    const question = "make a two-hop bitcoin feed";
    const out = await runFeed({
      tenant: testTenant(),
      body: { question },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    expect(brain.lastPrompt).toBe(question);
  });

  it("includes owner context in the proposal prompt", async () => {
    const brain = countingBrain(() => JSON.stringify(TWO_HOP_BITCOIN_FEED));
    const out = await runFeed({
      tenant: testTenant(),
      ownerContext: { about: "Portuguese community", instructions: "Use a calm tone." },
      body: { question: "make a two-hop bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    expect(brain.lastPrompt).toContain("Portuguese community");
    expect(brain.lastPrompt).toContain("Use a calm tone.");
  });
});
