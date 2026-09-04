import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { FALLBACK_KIND } from "./fallback.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { reasonOne, reapDeadlineFallbacks } from "./reason.js";
import { startFakeOpenAI } from "../tests/fake-openai.js";
import type { PostView } from "./types.js";

const USER = "1111111111111111111111111111111111111111111111111111";
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

function view(author: string, id: string, content: string): PostView {
  const uri = post(author, id);
  return {
    details: { content, id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied: null, mentioned: [BOT] },
  };
}

function modelCfg(over: Partial<Config> = {}): Config {
  return {
    cannedReply: undefined,
    blocklist: new Set<string>(),
    knownBots: new Set<string>(),
    maxRepliesPerThread: 12,
    maxTurnsPerUserPerThread: 6,
    maxPerUserPerHour: 100,
    dailyTokenBudget: 2_000_000,
    modelDelayMs: 0,
    model: "gpt-4o-mini",
    modelTimeoutMs: 2_000,
    answerBudgetMs: 8_000,
    replyDeadlineMs: 240_000,
    toolMaxSteps: 4,
    scoutUrl: "https://nexus-scout.pubky.app",
    scoutTimeoutMs: 2_000,
    scoutLimitMax: 50,
    scoutEnabled: false,
    scoutClaimantCap: 12,
    webProvider: "off",
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

describe("guaranteed fallback reply", () => {
  let store: Store;
  afterEach(async () => {
    await store?.close();
  });

  it("model 500 after retry publishes exactly one fallback reply", async () => {
    const id = "FALLBACK50001";
    const uri = post(USER, id);
    const leaf = view(USER, id, `based on my social graph, who should I follow pubky${BOT}`);
    const fake = await startFakeOpenAI({ handler: () => ({ status: 500, json: {} }) });
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
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
      const job = await freshJob(store, uri, USER);
      await reasonOne(modelCfg({ modelApiKey: "sk-test", modelBaseUrl: fake.url }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      const pubs = await store.pool.query<{ content: string; n: number }>(
        `SELECT content, COUNT(*) OVER ()::int AS n FROM publish_requests WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')`,
        [uri],
      );
      expect(pubs.rows).toHaveLength(1);
      expect(pubs.rows[0]?.n).toBe(1);
      expect(pubs.rows[0]?.content).toMatch(/couldn't finish|didn't complete|follow graph|narrower/i);
      expect((await store.get(uri))?.fallback_reason).toBe("model_error");
      expect((await store.get(uri))?.status).toBe("processing");
      const ev = await store.pool.query<{ kind: string | null; fallback_reason: string | null }>(
        "SELECT kind, fallback_reason FROM evidence WHERE mention_key = $1 ORDER BY id DESC LIMIT 1",
        [uri],
      );
      expect(ev.rows[0]?.kind).toBe(FALLBACK_KIND);
      expect(ev.rows[0]?.fallback_reason).toBe("model_error");
    } finally {
      await closeServer(server);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("deadline watchdog inserts one timeout fallback and cancels a hanging model", async () => {
    const id = "FALLBACKHANG1";
    const uri = post(USER, id);
    const leaf = view(USER, id, `who should I follow pubky${BOT}`);
    const fake = await startFakeOpenAI({ handler: () => ({ hang: true }) });
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
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
    const aborts = new Map<string, AbortController>();
    try {
      const job = await freshJob(store, uri, USER);
      const running = reasonOne(
        modelCfg({ modelApiKey: "sk-test", modelBaseUrl: fake.url, modelTimeoutMs: 30_000, answerBudgetMs: 60_000 }),
        store,
        new Nexus(url, 2000),
        new InjectionDetector(),
        BOT,
        job,
        undefined,
        aborts,
      );
      const started = Date.now();
      while (!aborts.has(uri) && Date.now() - started < 4_000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(aborts.has(uri)).toBe(true);
      await store.pool.query(`UPDATE handled_mentions SET created_at = now() WHERE mention_key <> $1`, [uri]);
      await store.pool.query(`UPDATE work_queue SET created_at = now() WHERE mention_key <> $1`, [uri]);
      await store.pool.query(
        `UPDATE handled_mentions SET created_at = now() - interval '10 minutes' WHERE mention_key = $1`,
        [uri],
      );
      await store.pool.query(
        `UPDATE work_queue SET created_at = now() - interval '10 minutes' WHERE mention_key = $1`,
        [uri],
      );
      const n = await reapDeadlineFallbacks(store, 1_000, aborts);
      expect(n).toBe(1);
      await running;
      const pubs = await store.pool.query<{ content: string; n: number }>(
        `SELECT content, COUNT(*) OVER ()::int AS n FROM publish_requests WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')`,
        [uri],
      );
      expect(pubs.rows).toHaveLength(1);
      expect(pubs.rows[0]?.n).toBe(1);
      expect(pubs.rows[0]?.content).toMatch(/time|narrower/i);
      expect((await store.get(uri))?.fallback_reason).toBe("timeout");
      const ev = await store.pool.query<{ kind: string | null }>(
        "SELECT kind FROM evidence WHERE mention_key = $1 ORDER BY id DESC LIMIT 1",
        [uri],
      );
      expect(ev.rows[0]?.kind).toBe(FALLBACK_KIND);
    } finally {
      await closeServer(server);
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});
