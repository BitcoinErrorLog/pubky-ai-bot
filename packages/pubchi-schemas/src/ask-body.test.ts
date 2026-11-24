import { describe, expect, it } from "vitest";
import { AskBodySchema, parseAskBody } from "./ask-body.js";

const owner = "4bfmrcuwfq4ksqoupn6wcfxrh5enr1izdeyszmhfrntuf1mzoh5o";
const post = `pubky://${owner}/pub/social/v1/posts/0035NV17R994G`;

const turns = Array.from({ length: 8 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  text: `${index} ${"🙂".repeat(20)}`,
}));

describe("AskBody conversation", () => {
  it("accepts the optional canonical C5 target", () => {
    expect(parseAskBody({
      question: "Suggest tags for this post",
      target: { kind: "post", uri: post },
    }).ok).toBe(true);
  });

  it("rejects a C5 target with a mismatched kind or path", () => {
    expect(parseAskBody({ target: { kind: "user", uri: post } }).ok).toBe(false);
    for (const uri of [
      `${post}/`,
      `${post}/0035NV17R994G.json`,
      post.replace("/pub/", "/priv/"),
      post.replace("/social/v1/", "/pubky.app/"),
    ]) {
      expect(parseAskBody({ target: { kind: "post", uri } }).ok).toBe(false);
    }
    expect(parseAskBody({ target: { kind: "user", uri: `pubky://${owner}` } }).ok).toBe(false);
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

  it("keeps App-owned additive keys under the open boundary", () => {
    const currentAppBody = { question: "hello", conversation: { turns }, proposal_version: 2, target_feed_id: "feed-1", current_feed: { cursor: "c" }, target: { kind: "post", uri: post } };
    expect(AskBodySchema.strict().safeParse(currentAppBody).success).toBe(false);
    expect(parseAskBody(currentAppBody).ok).toBe(true);
    expect(parseAskBody({ question: "hello", context: { future: true }, proposal_version: 2 }).ok).toBe(true);
  });
});
