import { describe, expect, it } from "vitest";
import { postIdFromUnixMs } from "../bot-kit/crockford.js";
import type { Config } from "../config.js";
import type { Nexus } from "../nexus.js";
import type { PostView } from "../types.js";
import {
  gatherProjectCandidates,
  projectsNamedByPost,
  textMentions,
} from "./gather.js";
import { JEB_PUBKY, SEEDED_TRACKED_PROJECTS, type TrackedProject } from "./types.js";
import { updatesWindow } from "./week-key.js";

const AUTHOR = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TZ = "Europe/London";
const WEEK = "2026-W36";

const nexus = SEEDED_TRACKED_PROJECTS.find((p) => p.id === "nexus")!;
const paykit = SEEDED_TRACKED_PROJECTS.find((p) => p.id === "paykit")!;
const pubkyApp = SEEDED_TRACKED_PROJECTS.find((p) => p.id === "pubky-app")!;
const jeb = SEEDED_TRACKED_PROJECTS.find((p) => p.id === "jeb")!;

function view(opts: {
  author: string;
  id: string;
  content: string;
  indexedAt: number;
  tags?: string[];
  mentioned?: string[];
}): PostView {
  return {
    details: {
      content: opts.content,
      id: opts.id,
      indexed_at: opts.indexedAt,
      author: opts.author,
      kind: "short",
      uri: `pubky://${opts.author}/pub/pubky.app/posts/${opts.id}`,
    },
    counts: { tags: opts.tags?.length ?? 0, replies: 1, reposts: 0 },
    tags: (opts.tags ?? []).map((label) => ({ label, taggers_count: 1, taggers: [opts.author] })),
    relationships: opts.mentioned ? { mentioned: opts.mentioned } : {},
  };
}

describe("projectsNamedByPost", () => {
  const projects = [nexus, paykit, pubkyApp, jeb];

  it("does not attribute a generic post to any project", () => {
    expect(
      projectsNamedByPost({
        content: "Vibes-First Software R&D is a research practice.",
        tags: [],
        author: AUTHOR,
        projects,
      }),
    ).toEqual([]);
  });

  it("attributes a post that names two projects to exactly those two", () => {
    expect(
      projectsNamedByPost({
        content: "Shipped a Nexus indexer change and a Paykit invoice path.",
        tags: [],
        author: AUTHOR,
        projects,
      }).sort(),
    ).toEqual(["nexus", "paykit"]);
  });

  it("matches a project tag and a known project pubky mention", () => {
    expect(
      projectsNamedByPost({
        content: "thanks for the reply",
        tags: ["pubky-app"],
        author: AUTHOR,
        mentioned: [JEB_PUBKY],
        projects,
      }).sort(),
    ).toEqual(["jeb", "pubky-app"]);
  });

  it("does not treat a tag-search bucket as a match without body/tag/author", () => {
    expect(textMentions("Vibes-First Software R&D", "Nexus")).toBe(false);
    expect(textMentions("talking about Nexus tonight", "Nexus")).toBe(true);
  });
});

describe("gatherProjectCandidates window + deleted + jeb", () => {
  const win = updatesWindow(WEEK, TZ);
  const inMs = Date.parse("2026-09-02T12:00:00+01:00");
  const outMs = Date.parse("2026-08-20T12:00:00+01:00");
  const inId = postIdFromUnixMs(inMs);
  const outId = postIdFromUnixMs(outMs);
  const deletedId = postIdFromUnixMs(inMs + 60_000);
  const jebOwnId = postIdFromUnixMs(inMs + 120_000);
  const twoId = postIdFromUnixMs(inMs + 180_000);
  const genericId = postIdFromUnixMs(inMs + 240_000);

  const posts = new Map<string, PostView>([
    [
      `pubky://${AUTHOR}/pub/pubky.app/posts/${outId}`,
      view({ author: AUTHOR, id: outId, content: "Nexus shipped last month", indexedAt: inMs, tags: ["nexus"] }),
    ],
    [
      `pubky://${AUTHOR}/pub/pubky.app/posts/${inId}`,
      view({ author: AUTHOR, id: inId, content: "Nexus shipped this week", indexedAt: outMs, tags: ["nexus"] }),
    ],
    [
      `pubky://${AUTHOR}/pub/pubky.app/posts/${deletedId}`,
      view({ author: AUTHOR, id: deletedId, content: "[DELETED]", indexedAt: inMs, tags: ["nexus"] }),
    ],
    [
      `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${jebOwnId}`,
      view({ author: JEB_PUBKY, id: jebOwnId, content: "I am Jeb talking about Nexus", indexedAt: inMs, tags: ["nexus"] }),
    ],
    [
      `pubky://${OTHER}/pub/pubky.app/posts/${twoId}`,
      view({
        author: OTHER,
        id: twoId,
        content: "Nexus and Paykit both moved this week",
        indexedAt: inMs,
      }),
    ],
    [
      `pubky://${OTHER}/pub/pubky.app/posts/${genericId}`,
      view({
        author: OTHER,
        id: genericId,
        content: "Vibes-First Software R&D",
        indexedAt: inMs,
      }),
    ],
  ]);

  function fakeNexus(): Nexus {
    return {
      post: async (uri: string) => posts.get(uri) ?? null,
      searchPostsByTag: async () =>
        [...posts.keys()].map((uri) => {
          const id = uri.split("/").pop()!;
          const author = uri.slice("pubky://".length, "pubky://".length + 52);
          return { post_key: `${author}:${id}`, score: 1 };
        }),
      streamPosts: async () => [],
      notifications: async () => [],
    } as unknown as Nexus;
  }

  it("keeps only in-window, non-deleted, non-Jeb posts that actually name a project", async () => {
    const got = await gatherProjectCandidates({
      cfg: {} as Config,
      nexus: fakeNexus(),
      projects: [nexus, paykit, jeb],
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      botPk: JEB_PUBKY,
    });
    const contents = got.map((c) => c.content);
    expect(contents).toContain("Nexus shipped this week");
    expect(contents).toContain("Nexus and Paykit both moved this week");
    expect(contents).not.toContain("Nexus shipped last month");
    expect(contents).not.toContain("[DELETED]");
    expect(contents.some((c) => c.includes("I am Jeb"))).toBe(false);
    expect(contents).not.toContain("Vibes-First Software R&D");
    const two = got.find((c) => c.content.includes("Nexus and Paykit"));
    expect(two?.projectIds.sort()).toEqual(["nexus", "paykit"]);
    expect(got.every((c) => c.projectIds.includes("nexus") || c.projectIds.includes("paykit"))).toBe(true);
    expect(got.some((c) => c.uri.includes(outId))).toBe(false);
  });
});
