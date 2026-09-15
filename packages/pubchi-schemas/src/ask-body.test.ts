import { describe, expect, it } from "vitest";
import { parseAskBody } from "./ask-body.js";

const turns = Array.from({ length: 8 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  text: `${index} ${"🙂".repeat(20)}`,
}));

describe("AskBody conversation", () => {
  it("accepts the optional canonical C5 target", () => {
    expect(parseAskBody({
      question: "Suggest tags for this post",
      target: { kind: "post", uri: `pubky://${"b".repeat(52)}/pub/pubky.app/posts/0035NV17R994G` },
    }).ok).toBe(true);
  });

  it("rejects a C5 target with a mismatched kind or path", () => {
    const uri = `pubky://${"b".repeat(52)}/pub/pubky.app/posts/0035NV17R994G`;
    expect(parseAskBody({ target: { kind: "user", uri } }).ok).toBe(false);
    expect(parseAskBody({ target: { kind: "post", uri: `${uri}/` } }).ok).toBe(false);
  });

  it("accepts an alternating eight-turn Unicode window", () => {
    expect(parseAskBody({ question: "and last month?", conversation: { turns } }).ok).toBe(true);
  });

  it("rejects more than eight turns", () => {
    expect(parseAskBody({ conversation: { turns: [...turns, { role: "user", text: "again" }] } }).ok).toBe(false);
  });

  it("rejects non-alternating turns", () => {
    expect(parseAskBody({ conversation: { turns: turns.map((turn, index) => index === 1 ? { ...turn, role: "user" } : turn) } }).ok).toBe(false);
  });

  it("measures turn length in Unicode code points", () => {
    expect(parseAskBody({ conversation: { turns: [{ role: "user", text: "🙂".repeat(601) }] } }).ok).toBe(false);
  });

  it("rejects a window over 4800 code points", () => {
    const oversized = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: "🙂".repeat(600),
    }));
    expect(parseAskBody({ conversation: { turns: [...oversized, { role: "user", text: "🙂" }] } }).ok).toBe(false);
  });

  it("does not tighten unrelated ask body keys", () => {
    expect(parseAskBody({ question: "hello", context: { future: true }, proposal_version: 2 }).ok).toBe(true);
  });
});
