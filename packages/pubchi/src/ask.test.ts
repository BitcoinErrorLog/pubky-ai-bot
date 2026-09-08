import { describe, expect, it } from "vitest";
import { parsePubchiAnswerV1 } from "@pubky/pubchi-schemas";
import { nlqResult } from "@pubky/bot-kit";
import { runAsk } from "./ask.js";
import { countingBrain, TEST_NOW, TEST_OWNER, testTenant } from "./test-helpers.js";

const OTHER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";

function nlq(owner: string) {
  return nlqResult({
    outcome: "ok",
    reason: "ok",
    intent: "research_pubky",
    planned: [{ tool: "get_tag_landscape", args: { tag: "bitcoin" } }],
    results: [
      {
        applications: [{ tagger_id: OTHER, target_id: owner, target_kind: "User", uri: `pubky://${owner}/` }],
        claims: [{ label: "bitcoin", count: 1, claimant_ids: [OTHER] }],
        truncated: false,
      },
    ],
  });
}

describe("runAsk", () => {
  it("forces the verified owner and returns a strict answer", async () => {
    const brain = countingBrain(() => JSON.stringify({ summary: "One user applied the bitcoin tag." }));
    const requests: { asker?: string; scope?: unknown }[] = [];
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "who tagged me?", asker: OTHER, scope: { graph_scope: { pubky: OTHER } } },
      now: TEST_NOW,
      runId: "run-test",
      nlq: async (request) => {
        requests.push(request);
        return nlq(TEST_OWNER);
      },
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(requests[0]).toMatchObject({ asker: TEST_OWNER, scope: { graph_scope: { pubky: TEST_OWNER } } });
    expect(parsePubchiAnswerV1(out.result).ok).toBe(true);
    expect(out.result.evidence.length).toBeGreaterThan(0);
  });

  it("falls back to a non-empty summary when the brain fails", async () => {
    const brain = countingBrain(() => {
      throw new Error("brain unavailable");
    });
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what is here?" },
      now: TEST_NOW,
      runId: "run-fallback",
      nlq: async () => nlq(TEST_OWNER),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.summary).toMatch(/graph shows/i);
  });

  it("drops unknown tool shapes instead of guessing evidence", async () => {
    const brain = countingBrain(() => JSON.stringify({ summary: "No usable evidence was returned." }));
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "unknown" },
      now: TEST_NOW,
      runId: "run-unknown",
      nlq: async () =>
        nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "research_pubky",
          planned: [{ tool: "get_tag_landscape", args: {} }],
          results: [{ unexpected: "shape" }],
        }),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.evidence).toEqual([]);
    expect(brain.calls).toBe(0);
  });

  it.each([
    ["prose wrapped JSON", 'Here is the answer:\n{"summary":"One user applied the bitcoin tag."}'],
    ["fenced JSON", '```json\n{"summary":"One user applied the bitcoin tag."}\n```'],
  ])("accepts %s brain output", async (_name, text) => {
    const brain = countingBrain(() => text);
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what is here?" },
      now: TEST_NOW,
      runId: `run-${_name.replace(/\s+/g, "-")}`,
      nlq: async () => nlq(TEST_OWNER),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.summary).toBe("One user applied the bitcoin tag.");
  });

  it("falls back for plain prose brain output", async () => {
    const brain = countingBrain(() => "One user applied the bitcoin tag.");
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what is here?" },
      now: TEST_NOW,
      runId: "run-plain-prose",
      nlq: async () => nlq(TEST_OWNER),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.summary).toMatch(/graph shows/i);
  });

  it("rejects plain prose and claims about an absent pubky", async () => {
    const brain = countingBrain(() => `{"summary":"${"y".repeat(52)} is the top user."}`);
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what is here?" },
      now: TEST_NOW,
      runId: "run-invalid-summary",
      nlq: async () => nlq(TEST_OWNER),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.summary).toMatch(/graph shows/i);
  });

  it("does not call the brain for empty evidence", async () => {
    const brain = countingBrain(() => '{"summary":"should not run"}');
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "who are the most followed users?" },
      now: TEST_NOW,
      runId: "run-empty-evidence",
      nlq: async () =>
        nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "research_pubky",
          planned: [{ tool: "rank_users", args: { metric: "followers" } }],
          results: [{ users: [] }],
        }),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    expect(brain.calls).toBe(0);
    if (out.ok) expect(out.result.summary).toMatch(/no usable evidence|found no/i);
  });
});
