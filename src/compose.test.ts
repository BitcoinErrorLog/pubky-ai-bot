import { describe, expect, it } from "vitest";
import { composeReply, DEEP_HINT, truncateAtSentence } from "./compose.js";
import { parseModes } from "./modes.js";

describe("mode parsing (natural phrasing)", () => {
  it("parses short/deep/sources", () => {
    expect([...parseModes("give me a deep answer with sources")]).toEqual(expect.arrayContaining(["deep", "sources"]));
    expect(parseModes("tldr please").has("short")).toBe(true);
  });

  it("accepts natural phrasing for each mode", () => {
    expect(parseModes("keep it short").has("short")).toBe(true);
    expect(parseModes("be brief").has("short")).toBe(true);
    expect(parseModes("go deep on this").has("deep")).toBe(true);
    expect(parseModes("explain in depth").has("deep")).toBe(true);
    expect(parseModes("long form please").has("deep")).toBe(true);
    expect(parseModes("sources please").has("sources")).toBe(true);
    expect(parseModes("show me your sources").has("sources")).toBe(true);
    expect(parseModes("cite your claims").has("sources")).toBe(true);
  });

  it("parses just-Pubky phrasing as pubky_only", () => {
    expect(parseModes("just the Pubky part").has("pubky_only")).toBe(true);
    expect(parseModes("just Pubky").has("pubky_only")).toBe(true);
    expect(parseModes("pubky only").has("pubky_only")).toBe(true);
    expect(parseModes("only the Pubky network").has("pubky_only")).toBe(true);
    expect(parseModes("what does the web say").has("pubky_only")).toBe(false);
  });

  it("defaults to short when no mode phrase is present", () => {
    expect(parseModes("how do homeservers work?").has("short")).toBe(true);
  });
});

describe("compact composition", () => {
  it("caps short replies at 2000 and deep at 50000", () => {
    const short = composeReply("a".repeat(3000), parseModes("short"), []);
    expect(short.content.length).toBeLessThanOrEqual(2000);
    expect(short.long).toBe(false);
    const deep = composeReply("b".repeat(3000), parseModes("deep"), []);
    expect(deep.long).toBe(true);
    expect(deep.content).toHaveLength(3000);
  });

  it("truncates non-deep overflow at a sentence boundary with the deep hint", () => {
    const sentence = "PKARR publishes keys as DNS packets. ";
    const body = sentence.repeat(60).trim();
    const out = composeReply(body, parseModes("short"), []);
    expect(out.long).toBe(false);
    expect(out.content.length).toBeLessThanOrEqual(2000);
    expect(out.content.endsWith(DEEP_HINT)).toBe(true);
    const head = out.content.slice(0, out.content.length - DEEP_HINT.length).trimEnd();
    expect(head.endsWith(".")).toBe(true);
  });

  it("hard-cuts when there is no sentence boundary", () => {
    const out = truncateAtSentence("x".repeat(3000), 2000, DEEP_HINT);
    expect(out.length).toBe(2000);
    expect(out.endsWith(DEEP_HINT)).toBe(true);
  });

  it("publishes one long post in deep mode instead of a chain", () => {
    const body = "Detailed answer. ".repeat(400).trim();
    const out = composeReply(body, parseModes("go deep"), []);
    expect(out.long).toBe(true);
    expect(out.content.length).toBeGreaterThan(2000);
    expect(out.content.length).toBeLessThanOrEqual(50_000);
  });
});

describe("composition voice linting", () => {
  it("strips canned-enthusiasm openers and records the violation", () => {
    const out = composeReply("Great question! PKARR is the naming layer.", parseModes("short"), []);
    expect(out.content).toBe("PKARR is the naming layer.");
    expect(out.violations.map((v) => v.rule)).toContain("forbidden_opener");
  });

  it("caps inline citations at 3 in a short reply", () => {
    const id = "a".repeat(52);
    const body = [1, 2, 3, 4].map((i) => `pubky://${id}/pub/pubky.app/posts/000000000000${i}`).join(" ");
    const out = composeReply(`Evidence: ${body}`, parseModes("short"), []);
    expect((out.content.match(/pubky:\/\//g) ?? []).length).toBe(3);
  });

  it("allows up to 8 citations in sources mode", () => {
    const id = "a".repeat(52);
    const body = [1, 2, 3, 4, 5].map((i) => `pubky://${id}/pub/pubky.app/posts/000000000000${i}`).join(" ");
    const out = composeReply(`Evidence: ${body}`, parseModes("sources please"), []);
    expect((out.content.match(/pubky:\/\//g) ?? []).length).toBe(5);
  });
});
