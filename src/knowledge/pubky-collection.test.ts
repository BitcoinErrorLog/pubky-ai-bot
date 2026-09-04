import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertPinnedHost,
  HTTP_COLLECTION_MAX_BYTES,
  loadCollectionDocuments,
} from "./pubky-collection.js";
import type { SourceEntry } from "./types.js";

const AUTHOR = "gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo";
const COLL = "0035HNW0W7COL";
const OK01 = "0035HNW0W7OK1";
const BIG1 = "0035HNW0W7BG1";
const BAD1 = "0035HNW0W7BD1";
const OK02 = "0035HNW0W7OK2";
const SKIP = "0035HNW0W7SKP";

function post(kind: string, id: string, content: unknown) {
  return JSON.stringify({
    details: {
      content: typeof content === "string" ? content : JSON.stringify(content),
      id,
      indexed_at: 1700000000000,
      author: AUTHOR,
      kind,
      uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${id}`,
    },
  });
}

function entry(port: number, extra?: Partial<SourceEntry>): SourceEntry {
  return {
    id: "col-test",
    product: "pubky",
    component: "articles",
    kind: "pubky-collection",
    location: `pubky://${AUTHOR}/pub/pubky.app/posts/${COLL}`,
    nexus: `http://127.0.0.1:${port}`,
    include: [],
    exclude: [],
    status: "opinion",
    audience: "user",
    confidentiality: "public",
    owner: "test",
    ...extra,
  };
}

describe("pubky-collection D1/D6", () => {
  it("pins against the configured nexus host, not a foreign URL host", () => {
    const configured = "nexus.pubky.app";
    expect(() => assertPinnedHost(new URL("https://evil.example/v0/post/a/b"), configured)).toThrow(/ssrf/);
    expect(() => assertPinnedHost(new URL("https://nexus.pubky.app/v0/post/a/b"), configured)).not.toThrow();
  });

  it("caps items and skips oversized or failed items instead of throwing", async () => {
    const files: Record<string, string> = {
      [`/v0/post/${AUTHOR}/${COLL}`]: post("collection", COLL, {
        items: [
          `pubky://${AUTHOR}/pub/pubky.app/posts/${OK01}`,
          `pubky://${AUTHOR}/pub/pubky.app/posts/${BIG1}`,
          `pubky://${AUTHOR}/pub/pubky.app/posts/${BAD1}`,
          `pubky://${AUTHOR}/pub/pubky.app/posts/${OK02}`,
          `pubky://${AUTHOR}/pub/pubky.app/posts/${SKIP}`,
        ],
      }),
      [`/v0/post/${AUTHOR}/${OK01}`]: post("long", OK01, { title: "One", body: "first item body" }),
      [`/v0/post/${AUTHOR}/${BIG1}`]: post("long", BIG1, {
        title: "Huge",
        body: "z".repeat(HTTP_COLLECTION_MAX_BYTES + 8),
      }),
      [`/v0/post/${AUTHOR}/${OK02}`]: post("long", OK02, { title: "Two", body: "second item body" }),
      [`/v0/post/${AUTHOR}/${SKIP}`]: post("long", SKIP, { title: "Three", body: "would be truncated" }),
    };
    const server = createServer((req, res) => {
      const body = files[req.url ?? ""];
      if (!body) {
        res.writeHead(500);
        res.end("fail");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const docs = await loadCollectionDocuments(entry(port), { maxItems: 4, concurrency: 2 });
      expect(docs.map((d) => d.path)).toEqual([`${AUTHOR}/${OK01}`, `${AUTHOR}/${OK02}`]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
