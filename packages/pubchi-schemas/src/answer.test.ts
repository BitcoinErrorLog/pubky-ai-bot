import { describe, expect, it } from "vitest";
import { isCanonicalPublicEvidenceUri, parsePubchiAnswerV1, PUBLIC_EVIDENCE_URI_MAX_LENGTH } from "./answer.js";
import { isPubkyId } from "./pubky.js";

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
  describe("canonical public evidence URIs", () => {
    it("accepts a deep public path", () => {
      expect(isCanonicalPublicEvidenceUri(`pubky://${OWNER}/pub/app.pubchi/v1/evidence/deep.json`)).toBe(true);
    });

    it("rejects a charset-valid but roundtrip-invalid id", () => {
      const id = "b".repeat(52);
      expect(isPubkyId(id)).toBe(false);
      expect(isCanonicalPublicEvidenceUri(`pubky://${id}/pub/app.pubchi/v1/evidence.json`)).toBe(false);
    });

    it.each([
      ["query", `pubky://${OWNER}/pub/app.pubchi/v1/evidence.json?x=1`],
      ["fragment", `pubky://${OWNER}/pub/app.pubchi/v1/evidence.json#frag`],
      ["dot-dot segment", `pubky://${OWNER}/pub/a/../b`],
      ["double slash", `pubky://${OWNER}/pub/a//b`],
      ["trailing slash", `pubky://${OWNER}/pub/a/`],
      ["percent encoding", `pubky://${OWNER}/pub/a%2Fb`],
      ["backslash", `pubky://${OWNER}/pub/a\\b`],
      ["whitespace", `pubky://${OWNER}/pub/a b`],
      ["control character", `pubky://${OWNER}/pub/a\u0000b`],
      ["dot segment", `pubky://${OWNER}/pub/a/./b`],
      ["private path", `pubky://${OWNER}/priv/app.pubchi/v1/evidence.json`],
    ])("rejects a %s", (_name, uri) => {
      expect(isCanonicalPublicEvidenceUri(uri)).toBe(false);
    });

    it("enforces the existing URI cap", () => {
      const prefix = `pubky://${OWNER}/pub/`;
      expect(isCanonicalPublicEvidenceUri(`${prefix}${"a".repeat(PUBLIC_EVIDENCE_URI_MAX_LENGTH - prefix.length)}`)).toBe(true);
      expect(isCanonicalPublicEvidenceUri(`${prefix}${"a".repeat(PUBLIC_EVIDENCE_URI_MAX_LENGTH - prefix.length + 1)}`)).toBe(false);
    });
  });

  it("accepts the strict C5 suggestion section", () => {
    const target = `pubky://${OWNER}/pub/pubky.app/profile.json`;
    expect(parsePubchiAnswerV1(answer({
      section: "tag_suggestions",
      target: { kind: "user", uri: target, snapshot_sha256: "a".repeat(64) },
      tag_suggestions: [{
        label: "lightning-wallets",
        rationale: "Matches the public target.",
        evidence: [target],
        already_applied: false,
        source: "vocab",
      }],
    })).ok).toBe(true);
  });

  it("accepts public evidence from another app namespace and rejects private or non-Pubky evidence", () => {
    const target = `pubky://${OWNER}/pub/pubky.app/profile.json`;
    const otherPublic = `pubky://${OWNER}/pub/app.pubchi/v1/evidence.json`;
    const suggestion = { label: "lightning-wallets", rationale: "x", evidence: [otherPublic], already_applied: false, source: "vocab" as const };
    const base = {
      section: "tag_suggestions",
      target: { kind: "user" as const, uri: target, snapshot_sha256: "a".repeat(64) },
      evidence: [{ ...answer().evidence[0], uri: otherPublic }],
      tag_suggestions: [suggestion],
    };
    expect(parsePubchiAnswerV1(answer(base)).ok).toBe(true);
    expect(parsePubchiAnswerV1(answer({
      ...base,
      evidence: [{ ...answer().evidence[0], uri: `pubky://${OWNER}/priv/app.pubchi/v1/evidence.json` }],
      tag_suggestions: [{ ...suggestion, evidence: [`pubky://${OWNER}/priv/app.pubchi/v1/evidence.json`] }],
    })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({
      ...base,
      evidence: [{ ...answer().evidence[0], uri: "https://example.com/evidence.json" }],
      tag_suggestions: [{ ...suggestion, evidence: ["https://example.com/evidence.json"] }],
    })).ok).toBe(false);
  });

  it("rejects partial C5 fields, duplicate labels, and null snapshots with suggestions", () => {
    const target = `pubky://${OWNER}/pub/pubky.app/profile.json`;
    const suggestion = { label: "lightning-wallets", rationale: "x", evidence: [target], already_applied: false, source: "vocab" as const };
    expect(parsePubchiAnswerV1(answer({ section: "tag_suggestions" })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({
      section: "tag_suggestions",
      target: { kind: "user", uri: target, snapshot_sha256: "a".repeat(64) },
      tag_suggestions: [suggestion, { ...suggestion }],
    })).ok).toBe(false);
    expect(parsePubchiAnswerV1(answer({
      section: "tag_suggestions",
      target: { kind: "user", uri: target, snapshot_sha256: null },
      tag_suggestions: [suggestion],
    })).ok).toBe(false);
  });

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

  it("accepts additive provenance fields", () => {
    expect(parsePubchiAnswerV1(answer({
      basis: "knowledge",
      scope: { time: null, graph: { kind: "none" }, filters: [], complete: true },
      citations: [{ kind: "knowledge", title: "Pubky docs", url: "https://docs.pubky.org/guide" }],
    })).ok).toBe(true);
    expect(parsePubchiAnswerV1(answer({
      basis: "mixed",
      scope: { time: null, graph: { kind: "whole_graph" }, filters: [], complete: true },
    })).ok).toBe(true);
    expect(parsePubchiAnswerV1(answer({
      basis: "web",
      scope: { time: null, graph: { kind: "none" }, filters: [], complete: true },
      citations: [{ kind: "web", title: "News", url: "https://example.com/news" }],
    })).ok).toBe(true);
  });

  it.each([
    { basis: "knowledge", scope: { time: null, graph: { kind: "whole_graph" }, filters: [], complete: true } },
    { basis: "web", scope: { time: null, graph: { kind: "whole_graph" }, filters: [], complete: true } },
    { basis: "model", scope: { time: null, graph: { kind: "none" }, filters: [], complete: true }, citations: [{ kind: "web", title: "Invented", url: "https://example.com" }] },
    { basis: "model", scope: { time: null, graph: { kind: "none" }, filters: [], complete: true }, citations: [{ kind: "knowledge", title: "Bad", url: "javascript:alert(1)" }] },
  ])("rejects provenance invariant %#", (override) => {
    expect(parsePubchiAnswerV1(answer(override)).ok).toBe(false);
  });

  it.each([
    { scope: { time: null, graph: { kind: "whole_graph", hops: 4 }, filters: [], complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: ["x".repeat(161)], complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: Array.from({ length: 11 }, () => "x"), complete: true } },
    { scope: { time: null, graph: { kind: "whole_graph" }, filters: [], complete: true, extra: true } },
  ])("rejects malformed scope %#", (override) => {
    expect(parsePubchiAnswerV1(answer(override)).ok).toBe(false);
  });
});
