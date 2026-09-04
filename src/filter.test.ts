import { describe, expect, it, vi } from "vitest";
import { log } from "./log.js";
import {
  filterNewer,
  mentionKey,
  nextCursor,
  skipStaleFirstBoot,
  type Notification,
} from "./types.js";

const n = (ts: number, body: Record<string, unknown>): Notification => ({ timestamp: ts, body });

const USER = "1111111111111111111111111111111111111111111111111111";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("mention filter", () => {
  it("accepts mention with post_uri and mentioned_by", () => {
    const uri = `pubky://${USER}/pub/pubky.app/posts/0000000000001`;
    const got = mentionKey(n(1, { type: "mention", post_uri: uri, mentioned_by: USER }));
    expect(got?.key).toBe(uri);
    expect(got?.kind).toBe("mention");
    expect(got?.author).toBe(USER);
  });

  it("rejects wrong type, missing fields, bad uri", () => {
    expect(mentionKey(n(1, { type: "follow" }))).toBeNull();
    expect(mentionKey(n(1, { type: "mention", mentioned_by: "x" }))).toBeNull();
    expect(mentionKey(n(1, { type: "mention", post_uri: "not-a-uri" }))).toBeNull();
  });

  it("accepts reply notifications via reply_uri", () => {
    const uri = `pubky://${USER}/pub/pubky.app/posts/0000000000002`;
    const got = mentionKey(n(1, { type: "reply", reply_uri: uri, replied_by: USER }));
    expect(got?.key).toBe(uri);
    expect(got?.kind).toBe("reply");
    expect(got?.author).toBe(USER);
  });

  it("derives the author from the post URI when it agrees with the body (audit F-D)", () => {
    const uri = `pubky://${USER}/pub/pubky.app/posts/0000000000003`;
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const mention = mentionKey(n(1, { type: "mention", post_uri: uri, mentioned_by: `pk:${USER}` }));
      expect(mention?.author).toBe(USER);
      const reply = mentionKey(n(1, { type: "reply", reply_uri: uri, replied_by: USER }));
      expect(reply?.author).toBe(USER);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("warns and uses the URI author when the body field disagrees (audit F-D)", () => {
    const uri = `pubky://${USER}/pub/pubky.app/posts/0000000000004`;
    const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const mention = mentionKey(n(1, { type: "mention", post_uri: uri, mentioned_by: OTHER }));
      expect(mention?.author).toBe(USER);
      const reply = mentionKey(n(1, { type: "reply", reply_uri: uri, replied_by: OTHER }));
      expect(reply?.author).toBe(USER);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0]?.[1]).toMatch(/using the URI author/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cursor logic", () => {
  it("end excludes timestamps strictly below the cursor", () => {
    const items = [n(10, {}), n(20, {}), n(5, {})];
    expect(filterNewer(items, 10).map((x) => x.timestamp)).toEqual([10, 20]);
  });

  it("advances cursor to max timestamp", () => {
    expect(nextCursor([n(3, {}), n(9, {})], 4)).toBe(9);
    expect(nextCursor([], 4)).toBe(4);
  });

  it("first boot skips older than max age; 0 disables", () => {
    const now = 1_000_000;
    const items = [n(now - 40 * 60_000, {}), n(now - 5 * 60_000, {})];
    expect(skipStaleFirstBoot(items, now, 30)).toHaveLength(1);
    expect(skipStaleFirstBoot(items, now, 0)).toHaveLength(2);
  });
});
