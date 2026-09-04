import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { reasonOne } from "./reason.js";
import { queueSkipNotice, POLICY_NOTICE_KIND, SKIP_NOTICE_TEXT } from "./skip-notice.js";
import type { PostView } from "./types.js";
import { lintVoice } from "./voice.js";

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

function view(author: string, id: string, content = `hi pubky${BOT}`): PostView {
  const uri = post(author, id);
  return {
    details: { content, id, indexed_at: 1, author, kind: "short", uri },
    relationships: { replied: null, mentioned: [BOT] },
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
    dailyTokenBudget: 1,
    userDailyTokenBudget: 1,
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

describe("notified skip: budget notice", () => {
  let store: Store;
  afterEach(async () => {
    await store?.close();
  });

  it("budget skip yields exactly one declined publish request; a second from the same author within 6h yields none", async () => {
    const id1 = "BUDGETNOTE001";
    const id2 = "BUDGETNOTE002";
    const uri1 = post(USER, id1);
    const uri2 = post(USER, id2);
    const leaf1 = view(USER, id1);
    const leaf2 = view(USER, id2);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      for (const p of [leaf1, leaf2]) {
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
      const job1 = await freshJob(store, uri1, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job1);
      expect((await store.get(uri1))?.status).toBe("processing");
      expect((await store.get(uri1))?.skip_reason).toBe("budget");
      expect((await store.get(uri1))?.notice_suppressed).toBe(false);
      const pubs1 = await store.pool.query<{ content: string; categories: unknown }>(
        "SELECT content, categories FROM publish_requests WHERE mention_key = $1",
        [uri1],
      );
      expect(pubs1.rows).toHaveLength(1);
      expect(pubs1.rows[0]?.content).toBe(SKIP_NOTICE_TEXT.budget);
      expect(pubs1.rows[0]?.categories).toEqual(["declined"]);
      expect(lintVoice(pubs1.rows[0]?.content ?? "").violations).toEqual([]);
      const ev = await store.pool.query<{ kind: string | null; fallback_reason: string | null; tokens: number | null }>(
        "SELECT kind, fallback_reason, tokens FROM evidence WHERE mention_key = $1",
        [uri1],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]?.kind).toBe(POLICY_NOTICE_KIND);
      expect(ev.rows[0]?.fallback_reason).toBe("budget");
      expect(ev.rows[0]?.tokens).toBe(0);

      const job2 = await freshJob(store, uri2, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job2);
      expect((await store.get(uri2))?.status).toBe("skipped");
      expect((await store.get(uri2))?.skip_reason).toBe("budget");
      expect((await store.get(uri2))?.notice_suppressed).toBe(true);
      const pubs2 = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri2]);
      expect(pubs2.rows).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });

  it("suppresses a second notice for the same skip reason in one thread", async () => {
    store = new Store(DB);
    await store.migrate();
    const A = "threadcapaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B = "threadcapbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const root = post(A, "SHAREDROOT0001");
    const uri1 = post(A, "THREADNOTE001A");
    const uri2 = post(B, "THREADNOTE002B");
    for (const [uri, author] of [
      [uri1, A],
      [uri2, B],
    ] as const) {
      await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
      expect(await store.claim(uri, author, BOT)).toBe("claimed");
    }
    expect(await queueSkipNotice({ store, mentionKey: uri1, author: A, parentUri: uri1, reason: "thread_cap", rootUri: root })).toBe(
      "sent",
    );
    expect(await queueSkipNotice({ store, mentionKey: uri2, author: B, parentUri: uri2, reason: "thread_cap", rootUri: root })).toBe(
      "suppressed",
    );
    expect((await store.get(uri2))?.notice_suppressed).toBe(true);
    expect((await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri2])).rows).toHaveLength(0);
    expect((await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri1])).rows).toHaveLength(1);
  });

  it("suppresses a thread_cap skip when the last reply already carried a thread-cap quota notice", async () => {
    store = new Store(DB);
    await store.migrate();
    const A = "qcaplastaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const root = post(A, "QCAPROOT00001");
    const lastReply = post(A, "QCAPLAST00001");
    const skipUri = post(A, "QCAPSKIP00001");
    for (const uri of [lastReply, skipUri]) {
      await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    }
    expect(await store.claim(lastReply, A, BOT)).toBe("claimed");
    await store.mark(lastReply, "published", { rootUri: root, quotaNotice: "thread_cap" });
    expect(await store.claim(skipUri, A, BOT)).toBe("claimed");
    expect(
      await queueSkipNotice({ store, mentionKey: skipUri, author: A, parentUri: skipUri, reason: "thread_cap", rootUri: root }),
    ).toBe("suppressed");
    const row = await store.get(skipUri);
    expect(row?.status).toBe("skipped");
    expect(row?.skip_reason).toBe("thread_cap");
    expect(row?.notice_suppressed).toBe(true);
    expect((await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [skipUri])).rows).toHaveLength(0);
  });

  it("sends a thread_cap notice when no quota notice was delivered in that thread", async () => {
    store = new Store(DB);
    await store.migrate();
    const A = "qcapnoneaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const other = "qcapotheraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const root = post(A, "QCAPNONE00001");
    const otherRoot = post(other, "QCAPOTHERROOT1");
    const otherLast = post(other, "QCAPOTHERLAST1");
    const skipUri = post(A, "QCAPNONE00002");
    for (const uri of [otherLast, skipUri]) {
      await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    }
    expect(await store.claim(otherLast, other, BOT)).toBe("claimed");
    await store.mark(otherLast, "published", { rootUri: otherRoot, quotaNotice: "thread_cap" });
    expect(await store.claim(skipUri, A, BOT)).toBe("claimed");
    expect(
      await queueSkipNotice({ store, mentionKey: skipUri, author: A, parentUri: skipUri, reason: "thread_cap", rootUri: root }),
    ).toBe("sent");
    const row = await store.get(skipUri);
    expect(row?.status).toBe("processing");
    expect(row?.skip_reason).toBe("thread_cap");
    expect(row?.notice_suppressed).toBe(false);
    expect((await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [skipUri])).rows).toHaveLength(1);
  });

  it("does not suppress other notified skips because of a thread-cap quota notice", async () => {
    store = new Store(DB);
    await store.migrate();
    const A = "qcapbudgaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const root = post(A, "QCAPBUDGROOT01");
    const lastReply = post(A, "QCAPBUDGLAST01");
    const skipUri = post(A, "QCAPBUDGSKIP01");
    for (const uri of [lastReply, skipUri]) {
      await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [uri]);
      await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    }
    expect(await store.claim(lastReply, A, BOT)).toBe("claimed");
    await store.mark(lastReply, "published", { rootUri: root, quotaNotice: "thread_cap" });
    expect(await store.claim(skipUri, A, BOT)).toBe("claimed");
    expect(
      await queueSkipNotice({ store, mentionKey: skipUri, author: A, parentUri: skipUri, reason: "budget", rootUri: root }),
    ).toBe("sent");
    const row = await store.get(skipUri);
    expect(row?.status).toBe("processing");
    expect(row?.skip_reason).toBe("budget");
    expect(row?.notice_suppressed).toBe(false);
    expect((await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [skipUri])).rows).toHaveLength(1);
  });

  it("requeue --replace ending in a notified skip does NOT overwrite the prior reply (F-5)", async () => {
    const id = "REPLSKIP00001";
    const uri = post(USER2, id);
    const leaf = view(USER2, id);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER2, bio: "human" }));
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
      // Payload as enqueued by `requeue --replace` (the prior answer lives
      // under post id 0035N9BXXT9VG and would have been overwritten).
      const job = {
        ...(await freshJob(store, uri, USER2)),
        payload: { replace_post_id: "0035N9BXXT9VG" },
      };
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(uri))?.skip_reason).toBe("budget");
      const pubs = await store.pool.query<{ content: string; replace_post_id: string | null }>(
        "SELECT content, replace_post_id FROM publish_requests WHERE mention_key = $1",
        [uri],
      );
      expect(pubs.rows).toHaveLength(1);
      expect(pubs.rows[0]?.content).toBe(SKIP_NOTICE_TEXT.budget);
      // The skip notice is a new reply; the prior answer is left in place.
      expect(pubs.rows[0]?.replace_post_id).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("does not publish a notice for silent skip bot_author", async () => {
    const id = "SILENTBTAU001";
    const uri = post(USER, id);
    const leaf = view(USER, id, "ping");
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Relay bot", id: USER, bio: "automated" }));
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
      await reasonOne(cannedCfg({ dailyTokenBudget: 5_000_000, userDailyTokenBudget: 600_000 }), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect((await store.get(uri))?.skip_reason).toBe("bot_author");
      expect(
        (await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri])).rows,
      ).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });
});
