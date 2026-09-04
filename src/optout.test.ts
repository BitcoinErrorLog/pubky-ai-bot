import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import {
  classifyOptoutRequest,
  OPTIN_CONFIRM_TEXT,
  OPTOUT_CONFIRM_KIND,
  OPTOUT_CONFIRM_TEXT,
} from "./optout.js";
import { isSilentSkip } from "./policy.js";
import { reasonOne } from "./reason.js";
import type { PostView } from "./types.js";
import { lintVoice } from "./voice.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

describe("opt-out matcher", () => {
  it.each([
    ["stop replying to me", "opt_out"],
    ["Stop replying to me please", "opt_out"],
    ["don't reply to me", "opt_out"],
    ["dont reply to me anymore", "opt_out"],
    ["do not reply to me", "opt_out"],
    ["leave me alone", "opt_out"],
    ["unsubscribe", "opt_out"],
    ["mute me", "opt_out"],
    ["opt out", "opt_out"],
    ["opt-out", "opt_out"],
    ["please stop replying", "opt_out"],
    ["please stop replying to me", "opt_out"],
    ["please stop answering to me", "opt_out"],
    ["no more replies to me", "opt_out"],
    ["stop messaging me", "opt_out"],
    ["you can reply to me again", "opt_in"],
    ["opt in", "opt_in"],
    ["unmute me", "opt_in"],
    ["start replying to me again", "opt_in"],
  ] as const)("%s → %s", (text, kind) => {
    expect(classifyOptoutRequest(text)).toBe(kind);
  });

  it.each([
    "how do I stop Jeb replying to others?",
    "how do I stop Jeb from replying to other people",
    "what is opt out",
    "what does unsubscribe mean",
    "can users opt out of homeservers",
    "should I unsubscribe from the mailing list",
    "explain mute me as a product feature",
    "hello jeb how are homeservers",
    "please summarize this thread",
    "@Jeb how do I unsubscribe from a homeserver's feed?",
    "can I opt out of Nexus indexing?",
    "does Pubky let me mute me-too posts?",
    "how does unsubscribe work on a homeserver?",
    "is opt-out available for graph tags?",
    "why would someone opt out of PKARR?",
    "what happens if I mute people?",
    "please unsubscribe from the homeserver feed when I leave a server",
    "I want to opt out of Nexus indexing for my posts",
    "mute me-too replies on this thread",
    "can Jeb opt out of answering others?",
    "how can I unsubscribe my other account from notifications?",
    // F-A: third-person targets of "please stop replying/answering" are not
    // the author opting out. Keys and @handles are stripped before
    // classification, leaving a dangling "to" — still not an opt-out.
    "please stop replying to them",
    "please stop replying to him",
    "please stop replying to her",
    "please stop replying to others",
    "please stop replying to other people",
    "please stop answering them",
    "please stop replying to yhnbg7r6yqzr8j3e8k5m9x1j3y6wq8z5o5y8u5i3a2s4d5f6g7h8",
    "please stop replying to @someone",
    "please stop replying to pubky://yhnbg7r6yqzr8j3e8k5m9x1j3y6wq8z5o5y8u5i3a2s4d5f6g7h8/pub/pubky.app/posts/0000000000001",
    "",
    "   @Jeb   ",
  ])("does not fire on %s", (text) => {
    expect(classifyOptoutRequest(text)).toBeNull();
  });
});

describe("opt-out confirm copy", () => {
  it("is the specified sentences and passes voice lint", () => {
    expect(OPTOUT_CONFIRM_TEXT).toBe(
      "Understood — I won't reply to you again. Mention me with 'you can reply to me again' to undo.",
    );
    expect(OPTIN_CONFIRM_TEXT).toBe("Understood — I'll reply to you again when you mention me.");
    expect(lintVoice(OPTOUT_CONFIRM_TEXT).violations).toEqual([]);
    expect(lintVoice(OPTIN_CONFIRM_TEXT).violations).toEqual([]);
    expect(isSilentSkip("optout")).toBe(true);
  });
});

describe("user_optouts db round-trip", () => {
  let store: Store;
  afterEach(async () => {
    if (store) {
      await store.pool.query("DELETE FROM user_optouts WHERE pubky = $1", [USER]);
      await store.close();
    }
  });

  it("opts out until the same key opts in", async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM user_optouts WHERE pubky = $1", [USER]);
    expect(await store.isUserOptedOut(USER)).toBe(false);
    await store.setUserOptOut(USER, "stop replying to me");
    expect(await store.isUserOptedOut(USER)).toBe(true);
    expect(await store.countActiveOptouts()).toBeGreaterThanOrEqual(1);
    const listed = await store.listUserOptouts();
    expect(listed.some((r) => r.pubky === USER)).toBe(true);
    await store.setUserOptIn(USER);
    expect(await store.isUserOptedOut(USER)).toBe(false);
    expect((await store.listUserOptouts()).some((r) => r.pubky === USER)).toBe(false);
  });
});

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

function cannedCfg(): Config {
  return {
    cannedReply: "should-not-publish-for-optout",
    blocklist: new Set<string>(),
    knownBots: new Set<string>(),
    maxRepliesPerThread: 12,
    maxTurnsPerUserPerThread: 6,
    maxPerUserPerHour: 100,
    dailyTokenBudget: 5_000_000,
    userDailyTokenBudget: 600_000,
    modelDelayMs: 0,
    model: "canned",
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

describe("opt-out confirmation is once", () => {
  let store: Store;
  afterEach(async () => {
    if (store) {
      await store.pool.query("DELETE FROM user_optouts WHERE pubky = $1", [USER]);
      await store.close();
    }
  });

  it("queues one confirm on first opt-out and none on a repeat; later mentions silent-skip", async () => {
    const id1 = "OPTNOTE000001";
    const id2 = "OPTNOTE000002";
    const id3 = "OPTNOTE000003";
    const uri1 = post(USER, id1);
    const uri2 = post(USER, id2);
    const uri3 = post(USER, id3);
    const postsById = new Map([
      [id1, view(USER, id1, "stop replying to me")],
      [id2, view(USER, id2, "please opt out")],
      [id3, view(USER, id3, "what is a homeserver")],
    ]);
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      const postId = u.pathname.split("/").pop() ?? "";
      const p = postsById.get(postId);
      if (p) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(p));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM user_optouts WHERE pubky = $1", [USER]);
    try {
      const job1 = await freshJob(store, uri1, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job1);
      expect((await store.get(uri1))?.status).toBe("processing");
      const pubs1 = await store.pool.query<{ content: string; categories: unknown }>(
        "SELECT content, categories FROM publish_requests WHERE mention_key = $1",
        [uri1],
      );
      expect(pubs1.rows).toHaveLength(1);
      expect(pubs1.rows[0]?.content).toBe(OPTOUT_CONFIRM_TEXT);
      expect(pubs1.rows[0]?.categories).toEqual(["answer"]);
      const ev = await store.pool.query<{ kind: string | null }>(
        "SELECT kind FROM evidence WHERE mention_key = $1",
        [uri1],
      );
      expect(ev.rows[0]?.kind).toBe(OPTOUT_CONFIRM_KIND);

      const job2 = await freshJob(store, uri2, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job2);
      expect((await store.get(uri2))?.status).toBe("skipped");
      expect((await store.get(uri2))?.skip_reason).toBe("optout");
      expect(
        (await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri2])).rows,
      ).toHaveLength(0);

      const job3 = await freshJob(store, uri3, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job3);
      expect((await store.get(uri3))?.status).toBe("skipped");
      expect((await store.get(uri3))?.skip_reason).toBe("optout");
      expect(
        (await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri3])).rows,
      ).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });

  it("does not treat an empty reply body as an opt-out", async () => {
    const id = "OPTEMPTY00001";
    const parentId = "OPTPARENT0001";
    const uri = post(USER, id);
    const parent = post(USER, parentId);
    const leaf: PostView = {
      details: { content: "   ", id, indexed_at: 1, author: USER, kind: "short", uri },
      relationships: { replied: parent, mentioned: [BOT] },
    };
    const quoted: PostView = {
      details: {
        content: "stop replying to me",
        id: parentId,
        indexed_at: 1,
        author: USER,
        kind: "short",
        uri: parent,
      },
      relationships: { replied: null, mentioned: [] },
    };
    const { server, url } = await listen((u, res) => {
      if (u.pathname.endsWith("/details")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "Uma", id: USER, bio: "human" }));
        return;
      }
      const postId = u.pathname.split("/").pop() ?? "";
      const p = postId === id ? leaf : postId === parentId ? quoted : null;
      if (p) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(p));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM user_optouts WHERE pubky = $1", [USER]);
    try {
      const job = await freshJob(store, uri, USER);
      await reasonOne(cannedCfg(), store, new Nexus(url, 2000), new InjectionDetector(), BOT, job);
      expect(await store.isUserOptedOut(USER)).toBe(false);
      expect((await store.get(uri))?.skip_reason).not.toBe("optout");
      const pubs = await store.pool.query("SELECT id FROM publish_requests WHERE mention_key = $1", [uri]);
      expect(pubs.rows).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });
});
