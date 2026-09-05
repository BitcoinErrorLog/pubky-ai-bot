import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { JEB_COLLECTION_RULES, matchingCollectionKeys } from "./bot-kit/collections/rules.js";
import { recordPublishedStandalone, seedCollectionRules } from "./collections-maintain.js";
import { appendItemIdempotent } from "./bot-kit/collections/rules.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const URI = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/COLLECT000001";

describe("jeb collection maintenance", () => {
  let store: Store;

  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await seedCollectionRules(store);
    await store.pool.query("DELETE FROM collection_items WHERE post_uri = $1", [URI]);
    await store.pool.query("DELETE FROM published WHERE uri = $1", [URI]);
  });

  afterAll(async () => {
    await store.pool.query("DELETE FROM collection_items WHERE post_uri = $1", [URI]);
    await store.pool.query("DELETE FROM published WHERE uri = $1", [URI]);
    await store.close();
  });

  it("seeds every operator-requested collection key", async () => {
    const rows = await store.listCollectionRules();
    const keys = new Set(rows.map((r) => r.collection_key));
    for (const rule of JEB_COLLECTION_RULES) expect(keys.has(rule.collection_key)).toBe(true);
    expect(keys.has("jeb-blog")).toBe(true);
    expect(keys.has("pubky-weekly")).toBe(true);
    expect(keys.has("loopky")).toBe(true);
    expect(keys.has("pubky-bot-kit")).toBe(true);
  });

  it("matches weekly and project posts by self-tag alone", () => {
    expect(
      matchingCollectionKeys({
        uri: URI,
        kind: "long",
        self_tags: ["pubky-weekly"],
      }),
    ).toEqual(expect.arrayContaining(["jeb-blog", "pubky-weekly"]));
    expect(
      matchingCollectionKeys({
        uri: URI,
        kind: "short",
        self_tags: ["loopky"],
      }),
    ).toEqual(["loopky"]);
  });

  it("records a published article and rebuilds membership from published rows without enqueueing", async () => {
    await recordPublishedStandalone(store, {
      uri: URI,
      postId: "COLLECT000001",
      kind: "long",
      content: "article",
      selfTags: ["pubky-weekly"],
      publishRequestId: 1,
    });
    const published = await store.listPublished();
    const weekly = published.filter((p) => matchingCollectionKeys(p).includes("pubky-weekly")).map((p) => p.uri);
    expect(weekly).toContain(URI);
    const first = appendItemIdempotent([], URI);
    expect(first.appended).toBe(true);
    const second = appendItemIdempotent(first.items, URI);
    expect(second.appended).toBe(false);
    await store.replaceCollectionItems("pubky-weekly", weekly);
    expect(await store.listCollectionItemUris("pubky-weekly")).toContain(URI);
  });
});
