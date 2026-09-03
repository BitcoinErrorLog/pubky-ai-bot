import { describe, expect, it } from "vitest";
import {
  filterNewer,
  mentionKey,
  nextCursor,
  skipStaleFirstBoot,
  type Notification,
} from "./types.js";

const n = (ts: number, body: Record<string, unknown>): Notification => ({ timestamp: ts, body });

describe("mention filter", () => {
  it("accepts mention with post_uri and mentioned_by", () => {
    const uri = "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000001";
    const got = mentionKey(
      n(1, { type: "mention", post_uri: uri, mentioned_by: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(got?.key).toBe(uri);
    expect(got?.kind).toBe("mention");
  });

  it("rejects wrong type, missing fields, bad uri", () => {
    expect(mentionKey(n(1, { type: "follow" }))).toBeNull();
    expect(mentionKey(n(1, { type: "mention", mentioned_by: "x" }))).toBeNull();
    expect(mentionKey(n(1, { type: "mention", post_uri: "not-a-uri" }))).toBeNull();
  });

  it("accepts reply notifications via reply_uri", () => {
    const uri = "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000002";
    const got = mentionKey(
      n(1, { type: "reply", reply_uri: uri, replied_by: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    );
    expect(got?.key).toBe(uri);
    expect(got?.kind).toBe("reply");
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
