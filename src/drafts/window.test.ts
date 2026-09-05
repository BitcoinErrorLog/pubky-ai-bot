import { describe, expect, it } from "vitest";
import {
  decodePostIdMs,
  draftWindow,
  encodePostIdMs,
  filterWindowPosts,
  inWindow,
  isEmptyOrDeleted,
  isOwnPost,
  postTimeMs,
} from "./window.js";

const BOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER = "1111111111111111111111111111111111111111111111111111";

describe("post id time encoding", () => {
  it("round-trips a millisecond timestamp", () => {
    const ms = Date.parse("2026-09-05T10:00:00Z");
    const id = encodePostIdMs(ms);
    expect(id).toHaveLength(13);
    expect(decodePostIdMs(id)).toBe(ms);
  });

  it("places this-week ids after the 0035D era", () => {
    const week = encodePostIdMs(Date.parse("2026-09-03T00:00:00Z"));
    const old = encodePostIdMs(Date.parse("2026-08-10T00:00:00Z"));
    expect(week > old).toBe(true);
    expect(week.startsWith("0035")).toBe(true);
    expect(decodePostIdMs("0035D9G4GMHN0")).toBeLessThan(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("rejects a non-time id", () => {
    expect(decodePostIdMs("AAAAAAAAAAAAA")).toBeNull();
    expect(decodePostIdMs("0000000000000")).toBeNull();
    expect(decodePostIdMs("short")).toBeNull();
  });
});

describe("7-day window filter", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const window = draftWindow(now, 7);
  const freshId = encodePostIdMs(now - 2 * 86400000);
  const staleId = encodePostIdMs(now - 21 * 86400000);

  it("keeps a 2-day-old post and drops a 21-day-old one when only the id is present", () => {
    const fresh = { uri: `pubky://${USER}/pub/pubky.app/posts/${freshId}`, author_id: USER, post_id: freshId, content: "homeserver notes" };
    const stale = { uri: `pubky://${USER}/pub/pubky.app/posts/${staleId}`, author_id: USER, post_id: staleId, content: "how old are you?" };
    expect(inWindow(fresh, window)).toBe(true);
    expect(inWindow(stale, window)).toBe(false);
    const kept = filterWindowPosts([fresh, stale], { window });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.post_id).toBe(freshId);
  });

  it("prefers the id-decoded time so a reindexed old post stays out of the window", () => {
    const oldId = encodePostIdMs(now - 21 * 86400000);
    const post = {
      uri: `pubky://${USER}/pub/pubky.app/posts/${oldId}`,
      author_id: USER,
      post_id: oldId,
      content: "indexed this week",
      indexed_at: now - 86400000,
    };
    expect(postTimeMs(post)).toBe(now - 21 * 86400000);
    expect(inWindow(post, window)).toBe(false);
  });

  it("accepts Nexus timestamps in microseconds when the id is not a time id", () => {
    const post = {
      author_id: USER,
      post_id: "0000000000000",
      content: "nexus micros",
      indexed_at: (now - 86400000) * 1000,
    };
    expect(postTimeMs(post)).toBe(now - 86400000);
    expect(inWindow(post, window)).toBe(true);
  });

  it("excludes deleted, empty, and Jeb's own posts", () => {
    const id = encodePostIdMs(now - 1000);
    const empty = { author_id: USER, post_id: id, content: "   " };
    const deleted = { author_id: USER, post_id: id, content: "gone", deleted: true };
    const own = { author_id: BOT, post_id: id, content: "I posted this" };
    const ok = { author_id: USER, post_id: id, content: "a real post" };
    expect(isEmptyOrDeleted(empty)).toBe(true);
    expect(isEmptyOrDeleted(deleted)).toBe(true);
    expect(isOwnPost(own, BOT)).toBe(true);
    expect(filterWindowPosts([empty, deleted, own, ok], { window, botPk: BOT })).toEqual([ok]);
  });

  it("honours a shorter windowDays", () => {
    const three = draftWindow(now, 3);
    const fourDays = { author_id: USER, post_id: encodePostIdMs(now - 4 * 86400000), content: "four days" };
    expect(inWindow(fourDays, window)).toBe(true);
    expect(inWindow(fourDays, three)).toBe(false);
  });
});
