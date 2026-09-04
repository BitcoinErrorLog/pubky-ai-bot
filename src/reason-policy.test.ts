import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { reasonOne } from "./reason.js";
import type { PostView } from "./types.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const USER2 = "2222222222222222222222222222222222222222222222222222";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

const post = (author: string, id: string) => `pubky://${author}/pub/pubky.app/posts/${id}`;

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

function view(
  author: string,
  id: string,
  replied: string | null,
  content = "hi",
  mentioned?: string[],
): PostView {
  const uri = post(author, id);
  return {
    details: { content, id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied, mentioned },
  };
}

function cannedCfg(over: Partial<Config> = {}): Config {
  return {
    cannedReply: "canned-policy",
    blocklist: new Set<string>(),
    knownBots: new Set<string>(),
    maxRepliesPerThread: 12,
    maxTurnsPerUserPerThread: 6,
    maxPerUserPerHour: 100,
    dailyTokenBudget: 5_000_000,
    userDailyTokenBudget: 600_000,
    modelDelayMs: 0,
    model: "canned",
    ...over,
  } as Config;
}

async function freshJob(store: Store, mentionUri: string, author: string) {
  await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [mentionUri]);
  await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionUri]);
  await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mentionUri]);
  expect(await store.claim(mentionUri, author, BOT)).toBe("claimed");
  await store.enqueueWork(mentionUri, author, "mention", { mentionKey: mentionUri });
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

describe("reason policy: addressed follow-ups", () => {
  let store: Store;
  afterEach(async () => {
    await store?.close();
  });

  it("answers the same asker's follow-up mention after one Jeb reply", async () => {
    const followId = "FOLLOUP000001";
    const followUri = post(USER, followId);
    const botUri = post(BOT, "0000000000BOT");
    const rootUri = post(USER, "000000000ROOT");
    const leaf = view(USER, followId, botUri, `again pubky${BOT}`, [BOT]);
    const botPost = view(BOT, "0000000000BOT", rootUri, "first answer");
    const root = view(USER, "000000000ROOT", null, `hey pubky${BOT}`, [BOT]);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      for (const p of [leaf, botPost, root]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, followUri, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [followUri]);
      expect(pub.rows).toHaveLength(1);
      expect((await store.get(followUri))?.status).toBe("processing");
    } finally {
      await closeServer(server);
    }
  });

  it("answers a second user's mention in a thread Jeb already joined", async () => {
    const followId = "USER2MENT0001";
    const followUri = post(USER2, followId);
    const botUri = post(BOT, "0000000000BOT");
    const rootUri = post(USER, "000000000ROT2");
    const leaf = view(USER2, followId, botUri, `hi pubky${BOT}`, [BOT]);
    const botPost = view(BOT, "0000000000BOT", rootUri, "first answer");
    const root = view(USER, "000000000ROT2", null, "root");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        const id = u.pathname.split("/")[3] ?? USER2;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Pat", id, bio: "human" }));
        return;
      }
      for (const p of [leaf, botPost, root]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, followUri, USER2);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pub = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [followUri]);
      expect(pub.rows).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it("skips the 7th turn by the same user with user_turn_cap", async () => {
    const followId = "SEVENTH000001";
    const followUri = post(USER, followId);
    const botUri = post(BOT, "0000000000BOT");
    const rootUri = post(USER, "00000000ROOT7");
    const leaf = view(USER, followId, botUri, "seventh?", [BOT]);
    const botPost = view(BOT, "0000000000BOT", rootUri, "earlier");
    const root = view(USER, "00000000ROOT7", null, "root");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      for (const p of [leaf, botPost, root]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      await store.pool.query(
        `DELETE FROM publish_requests WHERE evidence_id IN (
           SELECT id FROM evidence WHERE kind = 'policy_notice'
         )`,
      );
      await store.pool.query(`DELETE FROM evidence WHERE kind = 'policy_notice'`);
      for (let i = 0; i < 6; i++) {
        const id = `PRIOR${String(i).padStart(8, "0")}`;
        const key = post(USER, id);
        await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
        expect(await store.claim(key, USER, BOT)).toBe("claimed");
        await store.mark(key, "published", { rootUri });
      }
      const job = await freshJob(store, followUri, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(followUri))?.status).toBe("processing");
      expect((await store.get(followUri))?.skip_reason).toBe("user_turn_cap");
      expect((await store.get(followUri))?.notice_suppressed).toBe(false);
      const pub = await store.pool.query<{ content: string; categories: unknown }>(
        "SELECT content, categories FROM publish_requests WHERE mention_key = $1",
        [followUri],
      );
      expect(pub.rows).toHaveLength(1);
      expect(pub.rows[0]?.content).toMatch(/limit for one thread/);
      expect(pub.rows[0]?.categories).toEqual(["declined"]);
    } finally {
      await closeServer(server);
    }
  });

  it("skips a bot replier with bot_author", async () => {
    const followId = "BOTAUTHOR0001";
    const followUri = post(USER, followId);
    const botUri = post(BOT, "0000000000BOT");
    const leaf = view(USER, followId, botUri, "ping");
    const botPost = view(BOT, "0000000000BOT", null, "earlier");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Relay bot", id: USER, bio: "automated" }));
        return;
      }
      for (const p of [leaf, botPost]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, followUri, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(followUri))?.skip_reason).toBe("bot_author");
    } finally {
      await closeServer(server);
    }
  });

  it("skips a Jeb→Jeb ancestor chain with bot_loop", async () => {
    const followId = "BOTLOOP000001";
    const followUri = post(USER, followId);
    const jeb2 = post(BOT, "JEBREPLY00002");
    const jeb1 = post(BOT, "JEBREPLY00001");
    const leaf = view(USER, followId, jeb2, `pubky${BOT}`, [BOT]);
    const mid = view(BOT, "JEBREPLY00002", jeb1, "jeb to jeb");
    const first = view(BOT, "JEBREPLY00001", null, "root jeb");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      for (const p of [leaf, mid, first]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, followUri, USER);
      await reasonOne(cannedCfg({ maxRepliesPerThread: 12 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(followUri))?.skip_reason).toBe("bot_loop");
    } finally {
      await closeServer(server);
    }
  });

  it("skips unaddressed activity in a thread Jeb has joined", async () => {
    const followId = "UNADDR0000001";
    const followUri = post(USER, followId);
    const other = post(USER2, "OTHER00000001");
    const botUri = post(BOT, "0000000000BOT");
    const leaf = view(USER, followId, other, "talking past jeb");
    const otherPost = view(USER2, "OTHER00000001", botUri, "not to jeb");
    const botPost = view(BOT, "0000000000BOT", null, "jeb was here");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      for (const p of [leaf, otherPost, botPost]) {
        if (u.pathname.includes(p.details.id)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(p));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      const job = await freshJob(store, followUri, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(followUri))?.skip_reason).toBe("unaddressed");
    } finally {
      await closeServer(server);
    }
  });
});
