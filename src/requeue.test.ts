import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { Nexus } from "./nexus.js";
import { classifyRequeueKind, mentionUrisFromArgv, replaceFlagFromArgv, replyUriFromArgv, requeueOne } from "./requeue.js";
import type { PostView } from "./types.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "cccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

const postUri = (author: string, id: string) => `pubky://${author}/pub/pubky.app/posts/${id}`;

function view(author: string, id: string, extra?: Partial<PostView>): PostView {
  const uri = postUri(author, id);
  return {
    details: { content: extra?.details?.content ?? `hello ${BOT}`, id, indexed_at: 1, author, kind: "short", uri },
    relationships: extra?.relationships ?? { mentioned: [BOT] },
  };
}

function listen(posts: Map<string, PostView | 404>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = /^\/v0\/post\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    const uri = postUri(m[1] ?? "", m[2] ?? "");
    const found = posts.get(uri);
    if (!found || found === 404) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(found));
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

describe("mentionUrisFromArgv", () => {
  it("collects repeated --mention flags without a shell", () => {
    expect(
      mentionUrisFromArgv(["node", "dist/main.js", "--role", "requeue", "--mention", "a", "--mention", "b"]),
    ).toEqual(["a", "b"]);
  });

  it("parses --replace and --reply", () => {
    const argv = [
      "node",
      "dist/main.js",
      "--role",
      "requeue",
      "--mention",
      "pubky://x/pub/pubky.app/posts/AAAAAAAAAAAAA",
      "--replace",
      "--reply",
      "pubky://y/pub/pubky.app/posts/BBBBBBBBBBBBB",
    ];
    expect(replaceFlagFromArgv(argv)).toBe(true);
    expect(replaceFlagFromArgv(["--mention", "a"])).toBe(false);
    expect(replyUriFromArgv(argv)).toBe("pubky://y/pub/pubky.app/posts/BBBBBBBBBBBBB");
  });
});

describe("classifyRequeueKind", () => {
  it("classifies a reply to the bot as reply", () => {
    const p = view(USER, "REPLY00000001", {
      details: {
        content: "ok",
        id: "REPLY00000001",
        indexed_at: 1,
        author: USER,
        kind: "short",
        uri: postUri(USER, "REPLY00000001"),
      },
      relationships: { replied: postUri(BOT, "BOTPOST000001") },
    });
    expect(classifyRequeueKind(p, BOT)).toBe("reply");
  });
});

describe("requeue operator", () => {
  let store: Store;

  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  it("requeues a valid mention that was skipped", async () => {
    const uri = postUri(USER, "REQUEUEVALID1");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "skipped", { skipReason: "unaddressed" });
    const post = view(USER, "REQUEUEVALID1");
    const { server, url } = await listen(new Map([[uri, post]]));
    try {
      const nexus = new Nexus(url, 5_000);
      const result = await requeueOne({ uri, store, fetchPost: (u) => nexus.post(u), botPk: BOT });
      expect(result).toEqual({ line: `requeued ${uri}`, ok: true });
      const row = await store.get(uri);
      expect(row?.status).toBe("processing");
      expect(row?.skip_reason).toBeNull();
      expect(await store.hasActiveWork(uri, 180_000)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("leaves an already-published mention alone", async () => {
    const uri = postUri(USER, "REQUEUEPUBLSH");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "published", { replyUri: postUri(BOT, "BOTREPLY00001"), rootUri: uri });
    const post = view(USER, "REQUEUEPUBLSH");
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => post,
      botPk: BOT,
    });
    expect(result).toEqual({ line: `skipped ${uri}: already published`, ok: false });
    expect((await store.get(uri))?.status).toBe("published");
    expect(await store.hasActiveWork(uri, 180_000)).toBe(false);
  });

  it("refuses a URI that does not mention or reply to the bot", async () => {
    const uri = postUri(USER, "REQUEUENOTBOT");
    const post = view(USER, "REQUEUENOTBOT", {
      details: {
        content: "talking to someone else",
        id: "REQUEUENOTBOT",
        indexed_at: 1,
        author: USER,
        kind: "short",
        uri,
      },
      relationships: { mentioned: [OTHER], replied: postUri(OTHER, "OTHERPOST0001") },
    });
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => post,
      botPk: BOT,
    });
    expect(result).toEqual({ line: `skipped ${uri}: not addressed to bot`, ok: false });
  });

  it("refuses a malformed URI", async () => {
    const uri = "not-a-canonical-uri";
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => {
        throw new Error("should not fetch");
      },
      botPk: BOT,
    });
    expect(result).toEqual({ line: `skipped ${uri}: not a canonical post URI`, ok: false });
  });

  it("requeues a published mention in place and prints the overwritten reply URI", async () => {
    const uri = postUri(USER, "REQUEUEREPLCE");
    const reply = postUri(BOT, "0035N9BXXT9VG");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "published", { replyUri: reply, rootUri: uri });
    await store.insertPublishRequest({ mentionKey: uri, parentUri: uri, content: "old", evidenceId: null });
    await store.pool.query("UPDATE publish_requests SET status = 'published' WHERE mention_key = $1", [uri]);
    const post = view(USER, "REQUEUEREPLCE");
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => post,
      botPk: BOT,
      replace: true,
    });
    expect(result).toEqual({ line: `requeued ${uri} replacing ${reply}`, ok: true });
    expect((await store.get(uri))?.status).toBe("processing");
    expect((await store.get(uri))?.reply_uri).toBe(reply);
    const work = await store.pool.query<{ payload: { replace_post_id?: string } }>(
      "SELECT payload FROM work_queue WHERE mention_key = $1 AND status = 'queued'",
      [uri],
    );
    expect(work.rows[0]?.payload.replace_post_id).toBe("0035N9BXXT9VG");
    const pub = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1 ORDER BY id DESC",
      [uri],
    );
    expect(pub.rows.some((r) => r.status === "superseded")).toBe(true);
  });

  it("refuses --replace when the stored reply is not the bot key", async () => {
    const uri = postUri(USER, "REQUEUEBADAUT");
    const reply = postUri(OTHER, "NOTJEBREPLY01");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "published", { replyUri: reply, rootUri: uri });
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => view(USER, "REQUEUEBADAUT"),
      botPk: BOT,
      replace: true,
    });
    expect(result.ok).toBe(false);
    expect(result.line).toMatch(/not authored by the bot key/);
    expect((await store.get(uri))?.status).toBe("published");
  });

  it("uses --reply when handled_mentions has no reply_uri", async () => {
    const uri = postUri(USER, "REQUEUEOLDRW1");
    const reply = postUri(BOT, "OLDREPLY00001");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "published");
    const result = await requeueOne({
      uri,
      store,
      fetchPost: async () => view(USER, "REQUEUEOLDRW1"),
      botPk: BOT,
      replace: true,
      replyOverride: reply,
    });
    expect(result).toEqual({ line: `requeued ${uri} replacing ${reply}`, ok: true });
  });
});
