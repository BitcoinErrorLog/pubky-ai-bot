import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { ingestOne } from "./ingest.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { reasonOne } from "./reason.js";
import { mentionKey, type Notification, type PostView } from "./types.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

const post = (author: string, id: string) => `pubky://${author}/pub/pubky.app/posts/${id}`;

/** Nexus-shaped fixture notifications (recorded shapes from /v0/user/{id}/notifications). */
const FIXTURES = {
  /** User replies to Jeb's post without re-mentioning it. */
  replyToJeb: (replyId: string): Notification => ({
    timestamp: 1_757_000_000_000,
    body: {
      type: "reply",
      replied_by: USER,
      parent_post_uri: post(BOT, "0000000000BOT"),
      reply_uri: post(USER, replyId),
    },
  }),
  /** Explicit mention of the bot key in a new post. */
  mention: (): Notification => ({
    timestamp: 1_757_000_001_000,
    body: {
      type: "mention",
      mentioned_by: USER,
      post_uri: post(USER, "00000000MENT1"),
    },
  }),
  /** Ambient reference: someone wrote "Jeb" without the pubky{id} mention.
   * Nexus emits no mention notification for it; what arrives instead are
   * unrelated notification types, which the filter must ignore. */
  tagNotification: (): Notification => ({
    timestamp: 1_757_000_002_000,
    body: { type: "tag", tagged_by: USER, tag_uri: post(USER, "00000000TAG01"), label: "jeb" },
  }),
  followNotification: (): Notification => ({
    timestamp: 1_757_000_003_000,
    body: { type: "follow", followed_by: USER },
  }),
  newPostNotification: (): Notification => ({
    timestamp: 1_757_000_004_000,
    body: { type: "new_post", author: USER, post_uri: post(USER, "00000000POST1") },
  }),
};

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

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

function view(author: string, id: string, replied: string | null, content = "hi"): PostView {
  const uri = post(author, id);
  return {
    details: { content, id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied },
  };
}

function cannedCfg(): Config {
  return {
    cannedReply: "canned-continuation",
    blocklist: new Set<string>(),
    knownBots: new Set<string>(),
    maxRepliesPerThread: 3,
    maxTurnsPerUserPerThread: 6,
    maxPerUserPerHour: 100,
    dailyTokenBudget: 2_000_000,
    userDailyTokenBudget: 600_000,
    modelDelayMs: 0,
    model: "canned",
  } as Config;
}

async function freshJob(store: Store, mentionUri: string, kind: string) {
  await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [mentionUri]);
  await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionUri]);
  await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mentionUri]);
  expect(await store.claim(mentionUri, USER, BOT)).toBe("claimed");
  await store.enqueueWork(mentionUri, USER, kind, { mentionKey: mentionUri });
  const queued = await store.pool.query<{ id: string; mention_key: string; author: string }>(
    "SELECT id, mention_key, author FROM work_queue WHERE mention_key = $1",
    [mentionUri],
  );
  expect(queued.rows).toHaveLength(1);
  return {
    id: Number(queued.rows[0].id),
    mention_key: queued.rows[0].mention_key,
    author: queued.rows[0].author,
  };
}

describe("continuation: reply notification parsing", () => {
  it("accepts a reply whose parent_post_uri is authored by the bot key", () => {
    const got = mentionKey(FIXTURES.replyToJeb("0000000REPLY1"));
    expect(got?.kind).toBe("reply");
    expect(got?.key).toBe(post(USER, "0000000REPLY1"));
    expect(got?.author).toBe(USER);
    expect(got?.parentUri).toBe(post(BOT, "0000000000BOT"));
  });

  it("rejects a reply notification with a malformed parent_post_uri", () => {
    const n = FIXTURES.replyToJeb("0000000REPLY2");
    n.body.parent_post_uri = "not-a-uri";
    expect(mentionKey(n)).toBeNull();
  });
});

describe("ambient references are ignored at ingest", () => {
  it("drops tag/follow/new_post notifications; only mention and reply enqueue work", async () => {
    const store = new Store(DB);
    await store.migrate();
    try {
      const reply = FIXTURES.replyToJeb("0000000REPLY3");
      const replyKey = post(USER, "0000000REPLY3");
      await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [replyKey]);
      await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [replyKey]);
      await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [replyKey]);
      await ingestOne(store, BOT, reply);
      const queued = await store.pool.query(
        "SELECT mention_key FROM work_queue WHERE mention_key = $1 AND status IN ('queued', 'claimed')",
        [replyKey],
      );
      expect(queued.rows).toHaveLength(1);

      for (const ambient of [FIXTURES.tagNotification(), FIXTURES.followNotification(), FIXTURES.newPostNotification()]) {
        const before = await store.pool.query("SELECT COUNT(*)::int AS n FROM work_queue");
        await ingestOne(store, BOT, ambient);
        const after = await store.pool.query("SELECT COUNT(*)::int AS n FROM work_queue");
        expect(after.rows[0].n).toBe(before.rows[0].n);
      }
    } finally {
      await store.close();
    }
  });
});

describe("continuation: reason step", () => {
  it("answers a direct reply to a Jeb post without re-mention, with the bot turn in context", async () => {
    const replyId = "0000000REPLY4";
    const replyUri = post(USER, replyId);
    const botUri = post(BOT, "0000000000BOT");
    const rootUri = post(USER, "000000000ROOT");
    const leaf = view(USER, replyId, botUri, "and what about ring?");
    const botPost = view(BOT, "0000000000BOT", rootUri, "PKARR publishes keys as DNS packets.");
    const root = view(USER, "000000000ROOT", null, "how does naming work?");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      if (u.pathname.includes(replyId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      if (u.pathname.includes("0000000000BOT")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(botPost));
        return;
      }
      if (u.pathname.includes("000000000ROOT")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(root));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, replyUri, "reply");
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query<{ parent_uri: string; content: string }>(
        "SELECT parent_uri, content FROM publish_requests WHERE mention_key = $1",
        [replyUri],
      );
      expect(pub.rows).toHaveLength(1);
      expect(pub.rows[0].parent_uri).toBe(replyUri);
      expect(pub.rows[0].content).toBe("canned-continuation");
      // The ancestor chain (including Jeb's own earlier reply) was walked as context.
      const dbg = await store.getDebugAncestors();
      expect(dbg.map((a) => a.uri)).toContain(botUri);
      expect(dbg.map((a) => a.uri)).toContain(rootUri);
    } finally {
      await store.close();
      await closeServer(server);
    }
  });

  it("caps continuation when the chain already holds maxRepliesPerThread bot replies", async () => {
    const replyId = "0000000REPLY5";
    const replyUri = post(USER, replyId);
    const botUri = post(BOT, "0000000000BOT");
    const leaf = view(USER, replyId, botUri, "again?");
    const botPost = view(BOT, "0000000000BOT", null, "my earlier answer");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: null }));
        return;
      }
      if (u.pathname.includes(replyId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      if (u.pathname.includes("0000000000BOT")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(botPost));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const store = new Store(DB);
    await store.migrate();
    try {
      await store.pool.query(
        `DELETE FROM publish_requests WHERE evidence_id IN (
           SELECT id FROM evidence WHERE kind = 'policy_notice'
         )`,
      );
      await store.pool.query(`DELETE FROM evidence WHERE kind = 'policy_notice'`);
      const job = await freshJob(store, replyUri, "reply");
      const cfg = { ...cannedCfg(), maxRepliesPerThread: 1 } as Config;
      await reasonOne(cfg, store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [replyUri]);
      expect(pub.rows).toHaveLength(1);
      expect((await store.get(replyUri))?.status).toBe("processing");
      expect((await store.get(replyUri))?.skip_reason).toBe("thread_cap");
    } finally {
      await store.close();
      await closeServer(server);
    }
  });

  it("never continues when the replier declares automation in its profile", async () => {
    const replyId = "0000000REPLY6";
    const replyUri = post(USER, replyId);
    const botUri = post(BOT, "0000000000BOT");
    const leaf = view(USER, replyId, botUri, "auto-follow-up");
    const botPost = view(BOT, "0000000000BOT", null, "my earlier answer");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Relay", id: USER, bio: "I am an automated account" }));
        return;
      }
      if (u.pathname.includes(replyId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      if (u.pathname.includes("0000000000BOT")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(botPost));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, replyUri, "reply");
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [replyUri]);
      expect(pub.rows).toHaveLength(0);
      expect((await store.get(replyUri))?.status).toBe("skipped");
    } finally {
      await store.close();
      await closeServer(server);
    }
  });

  it("never continues when the replier id is in JEB_KNOWN_BOTS", async () => {
    const replyId = "0000000REPLY7";
    const replyUri = post(USER, replyId);
    const botUri = post(BOT, "0000000000BOT");
    const leaf = view(USER, replyId, botUri, "ping");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Relay", id: USER, bio: null }));
        return;
      }
      if (u.pathname.includes(replyId)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, replyUri, "reply");
      const cfg = { ...cannedCfg(), knownBots: new Set<string>([USER]) } as Config;
      await reasonOne(cfg, store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [replyUri]);
      expect(pub.rows).toHaveLength(0);
      expect((await store.get(replyUri))?.status).toBe("skipped");
    } finally {
      await store.close();
      await closeServer(server);
    }
  });
});
