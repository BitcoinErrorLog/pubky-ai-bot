import { describe, expect, it } from "vitest";
import { existingReply, isDirNotFound, SessionTransport } from "./homeserver.js";
import { POSTS_PREFIX } from "./types.js";

const BOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FakeStorage {
  listCalls: Array<{ cursor: string | null; reverse: boolean | null; limit: number | null }>;
  pages: string[][];
  listError?: Error;
  json: Record<string, { parent?: string }>;
}

function transportWith(storage: FakeStorage): SessionTransport {
  const pubky = {
    publicStorage: {
      list: async (_addr: string, cursor?: string | null, reverse?: boolean | null, limit?: number | null) => {
        if (storage.listError) throw storage.listError;
        storage.listCalls.push({ cursor: cursor ?? null, reverse: reverse ?? null, limit: limit ?? null });
        return storage.pages.shift() ?? [];
      },
      getJson: async (url: string) => {
        const j = storage.json[url];
        if (!j) throw new Error("not found");
        return j;
      },
    },
  };
  return new SessionTransport(BOT, {} as never, pubky as never, {} as never);
}

describe("SessionTransport.listPosts (F-05)", () => {
  it("propagates list errors — never swallows them into an empty listing", async () => {
    const t = transportWith({ listCalls: [], pages: [], listError: new Error("homeserver unreachable"), json: {} });
    await expect(t.listPosts()).rejects.toThrow(/homeserver unreachable/);
    await expect(existingReply(t, "pubky://x/pub/pubky.app/posts/0000000000001")).rejects.toThrow(
      /homeserver unreachable/,
    );
  });

  it("treats 404 directory-not-found (pre-first-PUT) as a definitive empty listing", async () => {
    const err = new Error("Request failed: Server responded with an error: 404 Not Found - Directory Not Found");
    expect(isDirNotFound(err)).toBe(true);
    expect(isDirNotFound(new Error("ECONNREFUSED"))).toBe(false);
    const t = transportWith({ listCalls: [], pages: [], listError: err, json: {} });
    await expect(t.listPosts()).resolves.toEqual([]);
  });

  it("propagates per-post fetch errors — an unreadable post is not silently skipped", async () => {
    const t = transportWith({ listCalls: [], pages: [["pubky://" + BOT + POSTS_PREFIX + "A"]], json: {} });
    await expect(t.listPosts()).rejects.toThrow(/not found/);
  });

  it("pages newest-first beyond the first 200 until the listing is exhausted", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => `pubky://${BOT}${POSTS_PREFIX}P${String(i).padStart(3, "0")}`);
    const page2 = [`pubky://${BOT}${POSTS_PREFIX}LAST`];
    const json: Record<string, { parent?: string }> = {};
    for (const u of page1) json[u] = { parent: "pubky://x/pub/pubky.app/posts/0000000000001" };
    json[page2[0]] = { parent: "pubky://x/pub/pubky.app/posts/0000000000002" };
    const storage: FakeStorage = { listCalls: [], pages: [page1, page2], json };
    const t = transportWith(storage);
    const posts = await t.listPosts();
    expect(posts).toHaveLength(201);
    expect(storage.listCalls).toHaveLength(2);
    expect(storage.listCalls[0].cursor).toBeNull();
    expect(storage.listCalls[0].reverse).toBe(true);
    expect(storage.listCalls[1].cursor, "second page keyed by last entry of first page").toBe(page1[199]);
    const found = await existingReply(
      transportWith({ listCalls: [], pages: [page1, page2], json }),
      "pubky://x/pub/pubky.app/posts/0000000000002",
    );
    expect(found).toBe(`pubky://${BOT}${POSTS_PREFIX}LAST`);
  });

  it("stops paging as soon as untilParent is found", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => `pubky://${BOT}${POSTS_PREFIX}P${String(i).padStart(3, "0")}`);
    const json: Record<string, { parent?: string }> = {};
    for (const u of page1) json[u] = { parent: "pubky://x/pub/pubky.app/posts/0000000000001" };
    json[page1[3]] = { parent: "pubky://x/pub/pubky.app/posts/0000000000007" };
    const storage: FakeStorage = { listCalls: [], pages: [page1], json };
    const found = await existingReply(transportWith(storage), "pubky://x/pub/pubky.app/posts/0000000000007");
    expect(found).toBe(`pubky://${BOT}${POSTS_PREFIX}P003`);
    expect(storage.listCalls, "no further pages fetched after a match").toHaveLength(1);
  });
});
