import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { Store } from "../db.js";
import { Nexus } from "../nexus.js";
import { collectTaggedFeedback } from "./tag-collect.js";

const USER = "dddddddddddddddddddddddddddddddddddddddddddddddddddd";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

/** Recorded Nexus stream/posts-by-tag shape (PostView + counts). */
function streamPost(author: string, id: string, content: string, indexedAt: number) {
  return {
    details: {
      content,
      id,
      indexed_at: indexedAt,
      author,
      kind: "short",
      uri: `pubky://${author}/pub/pubky.app/posts/${id}`,
    },
    counts: { tags: 1, replies: 0, reposts: 0 },
    tags: [{ label: "pubky-feedback", taggers_count: 1, taggers: [USER] }],
    relationships: {},
  };
}

function listen(handler: (url: URL, res: import("node:http").ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((req, res) => {
    handler(new URL(req.url ?? "/", "http://127.0.0.1"), res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("collectTaggedFeedback", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM feedback_items");
  });
  afterAll(async () => {
    await store.pool.query("DELETE FROM feedback_items");
    await store.close();
  });

  it("stores tagged posts from the last 8 days and skips the bot", async () => {
    const now = Date.now();
    const { server, url } = await listen((reqUrl, res) => {
      if (reqUrl.pathname === "/v0/stream/posts") {
        const tag = reqUrl.searchParams.get("tags") ?? "";
        expect(["pubky-feedback", "ask-pubky", "pubky-questions"]).toContain(tag);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            streamPost(USER, "TAGFEED000001", "please add search", now - 3_600_000),
            streamPost(BOT, "TAGFEED000002", "jeb's own post", now - 3_600_000),
            streamPost(OTHER, "TAGFEED000003", "old", now - 20 * 86_400_000),
            streamPost(OTHER, "TAGFEED000004", "[DELETED]", now - 3_600_000),
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const cfg = {
      botPk: BOT,
      weeklyTz: "Europe/London",
      nexusUrl: url,
      nexusTimeoutMs: 2000,
    } as Config;
    try {
      const nexus = new Nexus(url, 2000);
      const out = await collectTaggedFeedback({ cfg, store, nexus, now: new Date(now) });
      expect(out.stored).toBe(1);
      expect(out.items).toHaveLength(1);
      const rows = await store.pool.query(`SELECT author_pk, source, quote FROM feedback_items`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].author_pk).toBe(USER);
      expect(rows.rows[0].source).toBe("tag");
      expect(rows.rows[0].quote).toContain("please add search");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("dry-run collect does not write rows", async () => {
    const now = Date.now();
    const { server, url } = await listen((reqUrl, res) => {
      if (reqUrl.pathname === "/v0/stream/posts") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([streamPost(USER, "TAGFEEDDRY001", "dry only", now - 3_600_000)]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const before = await store.pool.query(`SELECT count(*)::int AS n FROM feedback_items`);
    const cfg = { botPk: BOT, weeklyTz: "Europe/London", nexusUrl: url, nexusTimeoutMs: 2000 } as Config;
    try {
      const nexus = new Nexus(url, 2000);
      const out = await collectTaggedFeedback({ cfg, store, nexus, now: new Date(now), persist: false });
      expect(out.items.some((i) => i.quote.includes("dry only"))).toBe(true);
      const after = await store.pool.query(`SELECT count(*)::int AS n FROM feedback_items`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
