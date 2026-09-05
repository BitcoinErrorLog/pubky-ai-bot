import { describe, expect, it } from "vitest";
import { postIdFromUnixMs } from "../bot-kit/crockford.js";
import { feedbackItemInWindow, isUnusableContent } from "./content.js";
import { JEB_PUBKY, type FeedbackItem } from "./types.js";
import { feedbackWindow } from "./week-key.js";

const AUTHOR = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function item(partial: Partial<FeedbackItem>): FeedbackItem {
  return {
    id: 1,
    post_uri: `pubky://${AUTHOR}/pub/pubky.app/posts/FEEDBACK00001`,
    author_pk: AUTHOR,
    kinds: ["advice"],
    quote: "be shorter",
    detected_at: new Date("2026-09-04T12:00:00Z"),
    week_key: "2026-W36",
    source: "classifier",
    included_in_post_uri: null,
    ...partial,
  };
}

describe("feedback window filter", () => {
  const win = feedbackWindow("2026-W36", "Europe/London");

  it("keeps an in-window post and drops August / deleted / Jeb", () => {
    const inId = postIdFromUnixMs(Date.parse("2026-09-02T12:00:00Z"));
    const outId = postIdFromUnixMs(Date.parse("2026-08-20T12:00:00Z"));
    expect(
      feedbackItemInWindow(
        item({ post_uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${inId}`, detected_at: new Date("2026-08-01T00:00:00Z") }),
        win.sinceMs,
        win.untilMs,
      ),
    ).toBe(true);
    expect(
      feedbackItemInWindow(
        item({ post_uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${outId}`, detected_at: new Date("2026-09-04T12:00:00Z") }),
        win.sinceMs,
        win.untilMs,
      ),
    ).toBe(false);
    expect(feedbackItemInWindow(item({ quote: "[DELETED]" }), win.sinceMs, win.untilMs)).toBe(false);
    expect(feedbackItemInWindow(item({ author_pk: JEB_PUBKY }), win.sinceMs, win.untilMs, JEB_PUBKY)).toBe(false);
  });

  it("treats empty and [DELETED] as unusable", () => {
    expect(isUnusableContent("")).toBe(true);
    expect(isUnusableContent("  ")).toBe(true);
    expect(isUnusableContent("[DELETED]")).toBe(true);
    expect(isUnusableContent("hello")).toBe(false);
  });
});
