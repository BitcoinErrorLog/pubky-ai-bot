import { describe, expect, it } from "vitest";
import { deriveScopedReplyTags, tagProposalPrompt } from "./tags-propose.js";

describe("reply tag scope", () => {
  it("builds the proposal only from the new pan mention and its answer", () => {
    const prompt = tagProposalPrompt({
      intent: "answer",
      mentionContent: "pubkybot What material is the frying pan in this photo?",
      content: "The pan appears to be cast iron with an enamelled cooking surface.",
    });
    expect(prompt).toContain("Current mention: pubkybot What material is the frying pan");
    expect(prompt).toContain("Jeb answer: The pan appears to be cast iron");
    expect(prompt).toContain("Do not infer tags from earlier thread posts");
    expect(prompt).not.toMatch(/ETF|bitcoin|markets|etf-flows/i);
  });

  it("does not carry ETF topics from Nexus candidates into the pan reply", () => {
    const tags = deriveScopedReplyTags({
      intent: "answer",
      proposed: ["cookware", "cast-iron"],
      nexusTags: ["markets", "etf-flows", "etf", "cookware", "bitcoin"],
    });
    expect(tags).toEqual(["cookware", "cast-iron", "answer"]);
    expect(tags).not.toEqual(expect.arrayContaining(["markets", "etf-flows", "etf", "bitcoin"]));
  });
});
