import { describe, expect, it } from "vitest";
import {
  deriveScopedReplyTags,
  explicitInteractionUrisFromAnswer,
  interactionTargetUris,
  tagProposalPrompt,
} from "./tags-propose.js";
import type { PostView } from "./types.js";
import { composeReply } from "./compose.js";
import { parseModes } from "./modes.js";

const AUTHOR = "a".repeat(52);
const OTHER = "b".repeat(52);
const mentionUri = `pubky://${AUTHOR}/pub/pubky.app/posts/0000000000001`;
const parentUri = `pubky://${OTHER}/pub/pubky.app/posts/0000000000002`;
const quotedUri = `pubky://${OTHER}/pub/pubky.app/posts/0000000000003`;

function mention(
  content: string,
  opts: { parent?: string; reposted?: string; attachments?: string[] } = {},
): PostView {
  return {
    details: {
      author: AUTHOR,
      content,
      id: "0000000000001",
      indexed_at: 1,
      kind: "short",
      uri: mentionUri,
      attachments: opts.attachments ?? null,
    },
    relationships: {
      replied: opts.parent ?? null,
      reposted: opts.reposted ?? null,
      mentioned: [],
    },
  };
}

describe("reply tag scope", () => {
  it("builds the proposal only from the new pan mention and its answer", () => {
    const prompt = tagProposalPrompt({
      intent: "answer",
      postContent: "pubkybot What material is the frying pan in this photo?",
      content: "The pan appears to be cast iron with an enamelled cooking surface.",
    });
    expect(prompt).toContain("Interacted post: pubkybot What material is the frying pan");
    expect(prompt).toContain("Jeb answer: The pan appears to be cast iron");
    expect(prompt).toContain("Do not infer tags from other thread posts or evidence");
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

  it("tags the mention but not an unrelated parent when the mention carries its own photo", () => {
    expect(
      interactionTargetUris({
        mention: mention("What material is this frying pan?", {
          parent: parentUri,
          attachments: [`pubky://${AUTHOR}/pub/pubky.app/files/0000000000004`],
        }),
      }),
    ).toEqual([mentionUri]);
  });

  it("tags a parent photo the mention asks Jeb to describe", () => {
    expect(
      interactionTargetUris({
        mention: mention("What material is the pan in this photo?", { parent: parentUri }),
      }),
    ).toEqual([mentionUri, parentUri]);
  });

  it("tags reposted and explicitly cited posts, but not uncited evidence", () => {
    const cited = `https://pubky.app/post/${OTHER}/0000000000005`;
    expect(
      interactionTargetUris({
        mention: mention("Compare this quote with the linked post.", { reposted: quotedUri }),
        explicitAnswerUris: explicitInteractionUrisFromAnswer(
          `The quoted claim differs from ${cited}.`,
        ),
      }),
    ).toEqual([
      mentionUri,
      quotedUri,
      `pubky://${OTHER}/pub/pubky.app/posts/0000000000005`,
    ]);
  });

  it("does not tag evidence URLs appended automatically by sources mode", () => {
    const evidenceUri = `pubky://${OTHER}/pub/pubky.app/posts/0000000000006`;
    const modelAuthoredAnswer = "The evidence supports the claim.";
    const composed = composeReply(
      modelAuthoredAnswer,
      parseModes("sources please"),
      [evidenceUri],
    );
    expect(composed.content).toContain(`/post/${OTHER}/0000000000006`);
    const explicitAnswerUris = explicitInteractionUrisFromAnswer(modelAuthoredAnswer);
    expect(explicitAnswerUris).toEqual([]);
    expect(
      interactionTargetUris({
        mention: mention("Give me the sources."),
        explicitAnswerUris,
      }),
    ).toEqual([mentionUri]);
  });
});
