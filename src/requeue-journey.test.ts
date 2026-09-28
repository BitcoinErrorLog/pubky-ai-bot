import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import type { Transport } from "./homeserver.js";
import { InjectionDetector } from "./injection-detector.js";
import { Nexus } from "./nexus.js";
import { loadPersonaRegistry } from "./personas/registry.js";
import { createRuntimePersona, personaWorkSnapshot, type RuntimePersona } from "./personas/runtime.js";
import { createRunPublishHooks, publishOne } from "./publish.js";
import { reasonOne, rejectInvalidPersonaWorkSnapshot } from "./reason.js";
import { requeueOne } from "./requeue.js";
import type { PostView } from "./types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_vitest";
const USER = "7777777777777777777777777777777777777777777777777777";
const BOT = "8888888888888888888888888888888888888888888888888888";
const post = (author: string, id: string) => `pubky://${author}/pub/pubky.app/posts/${id}`;

function mentionView(id: string): PostView {
  return {
    details: { content: `what is pubky? pubky${BOT}`, id, indexed_at: 1, author: USER, kind: "short", uri: post(USER, id) },
    relationships: { replied: null, mentioned: [BOT] },
  };
}

function listenNexus(posts: PostView[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname.endsWith("/details")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "Asker", id: USER, bio: "human" }));
      return;
    }
    const found = posts.find((p) => u.pathname === `/v0/post/${p.details.author}/${p.details.id}`);
    if (!found) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(found));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/** Homeserver double that keeps the JSON last written at each post path. */
class RecordingHomeserver implements Transport {
  botPk = BOT;
  failNextPut = false;
  readonly files = new Map<string, { parent?: string; content?: string }>();

  seedReply(postId: string, parent: string, content: string): void {
    this.files.set(`/pub/pubky.app/posts/${postId}`, { parent, content });
  }

  replyAt(postId: string): { parent?: string; content?: string } | undefined {
    return this.files.get(`/pub/pubky.app/posts/${postId}`);
  }

  async putJson(filePath: string, json: unknown): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("homeserver PUT failed");
    }
    const body = json as { parent?: string; content?: string };
    this.files.set(filePath, { parent: body.parent, content: body.content });
  }

  async putBytes(): Promise<void> {}

  async getJson(filePath: string): Promise<unknown> {
    return this.files.get(filePath) ?? null;
  }

  async deleteJson(): Promise<void> {}

  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith("/pub/pubky.app/posts/"))
      .map(([p, v]) => ({ parent: v.parent, uri: `pubky://${BOT}${p}` }));
  }

  async reauth(): Promise<void> {}
}

function reasonCfg(): Config {
  return {
    cannedReply: "Pubky is a key-based web of homeservers.",
    blocklist: new Set<string>(),
    knownBots: new Set<string>(),
    maxRepliesPerThread: 12,
    maxTurnsPerUserPerThread: 6,
    maxPerUserPerHour: 100,
    dailyTokenBudget: 10_000_000,
    userDailyTokenBudget: 10_000_000,
    modelDelayMs: 0,
    model: "canned",
  } as Config;
}

const publishCfg = { disabledEnv: false, maxPublishAttempts: 5 } as Config;

describe("operator requeue carries the persona snapshot through reason and publish", () => {
  let store: Store;
  let persona: RuntimePersona;

  beforeAll(async () => {
    const registered = loadPersonaRegistry({
      repositoryRoot: root,
      manifestDir: path.join(root, "personas"),
      enabledPersonaIds: ["jeb"],
    }).get("jeb");
    persona = createRuntimePersona(registered, { appUrl: "https://pubky.app" });
    store = new Store(DB);
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  // claimWork / claimPublish take the oldest global row: park other suites'
  // active rows for the duration of each test and restore them afterwards.
  let parkedWork: Array<{ id: string; status: string }> = [];
  let parkedPublish: Array<{ id: string; status: string }> = [];

  beforeEach(async () => {
    parkedWork = (
      await store.pool.query<{ id: string; status: string }>(
        "UPDATE work_queue w SET status = 'failed' FROM (SELECT id, status FROM work_queue WHERE status IN ('queued', 'claimed')) prior WHERE w.id = prior.id RETURNING w.id, prior.status",
      )
    ).rows;
    parkedPublish = (
      await store.pool.query<{ id: string; status: string }>(
        "UPDATE publish_requests p SET status = 'failed' FROM (SELECT id, status FROM publish_requests WHERE status IN ('queued', 'retry', 'publishing')) prior WHERE p.id = prior.id RETURNING p.id, prior.status",
      )
    ).rows;
    await store.pool.query("DELETE FROM switches");
  });

  afterEach(async () => {
    for (const row of parkedWork) {
      await store.pool.query("UPDATE work_queue SET status = $2 WHERE id = $1", [row.id, row.status]);
    }
    for (const row of parkedPublish) {
      await store.pool.query("UPDATE publish_requests SET status = $2 WHERE id = $1", [row.id, row.status]);
    }
  });

  async function reset(uri: string): Promise<void> {
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM evidence WHERE mention_key = $1", [uri]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [uri]);
  }

  async function claimAndReason(nexus: Nexus, generationBlocked?: () => Promise<boolean>): Promise<void> {
    const job = await store.claimWork();
    expect(job).not.toBeNull();
    expect(await rejectInvalidPersonaWorkSnapshot(store, job!, persona)).toBe(false);
    await reasonOne(reasonCfg(), store, nexus, new InjectionDetector(), BOT, job!, generationBlocked, undefined, persona);
  }

  async function publishNext(transport: RecordingHomeserver): Promise<void> {
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    try {
      await publishOne(store, transport, publishCfg, row!, createRunPublishHooks(() => store, persona));
    } catch (e) {
      await store.markPublishRetry(row!.id, String(e), row!.attempts);
      await store.pool.query("UPDATE publish_requests SET next_attempt_at = now() WHERE id = $1", [row!.id]);
      throw e;
    }
  }

  it("re-answers a mention whose earlier requeue was rejected for a missing snapshot", async () => {
    const id = "RQJOURNEY0001";
    const uri = post(USER, id);
    await reset(uri);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.enqueueWork(uri, USER, "mention", { mentionKey: uri });
    const legacy = await store.claimWork();
    expect(await rejectInvalidPersonaWorkSnapshot(store, legacy!, persona)).toBe(true);
    await store.finishWork(legacy!.id, "failed");
    expect((await store.get(uri))?.status).toBe("failed");

    const { server, url } = await listenNexus([mentionView(id)]);
    try {
      const nexus = new Nexus(url, 2_000);
      const result = await requeueOne({ uri, store, fetchPost: (u) => nexus.post(u), botPk: BOT, persona });
      expect(result).toEqual({ line: `requeued ${uri}`, ok: true });
      const queued = await store.pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM work_queue WHERE mention_key = $1 AND status = 'queued'",
        [uri],
      );
      expect(queued.rows[0]?.payload).toEqual({ mentionKey: uri, persona: personaWorkSnapshot(persona) });

      await claimAndReason(nexus);
      const evidence = await store.pool.query<{ tool_trace: unknown[] }>(
        "SELECT tool_trace FROM evidence WHERE mention_key = $1",
        [uri],
      );
      expect(evidence.rows).toHaveLength(1);
      expect(evidence.rows[0]?.tool_trace[0]).toMatchObject({ persona_snapshot: personaWorkSnapshot(persona) });

      const transport = new RecordingHomeserver();
      await publishNext(transport);
      const mention = await store.get(uri);
      expect(mention?.status).toBe("published");
      const replyId = mention!.reply_uri!.split("/").pop()!;
      expect(transport.replyAt(replyId)).toEqual({ parent: uri, content: reasonCfg().cannedReply });
    } finally {
      await closeServer(server);
    }
  });

  it("--replace keeps the published reply until the replacement PUT succeeds", async () => {
    const id = "RQJOURNEY0002";
    const uri = post(USER, id);
    const replyId = "0035N9BXXT9VH";
    const replyUri = post(BOT, replyId);
    await reset(uri);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    const priorEvidence = await store.insertEvidence({
      mentionKey: uri,
      intent: "answer",
      toolTrace: [{ persona_snapshot: personaWorkSnapshot(persona) }],
      sources: [],
      model: "canned",
      tokens: 1,
      latencyMs: 1,
    });
    await store.insertPublishRequest({ mentionKey: uri, parentUri: uri, content: "old answer", evidenceId: priorEvidence });
    await store.pool.query("UPDATE publish_requests SET status = 'published' WHERE mention_key = $1", [uri]);
    await store.mark(uri, "published", { replyUri, rootUri: uri });
    const transport = new RecordingHomeserver();
    transport.seedReply(replyId, uri, "old answer");

    const { server, url } = await listenNexus([mentionView(id)]);
    try {
      const nexus = new Nexus(url, 2_000);
      const result = await requeueOne({
        uri,
        store,
        fetchPost: (u) => nexus.post(u),
        botPk: BOT,
        persona,
        replace: true,
      });
      expect(result).toEqual({ line: `requeued ${uri} replacing ${replyUri}`, ok: true });
      const queued = await store.pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM work_queue WHERE mention_key = $1 AND status = 'queued'",
        [uri],
      );
      expect(queued.rows[0]?.payload).toEqual({
        mentionKey: uri,
        replace_post_id: replyId,
        persona: personaWorkSnapshot(persona),
      });

      await claimAndReason(nexus);
      const pending = await store.pool.query<{ replace_post_id: string | null; status: string }>(
        "SELECT replace_post_id, status FROM publish_requests WHERE mention_key = $1 ORDER BY id",
        [uri],
      );
      expect(pending.rows.map((r) => r.status)).toEqual(["superseded", "queued"]);
      expect(pending.rows[1]?.replace_post_id).toBe(replyId);
      expect(transport.replyAt(replyId)?.content).toBe("old answer");
      expect((await store.get(uri))?.reply_uri).toBe(replyUri);

      transport.failNextPut = true;
      await expect(publishNext(transport)).rejects.toThrow(/homeserver PUT failed/);
      expect(transport.replyAt(replyId)?.content).toBe("old answer");
      expect((await store.get(uri))?.reply_uri).toBe(replyUri);

      await publishNext(transport);
      expect(transport.replyAt(replyId)).toEqual({ parent: uri, content: reasonCfg().cannedReply });
      expect((await transport.listPosts()).filter((p) => p.parent === uri)).toHaveLength(1);
      const mention = await store.get(uri);
      expect(mention?.status).toBe("published");
      expect(mention?.reply_uri).toBe(replyUri);
    } finally {
      await closeServer(server);
    }
  });

  it("a requeue that ends in a fallback reply still publishes under the persona", async () => {
    const id = "RQJOURNEY0003";
    const uri = post(USER, id);
    await reset(uri);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.mark(uri, "failed");
    const { server, url } = await listenNexus([mentionView(id)]);
    try {
      const nexus = new Nexus(url, 2_000);
      expect((await requeueOne({ uri, store, fetchPost: (u) => nexus.post(u), botPk: BOT, persona })).ok).toBe(true);
      await claimAndReason(nexus, async () => true);
      const evidence = await store.pool.query<{ kind: string | null; tool_trace: unknown[] }>(
        "SELECT kind, tool_trace FROM evidence WHERE mention_key = $1",
        [uri],
      );
      expect(evidence.rows[0]?.kind).toBe("fallback");
      expect(evidence.rows[0]?.tool_trace[0]).toEqual({ persona_snapshot: personaWorkSnapshot(persona) });
      const transport = new RecordingHomeserver();
      await publishNext(transport);
      expect((await store.get(uri))?.status).toBe("published");
      const failed = await store.pool.query("SELECT 1 FROM publish_requests WHERE mention_key = $1 AND status = 'failed'", [uri]);
      expect(failed.rowCount).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("refuses a mention recorded under a snapshot this runtime cannot serve, without mutating it", async () => {
    const id = "RQJOURNEY0004";
    const uri = post(USER, id);
    const replyUri = post(BOT, "0035N9BXXT9VJ");
    await reset(uri);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    const historical = { id: "jeb", version: "1.0.0", hash: "1".repeat(64) };
    const evidenceId = await store.insertEvidence({
      mentionKey: uri,
      intent: "answer",
      toolTrace: [{ persona_snapshot: historical }],
      sources: [],
      model: "canned",
      tokens: 1,
      latencyMs: 1,
    });
    await store.insertPublishRequest({ mentionKey: uri, parentUri: uri, content: "old", evidenceId });
    await store.pool.query("UPDATE publish_requests SET status = 'published' WHERE mention_key = $1", [uri]);
    await store.mark(uri, "published", { replyUri, rootUri: uri });

    for (const replace of [true, false]) {
      const result = await requeueOne({ uri, store, fetchPost: async () => mentionView(id), botPk: BOT, persona, replace });
      expect(result.ok).toBe(false);
      expect(result.line).toBe(
        `skipped ${uri}: persisted persona snapshot jeb@1.0.0 (111111111111) from evidence is not the loaded ` +
          `runtime persona jeb@${persona.snapshot.pack.version} (${persona.snapshot.snapshotHash.slice(0, 12)})`,
      );
    }
    expect((await store.get(uri))?.status).toBe("published");
    const pubs = await store.pool.query<{ status: string }>("SELECT status FROM publish_requests WHERE mention_key = $1", [uri]);
    expect(pubs.rows.map((r) => r.status)).toEqual(["published"]);
    const work = await store.pool.query("SELECT 1 FROM work_queue WHERE mention_key = $1", [uri]);
    expect(work.rowCount).toBe(0);
  });

  it("refuses a work-routed snapshot for another persona and a malformed one", async () => {
    const id = "RQJOURNEY0005";
    const uri = post(USER, id);
    for (const [recorded, described] of [
      [{ id: "coach", version: "1.0.0", hash: "2".repeat(64) }, "coach@1.0.0 (222222222222)"],
      ["jeb", "malformed snapshot"],
    ] as const) {
      await reset(uri);
      expect(await store.claim(uri, USER, BOT)).toBe("claimed");
      await store.enqueueWork(uri, USER, "mention", { mentionKey: uri, persona: recorded });
      await store.pool.query("UPDATE work_queue SET status = 'failed' WHERE mention_key = $1", [uri]);
      await store.mark(uri, "failed");
      const result = await requeueOne({ uri, store, fetchPost: async () => mentionView(id), botPk: BOT, persona });
      expect(result.ok).toBe(false);
      expect(result.line).toContain(`persisted persona snapshot ${described} from work_queue`);
      expect((await store.get(uri))?.status).toBe("failed");
      expect(await store.hasActiveWork(uri, 180_000)).toBe(false);
    }
  });

  it("stamps the snapshot onto an active work item left without one", async () => {
    const id = "RQJOURNEY0006";
    const uri = post(USER, id);
    await reset(uri);
    expect(await store.claim(uri, USER, BOT)).toBe("claimed");
    await store.enqueueWork(uri, USER, "mention", { mentionKey: uri });
    const result = await requeueOne({ uri, store, fetchPost: async () => mentionView(id), botPk: BOT, persona });
    expect(result).toEqual({ line: `requeued ${uri}`, ok: true });
    const rows = await store.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM work_queue WHERE mention_key = $1",
      [uri],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.payload).toEqual({ mentionKey: uri, persona: personaWorkSnapshot(persona) });
    const job = await store.claimWork();
    expect(job?.mention_key).toBe(uri);
    expect(await rejectInvalidPersonaWorkSnapshot(store, job!, persona)).toBe(false);
    await reset(uri);
  });
});
