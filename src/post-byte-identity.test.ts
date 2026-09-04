import { describe, expect, it } from "vitest";
import { buildReplyPost, buildStandalonePost, parseEditId } from "@pubky/bot-kit";

/**
 * Recorded from `git show stage1/extract:src/post.ts` + homeserver publishReply
 * `createPost` arguments, on this worktree before the step-8 move
 * (`npx tsx` against the pre-move modules). Inputs must stay fixed.
 */
const BOT = "b".repeat(52);
const PARENT = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/0000000000001";
const EDIT_ID = parseEditId("0035N9BXXT9VG");

const STANDALONE_FIXTURE = {
  json: {
    content: "Hello from the kit extraction fixture.",
    kind: "short",
  },
  path: "/pub/pubky.app/posts/0035N9BXXT9VG",
  url: `pubky://${BOT}/pub/pubky.app/posts/0035N9BXXT9VG`,
  id: "0035N9BXXT9VG",
  content: "Hello from the kit extraction fixture.",
  kind: "short",
} as const;

const REPLY_FIXTURE = {
  json: {
    content: "Reply payload under 2000",
    kind: "short",
    parent: PARENT,
  },
  path: "/pub/pubky.app/posts/0035N9BXXT9VG",
  uri: `pubky://${BOT}/pub/pubky.app/posts/0035N9BXXT9VG`,
} as const;

describe("publish payload byte-identity vs pre-move fixture", () => {
  it("standalone post JSON matches the captured Step-8 pre-move buildStandalonePost output", () => {
    const built = buildStandalonePost(BOT, "Hello from the kit extraction fixture.", "short", null, EDIT_ID);
    expect(JSON.stringify({ json: built.json, path: built.path, url: built.url, id: built.id, content: built.content, kind: built.kind })).toBe(
      JSON.stringify(STANDALONE_FIXTURE),
    );
  });

  it("reply publish payload JSON matches the captured Step-8 pre-move createPost output", () => {
    const built = buildReplyPost(BOT, PARENT, "Reply payload under 2000", EDIT_ID);
    expect(JSON.stringify({ json: built.json, path: built.path, uri: built.uri })).toBe(JSON.stringify(REPLY_FIXTURE));
  });
});
