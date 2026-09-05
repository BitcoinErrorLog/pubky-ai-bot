import { describe, expect, it } from "vitest";
import { appendItemIdempotent, JEB_COLLECTION_RULES, matchingCollectionKeys, ruleByKey, ruleMatchesPost } from "./rules.js";

describe("collection rule matching", () => {
  it("seeds the operator-requested collections", () => {
    const keys = JEB_COLLECTION_RULES.map((r) => r.collection_key);
    expect(keys).toContain("jeb-blog");
    expect(keys).toContain("pubky-weekly");
    expect(keys).toContain("community-feedback");
    expect(keys).toContain("pubky-explained");
    expect(keys).toContain("release-radar");
    expect(keys).toContain("loopky");
    expect(keys).toContain("pubky-bot-kit");
    expect(ruleByKey("jeb-blog")?.title).toBe("Jeb's Blog");
  });

  it("puts every long post in Jeb's Blog and ignores shorts", () => {
    const blog = ruleByKey("jeb-blog")!;
    expect(ruleMatchesPost(blog, { uri: "u", kind: "long", self_tags: [] })).toBe(true);
    expect(ruleMatchesPost(blog, { uri: "u", kind: "short", self_tags: ["pubky"] })).toBe(false);
  });

  it("matches weekly and project posts by self-tag alone", () => {
    const weekly = { uri: "u1", kind: "long" as const, self_tags: ["pubky-weekly"] };
    const loopky = { uri: "u2", kind: "short" as const, self_tags: ["loopky"] };
    expect(matchingCollectionKeys(weekly)).toEqual(expect.arrayContaining(["jeb-blog", "pubky-weekly"]));
    expect(matchingCollectionKeys(loopky)).toEqual(["loopky"]);
    expect(matchingCollectionKeys({ uri: "u3", kind: "short", self_tags: ["unrelated"] })).toEqual([]);
  });

  it("matches by series without requiring a self-tag", () => {
    const post = { uri: "u", kind: "short" as const, self_tags: [], series: "community-feedback" };
    expect(matchingCollectionKeys(post)).toContain("community-feedback");
  });

  it("appends collection items idempotently", () => {
    const first = appendItemIdempotent([], "pubky://a/pub/pubky.app/posts/AAAAAAAAAAAAA");
    expect(first.appended).toBe(true);
    const again = appendItemIdempotent(first.items, first.items[0]!);
    expect(again.appended).toBe(false);
    expect(again.items).toEqual(first.items);
  });

  it("caps membership at write time and keeps the newest N", () => {
    const items = ["old-1", "old-2", "old-3"];
    const next = appendItemIdempotent(items, "newest", 3);
    expect(next.appended).toBe(true);
    expect(next.items).toEqual(["old-2", "old-3", "newest"]);
  });
});
