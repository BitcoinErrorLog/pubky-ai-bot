import { describe, expect, it } from "vitest";
import { parseFeedProposalV1, PHASE0_BUDGETS } from "@pubky/pubchi-schemas";
import type { Brain } from "../bot-kit/brain/types.js";
import { estimateInputTokens, runFeed } from "./feed.js";
import { countingBrain, TEST_NOW, TWO_HOP_BITCOIN_FEED, testTenant } from "./test-helpers.js";

describe("runFeed", () => {
  const v2 = (overrides: Record<string, unknown> = {}) => ({
    name: "Bitcoin feed",
    icon: "bitcoin",
    feed: {
      tags: ["bitcoin"],
      domain_tags: ["technology"],
      reach: "all",
      sort: "recent",
      layout: "columns",
      ...overrides,
    },
    mapping: { status: "exact", unmapped: [] },
    warnings: [],
  });

  async function runV2(question: string, feed: Record<string, unknown> = {}) {
    const brain = countingBrain(() => JSON.stringify(v2(feed)));
    const out = await runFeed({
      tenant: testTenant(),
      body: { question, proposal_version: 2 },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected v2 proposal");
    return out.result;
  }

  it.each([
    ["tags", "bitcoin energy", { tags: ["bitcoin", "energy"] }],
    ["domain tags", "technology domain", { domain_tags: ["technology"] }],
    ["following reach", "following reach", { reach: "following" }],
    ["followers reach", "followers reach", { reach: "followers" }],
    ["friends reach", "friends reach", { reach: "friends" }],
    ["all reach", "all reach", { reach: "all" }],
    ["wot reach", "wot reach", { reach: "wot" }],
    ["me reach", "me reach", { reach: "me" }],
    ["recent sort", "recent sort", { sort: "recent" }],
    ["popularity sort", "popularity sort", { sort: "popularity" }],
    ["columns layout", "columns layout", { layout: "columns" }],
    ["wide layout", "wide layout", { layout: "wide" }],
    ["visual layout", "visual layout", { layout: "visual" }],
    ["list layout", "list layout", { layout: "list" }],
    ["short content", "short content", { content: "short" }],
    ["long content", "long content", { content: "long" }],
    ["image content", "image content", { content: "image" }],
    ["video content", "video content", { content: "video" }],
    ["link content", "link content", { content: "link" }],
    ["file content", "file content", { content: "file" }],
    ["collection content", "collection content", { content: "collection" }],
  ])("accepts %s", async (_label, question, feed) => {
    const result = await runV2(question, feed);
    expect(result.version).toBe(2);
  });

  it("omits content for all content and preserves name/icon", async () => {
    const result = await runV2("all content", { content: undefined });
    expect(result).toMatchObject({ version: 2, feed: { name: "Bitcoin feed", icon: "bitcoin" } });
    expect(result.feed.feed.content).toBeUndefined();
  });

  it("marks likes unsupported with the exact capability copy", async () => {
    const result = await runV2("sort by likes", { sort: "recent" });
    expect(result.mapping.status).toBe("unsupported");
    expect(result.mapping.unmapped).toContainEqual(expect.objectContaining({
      reason: "likes_unavailable",
      suggestion: "Feeds can’t filter or sort by likes because Pubky does not model likes. Closest options: Popularity (bookmarks/reposts/replies) or Recent.",
    }));
  });

  it("flags followers reach even when the model emits it", async () => {
    const result = await runV2("followers reach", { reach: "followers" });
    expect(result.mapping.status).toBe("unsupported");
    expect(result.mapping.unmapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "followers_not_authorable" }),
    ]));
  });

  it("flags unknown content", async () => {
    const result = await runV2("unknown content", { content: "unknown" });
    expect(result.mapping.status).toBe("unsupported");
    expect(result.mapping.unmapped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "unknown_content" }),
    ]));
  });

  it("uses an App-provided feed id only for update mode", async () => {
    const brain = countingBrain(() => JSON.stringify(v2({ reach: "friends" })));
    const out = await runFeed({
      tenant: testTenant(),
      body: {
        question: "change this to friends",
        proposal_version: 2,
        target_feed_id: "feed_123",
        current_feed: { name: "Bitcoin feed", reach: "all" },
      },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toMatchObject({ mode: "update", target_feed_id: "feed_123" });
  });

  it("keeps v1 behavior when proposal version is absent", async () => {
    const brain = countingBrain(() => JSON.stringify(TWO_HOP_BITCOIN_FEED));
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "make a bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.version).toBe(1);
  });

  it("settles both v2 attempts after retry failure", async () => {
    const brain = countingBrain(() => "not json");
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "make a feed", proposal_version: 2 },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: false, code: "FEED_SPECS_INVALID" });
    expect(brain.calls).toBe(2);
    if (!out.ok) expect(out.settlementTokens).toBeGreaterThan(1);
  });

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
    expect(brain.lastMaxOutputTokens).toBe(1200);
    expect(brain.lastProviderOptions).toEqual({ moonshot: { thinking: { type: "disabled" } } });
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

  it("maps people tagged bitcoin and synonym to posts tagged both", async () => {
    let systemPrompt = "";
    let userPrompt = "";
    const brain: Brain = {
      capabilities: {
        name: "mock",
        providerId: "mock",
        supportsTools: false,
        maxContextTokens: 1024,
        samplingDefaults: { temperature: 1 },
      },
      temperature: 1,
      generate: async (args) => {
        systemPrompt = String(args.messages.find((message) => message.role === "system")?.content ?? "");
        userPrompt = String(args.messages.find((message) => message.role === "user")?.content ?? "");
        return {
          text: JSON.stringify({
        feed: {
          tags: ["bitcoin", "synonym"],
          domain_tags: [],
          reach: "all",
          layout: "columns",
          sort: "recent",
          content: "short",
        },
        name: "Posts tagged bitcoin or synonym",
          }),
          response: { messages: [] },
        };
      },
    };
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "Build feed with all the people tagged bitcoin and all the people tagged synonym" },
      now: TEST_NOW,
      brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.feed.feed.tags).toEqual(["bitcoin", "synonym"]);
      expect(out.result.feed.name.toLowerCase()).toContain("posts");
    }
    expect(systemPrompt).toContain("A Pubky feed is a feed of POSTS");
    expect(userPrompt).toContain("all the people tagged bitcoin and all the people tagged synonym");
  });

  it("retries an invalid first response with its validation cause", async () => {
    let calls = 0;
    const telemetry: string[] = [];
    const brain = countingBrain(() => {
      calls += 1;
      return calls === 1 ? "{\"feed\":{\"tags\":[]}}" : JSON.stringify(TWO_HOP_BITCOIN_FEED);
    });
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "make a bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
      telemetry: { increment: (name, labels) => telemetry.push(`${name}:${labels?.cause ?? ""}`) },
    });
    expect(out.ok).toBe(true);
    expect(brain.calls).toBe(2);
    expect(brain.lastPrompt).toContain("Validation error: schema");
    expect(telemetry).toEqual(["feed_retry:"]);
  });

  it("returns FEED_SPECS_INVALID after two invalid responses", async () => {
    const telemetry: string[] = [];
    const brain = countingBrain(() => "not json");
    const out = await runFeed({
      tenant: testTenant(),
      body: { question: "make a bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
      telemetry: { increment: (name, labels) => telemetry.push(`${name}:${labels?.cause ?? ""}`) },
    });
    expect(out).toMatchObject({ ok: false, code: "FEED_SPECS_INVALID", stage: "feed", cause: "json_parse" });
    expect(brain.calls).toBe(2);
    expect(telemetry).toEqual(["feed_retry:", "feed_cause:json_parse"]);
  });

  it("does not exceed the wall-clock budget across retry", async () => {
    const brain = countingBrain(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "not json";
    });
    const started = performance.now();
    const out = await runFeed({
      tenant: testTenant({ budgets: { ...testTenant().budgets, per_request_wall_clock_ms: 20 } }),
      body: { question: "make a bitcoin feed" },
      now: TEST_NOW,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: false, code: "BRAIN_UNAVAILABLE", cause: "brain_throw" });
    expect(performance.now() - started).toBeLessThan(100);
    expect(brain.calls).toBe(1);
  });
});
