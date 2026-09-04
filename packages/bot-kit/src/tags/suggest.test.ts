import { describe, expect, it } from "vitest";
import { MAX_REPLY_TAGS, suggestTags } from "./suggest.js";

const VOCAB = ["answer", "pubky", "bitkit", "paykit", "graph", "evidence-map", "summary", "declined"] as const;

describe("suggestTags injection", () => {
  it("does not emit a label missing from vocab", () => {
    const got = suggestTags({
      intent: "answer",
      toolTrace: [{ toolCalls: [{ name: "get_topic_brief" }] }],
      products: ["pubky"],
      vocab: ["answer"],
      precedence: ["pubky", "bitkit", "paykit"],
      graphTools: ["get_topic_brief"],
    });
    expect(got).toEqual(["answer"]);
  });

  it("uses injected precedence, not a hardcoded product list", () => {
    const got = suggestTags({
      intent: "answer",
      toolTrace: [],
      products: ["locks", "pubky"],
      vocab: ["answer", "locks", "pubky"],
      precedence: ["locks", "pubky"],
    });
    expect(got).toEqual(["answer", "locks", "pubky"]);
  });

  it("caps at MAX_REPLY_TAGS in precedence order", () => {
    const got = suggestTags({
      intent: "answer",
      toolTrace: [{ toolCalls: [{ name: "search_posts" }] }],
      products: ["pubky", "bitkit", "paykit"],
      vocab: VOCAB,
      precedence: ["pubky", "bitkit", "paykit"],
      graphTools: ["search_posts"],
    });
    expect(got).toEqual(["answer", "pubky", "bitkit"]);
    expect(got.length).toBeLessThanOrEqual(MAX_REPLY_TAGS);
  });
});
