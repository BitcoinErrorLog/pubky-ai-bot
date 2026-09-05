import { describe, expect, it } from "vitest";
import { detectCandidateNames, projectSlug } from "./learn.js";
import type { CandidatePost } from "./gather.js";
import type { TrackedProject } from "./types.js";

const projects: TrackedProject[] = [
  {
    id: "pkarr",
    name: "Pkarr",
    aliases: ["PKARR"],
    tags: ["pkarr"],
    pubky_ids: [],
    status: "active",
  },
];

function post(author: string, content: string): CandidatePost {
  return {
    uri: `pubky://${author}/pub/pubky.app/posts/LEARN00000001`,
    author,
    content,
    indexedAt: 1,
    engagement: 0,
    projectIds: [],
    tags: [],
  };
}

describe("learn candidate projects", () => {
  it("requires ≥3 mentions from ≥2 authors next to pubky terms", () => {
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const hits = detectCandidateNames(
      [
        post(a, "Loopcraft on pubky is interesting"),
        post(a, "Loopcraft homeserver notes"),
        post(b, "Loopcraft and pkarr together"),
        post(b, "Loopcraft again with pubky"),
      ],
      projects,
    );
    expect(hits.some((h) => h.name === "Loopcraft" && h.count >= 3 && h.authors >= 2)).toBe(true);
  });
  it("ignores tracked aliases", () => {
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const hits = detectCandidateNames(
      [
        post(a, "Pkarr on pubky"),
        post(a, "Pkarr homeserver"),
        post(b, "Pkarr and pkarr"),
        post(b, "Pkarr again pubky"),
      ],
      projects,
    );
    expect(hits.some((h) => h.name === "Pkarr")).toBe(false);
  });
  it("slugifies names", () => {
    expect(projectSlug("Loop Craft")).toBe("loop-craft");
  });
});
