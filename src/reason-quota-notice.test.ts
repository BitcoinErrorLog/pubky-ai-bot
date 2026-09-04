import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { QUOTA_ANSWER_LEADIN } from "./compose.js";
import { Store } from "./db.js";
import { FALLBACK_KIND } from "./fallback.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { quotaNoticeSentence } from "./quota-notice.js";
import { reasonOne } from "./reason.js";
import { startFakeOpenAI } from "../tests/fake-openai.js";
import type { PostView } from "./types.js";

const ASK = "qa".padEnd(52, "a");
const ASK2 = "qb".padEnd(52, "b");
const ASK3 = "qc".padEnd(52, "c");
const ASK4 = "qd".padEnd(52, "d");
const ASK5 = "qe".padEnd(52, "e");
const ASK6 = "qf".padEnd(52, "f");
const ASK7 = "qg".padEnd(52, "g");
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

function view(author: string, id: string, replied: string | null, content = `hi pubky${BOT}`): PostView {
  const uri = post(author, id);
  return {
    details: { content, id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied, mentioned: [BOT] },
  };
}

function cannedCfg(over: Partial<Config> = {}): Config {
  return {
    cannedReply: "PKARR is the naming layer.",
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
  await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [mentionUri]);
  await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mentionUri]);
  expect(await store.claim(mentionUri, author, BOT)).toBe("claimed");
  await store.enqueueWork(mentionUri, author, "mention", { mentionKey: mentionUri });
  const queued = await store.pool.query<{ id: string; mention_key: string; author: string }>(
    "SELECT id, mention_key, author FROM work_queue WHERE mention_key = $1",
    [mentionUri],
  );
  return {
    id: Number(queued.rows[0].id),
    mention_key: queued.rows[0].mention_key,
    author: queued.rows[0].author,
  };
}

async function isolateAuthor(store: Store, author: string): Promise<void> {
  await store.pool.query(
    `DELETE FROM publish_requests WHERE mention_key IN (
       SELECT mention_key FROM handled_mentions WHERE author = $1
     )`,
    [author],
  );
  await store.pool.query(
    `DELETE FROM evidence WHERE mention_key IN (
       SELECT mention_key FROM handled_mentions WHERE author = $1
     )`,
    [author],
  );
  await store.pool.query("DELETE FROM work_queue WHERE author = $1", [author]);
  await store.pool.query("DELETE FROM handled_mentions WHERE author = $1", [author]);
  await store.pool.query("DELETE FROM token_usage WHERE public_key = $1", [author]);
  await store.pool.query("DELETE FROM rate_limit_events WHERE public_key = $1", [author]);
}

async function priorPublished(store: Store, author: string, id: string, rootUri: string): Promise<void> {
  const key = post(author, id);
  await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
  expect(await store.claim(key, author, BOT)).toBe("claimed");
  await store.mark(key, "published", { rootUri });
}

describe("quota prefix on the last allowed answer", () => {
  let store: Store;
  afterEach(async () => {
    await store?.close();
  });

  it("prefixes when this thread reply hits the cap, not one before", async () => {
    const rootId = "QNOTICEROOT01";
    const lastId = "QNOTICELAST01";
    const earlyId = "QNOTICEEARLY1";
    const rootUri = post(ASK, rootId);
    const lastUri = post(ASK, lastId);
    const earlyUri = post(ASK, earlyId);
    const root = view(ASK, rootId, null, "root");
    const last = view(ASK, lastId, rootUri);
    const early = view(ASK, earlyId, rootUri);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK, bio: "human" }));
        return;
      }
      for (const p of [last, early, root]) {
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
      await isolateAuthor(store, ASK);
      await priorPublished(store, ASK, "QNOTICEPRIOR1", rootUri);
      const earlyJob = await freshJob(store, earlyUri, ASK);
      await reasonOne(cannedCfg({ maxRepliesPerThread: 3 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, earlyJob);
      const earlyPub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [earlyUri],
      );
      expect(earlyPub.rows[0]?.content).toBe("PKARR is the naming layer.");
      expect((await store.get(earlyUri))?.quota_notice).toBeNull();
      await store.mark(earlyUri, "published", { rootUri });

      const lastJob = await freshJob(store, lastUri, ASK);
      await reasonOne(cannedCfg({ maxRepliesPerThread: 3 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, lastJob);
      const lastPub = await store.pool.query<{ content: string; categories: unknown }>(
        "SELECT content, categories FROM publish_requests WHERE mention_key = $1",
        [lastUri],
      );
      expect(lastPub.rows).toHaveLength(1);
      expect(lastPub.rows[0]?.content).toContain(QUOTA_ANSWER_LEADIN);
      expect(lastPub.rows[0]?.content).toContain("last reply in this thread");
      expect(lastPub.rows[0]?.content).toContain("PKARR is the naming layer.");
      expect(lastPub.rows[0]?.categories).not.toContain("declined");
      expect((await store.get(lastUri))?.quota_notice).toBe("thread_cap");
      const ev = await store.pool.query<{ quota_notice: string | null }>(
        "SELECT quota_notice FROM evidence WHERE mention_key = $1",
        [lastUri],
      );
      expect(ev.rows[0]?.quota_notice).toBe("thread_cap");
    } finally {
      await closeServer(server);
    }
  });

  it("prefixes the last per-user thread turn and not the one before", async () => {
    const rootId = "QTURNROOT0001";
    const lastId = "QTURNLAST0001";
    const earlyId = "QTURNEARLY001";
    const rootUri = post(ASK2, rootId);
    const lastUri = post(ASK2, lastId);
    const earlyUri = post(ASK2, earlyId);
    const root = view(ASK2, rootId, null, "root");
    const last = view(ASK2, lastId, rootUri);
    const early = view(ASK2, earlyId, rootUri);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Pat", id: ASK2, bio: "human" }));
        return;
      }
      for (const p of [last, early, root]) {
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
      await isolateAuthor(store, ASK2);
      for (let i = 0; i < 4; i++) await priorPublished(store, ASK2, `QTURNPR${String(i).padStart(6, "0")}`, rootUri);
      const earlyJob = await freshJob(store, earlyUri, ASK2);
      await reasonOne(cannedCfg({ maxTurnsPerUserPerThread: 6 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, earlyJob);
      expect((await store.get(earlyUri))?.quota_notice).toBeNull();
      await store.mark(earlyUri, "published", { rootUri });

      const lastJob = await freshJob(store, lastUri, ASK2);
      await reasonOne(cannedCfg({ maxTurnsPerUserPerThread: 6 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, lastJob);
      const lastPub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [lastUri],
      );
      expect(lastPub.rows[0]?.content).toContain("last reply to you in this thread");
      expect((await store.get(lastUri))?.quota_notice).toBe("user_turn_cap");
    } finally {
      await closeServer(server);
    }
  });

  it("prefixes the last hourly reply using stored timestamps", async () => {
    const earlyId = "QHOUREARLY001";
    const lastId = "QHOURLAST0001";
    const earlyUri = post(ASK3, earlyId);
    const lastUri = post(ASK3, lastId);
    const early = view(ASK3, earlyId, null);
    const last = view(ASK3, lastId, null);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK3, bio: "human" }));
        return;
      }
      for (const p of [early, last]) {
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
      await isolateAuthor(store, ASK3);
      for (let i = 0; i < 3; i++) {
        await priorPublished(store, ASK3, `QHOURPR${String(i).padStart(6, "0")}`, post(ASK3, `QHOURPR${String(i).padStart(6, "0")}`));
      }
      const earlyJob = await freshJob(store, earlyUri, ASK3);
      await reasonOne(cannedCfg({ maxPerUserPerHour: 5 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, earlyJob);
      expect((await store.get(earlyUri))?.quota_notice).toBeNull();
      await store.mark(earlyUri, "published");

      const lastJob = await freshJob(store, lastUri, ASK3);
      await reasonOne(cannedCfg({ maxPerUserPerHour: 5 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, lastJob);
      const pub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [lastUri],
      );
      expect(pub.rows[0]?.content).toMatch(/last reply to you this hour/);
      expect((await store.get(lastUri))?.quota_notice).toBe("user_hourly_cap");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps the quota prefix on a fallback reply", async () => {
    const rootId = "QFBROOT000001";
    const lastId = "QFBLAST000001";
    const rootUri = post(ASK4, rootId);
    const lastUri = post(ASK4, lastId);
    const root = view(ASK4, rootId, null, "root");
    const last = view(ASK4, lastId, rootUri, `based on my social graph, who should I follow pubky${BOT}`);
    const fake = await startFakeOpenAI({ handler: () => ({ status: 500, json: {} }) });
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK4, bio: "human" }));
        return;
      }
      for (const p of [last, root]) {
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
      await isolateAuthor(store, ASK4);
      await priorPublished(store, ASK4, "QFBPRIOR00001", rootUri);
      const job = await freshJob(store, lastUri, ASK4);
      await reasonOne(
        {
          cannedReply: undefined,
          blocklist: new Set<string>(),
          knownBots: new Set<string>(),
          maxRepliesPerThread: 2,
          maxTurnsPerUserPerThread: 6,
          maxPerUserPerHour: 100,
          dailyTokenBudget: 5_000_000,
          userDailyTokenBudget: 600_000,
          modelDelayMs: 0,
          model: "gpt-4o-mini",
          modelTimeoutMs: 2_000,
          answerBudgetMs: 8_000,
          toolMaxSteps: 4,
          scoutUrl: "https://nexus-scout.pubky.app",
          scoutTimeoutMs: 2_000,
          scoutLimitMax: 50,
          scoutEnabled: false,
          scoutClaimantCap: 12,
          webProvider: "off",
          modelApiKey: "sk-test",
          modelBaseUrl: fake.url,
        } as Config,
        store,
        new Nexus(url, 2000),
        new InjectionDetector(),
        BOT,
        job,
      );
      const pubs = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [lastUri],
      );
      expect(pubs.rows).toHaveLength(1);
      expect(pubs.rows[0]?.content).toContain(quotaNoticeSentence("thread_cap", { now: new Date() }).slice(0, 24));
      expect(pubs.rows[0]?.content).toContain(QUOTA_ANSWER_LEADIN);
      expect(pubs.rows[0]?.content).toMatch(/couldn't finish|didn't complete|narrower/i);
      const ev = await store.pool.query<{ kind: string | null; quota_notice: string | null }>(
        "SELECT kind, quota_notice FROM evidence WHERE mention_key = $1 ORDER BY id DESC LIMIT 1",
        [lastUri],
      );
      expect(ev.rows[0]?.kind).toBe(FALLBACK_KIND);
      expect(ev.rows[0]?.quota_notice).toBe("thread_cap");
    } finally {
      await closeServer(server);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("prefixes the last per-user daily budget answer and not the one before", async () => {
    const earlyId = "QUDLEARLY0001";
    const lastId = "QUDLLAST00001";
    const earlyUri = post(ASK5, earlyId);
    const lastUri = post(ASK5, lastId);
    const early = view(ASK5, earlyId, null);
    const last = view(ASK5, lastId, null);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK5, bio: "human" }));
        return;
      }
      for (const p of [early, last]) {
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
      await isolateAuthor(store, ASK5);
      const typical = await store.typicalAnswerTokensP50();
      const cfgEarly = cannedCfg({ userDailyTokenBudget: typical * 3, dailyTokenBudget: 50_000_000 });
      const earlyJob = await freshJob(store, earlyUri, ASK5);
      await reasonOne(cfgEarly, store, new Nexus(url, 2000), new InjectionDetector(), BOT, earlyJob);
      expect((await store.get(earlyUri))?.quota_notice).toBeNull();

      await store.recordUsage({
        mentionKey: post(ASK5, "QUDLUSAGE0001"),
        publicKey: ASK5,
        phase: "answer",
        totalTokens: typical,
      });
      const lastJob = await freshJob(store, lastUri, ASK5);
      await reasonOne(
        cannedCfg({ userDailyTokenBudget: typical * 2, dailyTokenBudget: 50_000_000 }),
        store,
        new Nexus(url, 2000),
        new InjectionDetector(),
        BOT,
        lastJob,
      );
      const pub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [lastUri],
      );
      expect(pub.rows[0]?.content).toContain("last reply to you today");
      expect((await store.get(lastUri))?.quota_notice).toBe("user_daily_budget");
    } finally {
      await closeServer(server);
    }
  });

  it("prefixes the last global daily budget answer", async () => {
    const id = "QGLOBLAST0001";
    const uri = post(ASK6, id);
    const leaf = view(ASK6, id, null);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK6, bio: "human" }));
        return;
      }
      if (u.pathname.includes(leaf.details.id)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      await isolateAuthor(store, ASK6);
      const typical = await store.typicalAnswerTokensP50();
      const global = await store.globalDailyTokens();
      const ceiling = global + typical;
      const job = await freshJob(store, uri, ASK6);
      await reasonOne(
        cannedCfg({ dailyTokenBudget: Math.max(ceiling, typical), userDailyTokenBudget: 50_000_000 }),
        store,
        new Nexus(url, 2000),
        new InjectionDetector(),
        BOT,
        job,
      );
      expect((await store.get(uri))?.quota_notice).toBe("global_daily_budget");
      const pub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [uri],
      );
      expect(pub.rows[0]?.content).toContain("last reply for today");
    } finally {
      await closeServer(server);
    }
  });

  it("stacks: user daily + thread cap both last → only the user-daily prefix", async () => {
    const id = "QSTACKLAST001";
    const uri = post(ASK7, id);
    const leaf = view(ASK7, id, null);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: ASK7, bio: "human" }));
        return;
      }
      if (u.pathname.includes(leaf.details.id)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leaf));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    try {
      await isolateAuthor(store, ASK7);
      const typical = await store.typicalAnswerTokensP50();
      await store.recordUsage({
        mentionKey: post(ASK7, "QSTACKUSE0001"),
        publicKey: ASK7,
        phase: "answer",
        totalTokens: typical,
      });
      const job = await freshJob(store, uri, ASK7);
      await reasonOne(
        cannedCfg({
          userDailyTokenBudget: typical * 2,
          dailyTokenBudget: 50_000_000,
          maxRepliesPerThread: 1,
        }),
        store,
        new Nexus(url, 2000),
        new InjectionDetector(),
        BOT,
        job,
      );
      expect((await store.get(uri))?.quota_notice).toBe("user_daily_budget");
      const pub = await store.pool.query<{ content: string }>(
        "SELECT content FROM publish_requests WHERE mention_key = $1",
        [uri],
      );
      expect(pub.rows[0]?.content).toContain("last reply to you today");
      expect(pub.rows[0]?.content).not.toContain("last reply in this thread");
    } finally {
      await closeServer(server);
    }
  });
});
