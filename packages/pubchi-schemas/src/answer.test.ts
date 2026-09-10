import { describe, expect, it } from "vitest";
import { parsePubchiAnswerV1 } from "./answer.js";

const OWNER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";

function answer(overrides: Record<string, unknown> = {}) {
  return {
    schema: "pubchi-answer",
    version: 1,
    bot: OWNER,
    owner: OWNER,
    generated_at: 1,
    run_id: "run-test",
    purpose: "ask",
    question: "what is here?",
    summary: "The graph contains one user.",
    evidence: [
      {
        kind: "user",
        label: "user",
        uri: `pubky://${OWNER}/pub/pubky.app/profile.json`,
        claimants: [],
        claimant_count: 0,
        in_your_graph: null,
      },
    ],
    sources: [`pubky://${OWNER}/pub/pubky.app/profile.json`],
    tool_trace_summary: { tools: ["profile_card"], call_count: 1, truncated: false },
    policy_version: 1,
    ...overrides,
  };
}

describe("PubchiAnswerV1", () => {
  it("accepts a valid strict answer", () => {
    expect(parsePubchiAnswerV1(answer()).ok).toBe(true);
  });

  it("rejects unknown and forbidden fields", () => {
    expect(parsePubchiAnswerV1(answer({ extra: true })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({ verdict: "true" })).ok).toBe(false);
  });

  it("rejects oversized evidence and claimants", () => {
    const item = answer().evidence[0];
    expect(parsePubchiAnswerV1(answer({ evidence: Array.from({ length: 51 }, () => item) })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({ evidence: [{ ...item, claimants: Array.from({ length: 11 }, () => OWNER) }] })).ok).toBe(false);
  });

  it("rejects an invalid URI and summary", () => {
    const item = answer().evidence[0];
    expect(parsePubchiAnswerV1(answer({ evidence: [{ ...item, uri: "https://example.com/not-pubky" }] })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({ summary: "x".repeat(1201) })).ok).toBe(false);
  });

  it("accepts the optional continuation cursor", () => {
    expect(parsePubchiAnswerV1(answer({
      continuation: {
        since: "2026-09-09T20:00:00Z",
        until: "2026-09-10T00:00:00Z",
        complete: true,
        skipped: 0,
      },
    })).ok).toBe(true);
  });

  it.each(["followed_posts", "replies_to_you", "tags_on_you"] as const)("accepts evidence section %s", (section) => {
    expect(parsePubchiAnswerV1(answer({
      evidence: [{ ...answer().evidence[0], section }],
    })).ok).toBe(true);
  });

  it("rejects an unknown evidence section", () => {
    expect(parsePubchiAnswerV1(answer({
      evidence: [{ ...answer().evidence[0], section: "unknown" }],
    })).ok).toBe(false);
  });

  it("rejects malformed continuation fields", () => {
    expect(parsePubchiAnswerV1(answer({
      continuation: {
        since: "2026-09-09T20:00:00Z",
        until: "2026-09-10T00:00:00Z",
        complete: true,
        skipped: 0,
        extra: true,
      },
    })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({
      continuation: {
        since: "yesterday",
        until: "2026-09-10T00:00:00Z",
        complete: true,
        skipped: 0,
      },
    })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({
      continuation: {
        since: "2026-09-09T20:00:00Z",
        until: "2026-09-10T00:00:00Z",
        complete: "true",
        skipped: 0,
      },
    })).ok).toBe(false);
  });

  it.each(["explicit", "default", "tool"] as const)("accepts scope source %s", (source) => {
    expect(parsePubchiAnswerV1(answer({
      scope: {
        time: { since_ms: 1, until_ms: 2, label: "last day", source },
        graph: { kind: "whole_graph" },
        filters: [],
        complete: true,
      },
    })).ok).toBe(true);
  });

  it("accepts a no-lookup scope", () => {
    expect(parsePubchiAnswerV1(answer({
      scope: {
        time: null,
        graph: { kind: "none" },
        filters: [],
        complete: true,
      },
    })).ok).toBe(true);
  });

  it.each([
    { scope: { time: null, graph: { kind: "whole_graph", hops: 4 }, filters: [], complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: ["x".repeat(61)], complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: Array.from({ length: 11 }, () => "x"), complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: [], complete: true, extra: true } },
  ])("rejects malformed scope %#", (override) => {
    expect(parsePubchiAnswerV1(answer(override)).ok).toBe(false);
  });
});
