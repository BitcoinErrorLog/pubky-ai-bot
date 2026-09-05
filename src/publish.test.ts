import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import {
  applyArtifactTagOne,
  enqueueCollectionUpsert,
  enqueuePostTag,
  enqueueStandalonePost,
  publishOne,
  standaloneMentionKey,
  revokePostTag,
  runPublish,
  tagOne,
  TagsBlockedError,
} from "./publish.js";
import { applyTags, ARTIFACT_TAG_VOCAB, TAG_MAX_ATTEMPTS } from "./reply-tags.js";
import { collectionItemLimit, collectionPostId } from "./post.js";
import type { Config } from "./config.js";
import type { Transport } from "./homeserver.js";
import { log } from "./log.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

async function failQueuedPublish(store: Store): Promise<void> {
  await store.pool.query(
    `UPDATE publish_requests SET status = 'failed'
     WHERE status IN ('queued', 'retry', 'publishing')`,
  );
}

class FakeTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  puts = 0;
  listErrors = 0;
  protected posts: Array<{ parent?: string; uri: string }> = [];

  async putBytes(_path: string, _body: Uint8Array): Promise<void> {}

  lastPath = "";
  async putJson(_path: string, json: unknown): Promise<void> {
    this.puts += 1;
    this.lastPath = _path;
    const parent = typeof json === "object" && json && "parent" in json ? String((json as { parent?: string }).parent) : undefined;
    const id = _path.split("/").pop() ?? "0000000000001";
    const uri = `pubky://${this.botPk}/pub/pubky.app/posts/${id}`;
    const rec = { parent, uri };
    const i = this.posts.findIndex((p) => p.uri === uri);
    if (i >= 0) this.posts[i] = rec;
    else this.posts.push(rec);
  }

  async getJson(): Promise<unknown> {
    return { content: "ok", parent: this.posts[0]?.parent };
  }

  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    if (this.listErrors > 0) {
      this.listErrors -= 1;
      throw new Error("homeserver list failed");
    }
    return this.posts;
  }

  seedPost(parent: string | undefined, uri: string): void {
    this.posts.push({ parent, uri });
  }

  async reauth(): Promise<void> {}
  async deleteJson(): Promise<void> {}
}

const cfg = {
  disabledEnv: false,
  maxPublishAttempts: 5,
} as Config;

describe("publisher fail_first_attempt", () => {
  let store: Store;
  const parent = "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000001";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM publish_requests");
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [parent]);
  });
  afterAll(async () => {
    await store.close();
  });

  it("retries and publishes exactly once", async () => {
    expect(await store.claim(parent, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({
      mentionKey: parent,
      parentUri: parent,
      content: "hello",
      evidenceId: null,
      failFirstAttempt: true,
    });
    const t = new FakeTransport();
    const first = await store.claimPublish(5);
    expect(first).not.toBeNull();
    await expect(publishOne(store, t, cfg, first!)).rejects.toThrow(/fail_first_attempt/);
    await store.markPublishRetry(first!.id, "fail_first_attempt", first!.attempts);
    expect(t.puts).toBe(0);
    await new Promise((r) => setTimeout(r, 700));
    const second = await store.claimPublish(5);
    expect(second).not.toBeNull();
    await publishOne(store, t, cfg, second!);
    expect(t.puts).toBe(1);
    const third = await store.claimPublish(5);
    expect(third).toBeNull();
    const listed = await t.listPosts();
    expect(listed.filter((p) => p.parent === parent)).toHaveLength(1);
  });
});

describe("publisher auth re-signin (F3 / F-01)", () => {
  let store: Store;
  const parent = "pubky://2222222222222222222222222222222222222222222222222222/pub/pubky.app/posts/0000000000002";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [parent]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [parent]);
  });
  afterAll(async () => {
    await store.close();
  });

  it("reauths once on 401 and retries the PUT", async () => {
    expect(await store.claim(parent, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: parent, parentUri: parent, content: "hello", evidenceId: null });
    const t = new FakeTransport();
    let fails = 1;
    t.putJson = async function (this: FakeTransport, path: string, json: unknown) {
      if (fails > 0) {
        fails -= 1;
        const e = Object.assign(new Error("unauthorized"), { status: 401 });
        throw e;
      }
      return FakeTransport.prototype.putJson.call(this, path, json);
    };
    let reauths = 0;
    t.reauth = async () => {
      reauths += 1;
    };
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(reauths).toBe(1);
    expect(t.puts).toBe(1);
  });

  it("marks failed_auth and does not re-dequeue after persistent 403", async () => {
    const key = "pubky://3333333333333333333333333333333333333333333333333333/pub/pubky.app/posts/0000000000003";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null });
    const t = new FakeTransport();
    t.putJson = async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    };
    t.reauth = async () => {};
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await expect(publishOne(store, t, cfg, row!)).rejects.toMatchObject({ code: "failed_auth" });
    await store.markPublishFailedAuth(row!.id, "forbidden");
    const again = await store.claimPublish(5);
    expect(again).toBeNull();
    const st = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(st.rows[0]?.status).toBe("failed_auth");
  });
});

describe("publisher stale publishing reclaim (F-01)", () => {
  let store: Store;
  const STALE_MS = 120_000;

  async function seedStuckRow(key: string, stale: boolean): Promise<number> {
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null });
    const r = await store.pool.query<{ id: string }>(
      `UPDATE publish_requests SET status = 'publishing', attempts = 1,
         updated_at = now() - ($2::text || ' milliseconds')::interval
       WHERE mention_key = $1 RETURNING id`,
      [key, String(stale ? STALE_MS + 60_000 : 0)],
    );
    return Number(r.rows[0].id);
  }

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("crash after PUT: reclaim reconciles to published without a second PUT", async () => {
    const key = "pubky://4444444444444444444444444444444444444444444444444444/pub/pubky.app/posts/0000000000004";
    await seedStuckRow(key, true);
    // The PUT succeeded before the crash: the reply already exists homeserver-side.
    const t = new FakeTransport();
    t.seedPost(key, `pubky://${t.botPk}/pub/pubky.app/posts/0000000000009`);
    const row = await store.claimPublish(5, STALE_MS);
    expect(row, "stale publishing row must be reclaimed").not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.puts, "no second PUT — reconcile by parent").toBe(0);
    const mention = await store.get(key);
    expect(mention?.status).toBe("published");
    expect(mention?.reply_uri).toBe(`pubky://${t.botPk}/pub/pubky.app/posts/0000000000009`);
    const listed = await t.listPosts();
    expect(listed.filter((p) => p.parent === key)).toHaveLength(1);
    const st = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(st.rows[0]?.status).toBe("published");
  });

  it("crash before PUT: reclaim eventually publishes the reply", async () => {
    const key = "pubky://5555555555555555555555555555555555555555555555555555/pub/pubky.app/posts/0000000000005";
    await seedStuckRow(key, true);
    const t = new FakeTransport();
    const row = await store.claimPublish(5, STALE_MS);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(1);
    const mention = await store.get(key);
    expect(mention?.status).toBe("published");
    expect(await store.claimPublish(5, STALE_MS)).toBeNull();
  });

  it("does not reclaim a fresh publishing row (no double-claim in flight)", async () => {
    const key = "pubky://6666666666666666666666666666666666666666666666666666/pub/pubky.app/posts/0000000000006";
    await seedStuckRow(key, false);
    expect(await store.claimPublish(5, STALE_MS)).toBeNull();
  });

  it("marks exhausted rows failed (terminal, no infinite retry)", async () => {
    const key = "pubky://7777777777777777777777777777777777777777777777777777/pub/pubky.app/posts/0000000000007";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null });
    await store.pool.query(
      "UPDATE publish_requests SET status = 'retry', attempts = 5, next_attempt_at = now() - interval '1 minute' WHERE mention_key = $1",
      [key],
    );
    expect(await store.failExhaustedPublishes(5, STALE_MS)).toBe(1);
    const st = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(st.rows[0]?.status).toBe("failed");
    expect(await store.claimPublish(5, STALE_MS)).toBeNull();
  });
});

describe("reconcile list failure is not 'no posts' (F-05)", () => {
  let store: Store;
  const key = "pubky://8888888888888888888888888888888888888888888888888888/pub/pubky.app/posts/0000000000008";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
  });
  afterAll(async () => {
    await store.close();
  });

  it("list failure → no publish, row stays retryable; list success after failure → single publish", async () => {
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null });
    const t = new FakeTransport();
    t.listErrors = 1;
    const first = await store.claimPublish(5);
    expect(first).not.toBeNull();
    await expect(publishOne(store, t, cfg, first!)).rejects.toThrow(/list failed/);
    expect(t.puts, "no PUT while the listing is unknown").toBe(0);
    await store.markPublishRetry(first!.id, "list failed", first!.attempts);
    const st = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(st.rows[0]?.status).toBe("retry");
    await new Promise((r) => setTimeout(r, 700));
    const second = await store.claimPublish(5);
    expect(second, "row stays retryable after a list failure").not.toBeNull();
    await publishOne(store, t, cfg, second!);
    expect(t.puts).toBe(1);
    const listed = await t.listPosts();
    expect(listed.filter((p) => p.parent === key)).toHaveLength(1);
  });
});

describe("publisher skips mentions no longer processing (F-12)", () => {
  let store: Store;
  const key = "pubky://9999999999999999999999999999999999999999999999999999/pub/pubky.app/posts/0000000000009";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
  });
  afterAll(async () => {
    await store.close();
  });

  it("mention marked skipped after queueing → request closed without PUT", async () => {
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null });
    await store.mark(key, "skipped");
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.puts, "never PUT for a skipped mention").toBe(0);
    const st = await store.pool.query<{ status: string }>(
      "SELECT status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(st.rows[0]?.status).toBe("published");
    const mention = await store.get(key);
    expect(mention?.status).toBe("skipped");
  });

  it("mention marked failed after queueing → request closed without PUT", async () => {
    const failedKey = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/00000000000F1";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [failedKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [failedKey]);
    expect(await store.claim(failedKey, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: failedKey, parentUri: failedKey, content: "hello", evidenceId: null });
    await store.mark(failedKey, "failed");
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(0);
    const mention = await store.get(failedKey);
    expect(mention?.status).toBe("failed");
  });

  it("publishes when the mention is still processing (F-12 does not skip)", async () => {
    const procKey = "pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/00000000000P1";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [procKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [procKey]);
    expect(await store.claim(procKey, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: procKey, parentUri: procKey, content: "hello", evidenceId: null });
    const mention = await store.get(procKey);
    expect(mention?.status).toBe("processing");
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(1);
    expect((await store.get(procKey))?.status).toBe("published");
  });
});

/** Path-aware fake homeserver: post PUTs populate the listing; tag PUTs are recorded separately. */
class TagAwareTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  posts: Array<{ parent?: string; uri: string }> = [];
  tagPuts: Array<{ path: string; json: { uri?: string; label?: string } }> = [];
  tagFailures = 0;

  async putJson(path: string, json: unknown): Promise<void> {
    if (path.includes("/tags/")) {
      if (this.tagFailures > 0) {
        this.tagFailures -= 1;
        throw new Error("homeserver tag PUT failed");
      }
      this.tagPuts.push({ path, json: json as { uri?: string; label?: string } });
      return;
    }
    const parent = typeof json === "object" && json && "parent" in json ? String((json as { parent?: string }).parent) : undefined;
    const id = path.split("/").pop() ?? "00000000000T1";
    const uri = `pubky://${this.botPk}/pub/pubky.app/posts/${id}`;
    const rec = { parent, uri };
    const i = this.posts.findIndex((p) => p.uri === uri);
    if (i >= 0) this.posts[i] = rec;
    else this.posts.push(rec);
  }

  async putBytes(): Promise<void> {}
  async getJson(): Promise<unknown> {
    return { content: "ok" };
  }
  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return this.posts;
  }
  async reauth(): Promise<void> {}
  async deleteJson(): Promise<void> {}
}

const tagCfg = {
  disabledEnv: false,
  maxPublishAttempts: 5,
  selfTags: true,
} as Config;

describe("publisher category self-tags (ticket 12c)", () => {
  let store: Store;

  async function seedPublished(key: string, categories: string[]): Promise<{ transport: TagAwareTransport }> {
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "hello", evidenceId: null, categories });
    const transport = new TagAwareTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, transport, tagCfg, row!);
    expect((await store.get(key))?.status).toBe("published");
    return { transport };
  }

  async function tagRow(key: string): Promise<{ tag_uris: unknown; tag_attempts: number; status: string }> {
    const r = await store.pool.query<{ tag_uris: unknown; tag_attempts: number; status: string }>(
      "SELECT tag_uris, tag_attempts, status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    return r.rows[0]!;
  }

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("tags the reply after publish and records tag_uris (idempotent: skipped once recorded)", async () => {
    const key = "pubky://cccccccccccccccccccccccccccccccccccccccccccccccccccc/pub/pubky.app/posts/0000000000001";
    const { transport } = await seedPublished(key, ["answer", "pubky"]);
    const pending = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    expect(pending).not.toBeNull();
    expect(pending!.mention_key).toBe(key);
    expect(pending!.categories).toEqual(["answer", "pubky"]);
    const replyUri = (await store.get(key))!.reply_uri!;
    expect(pending!.reply_uri).toBe(replyUri);
    await tagOne(store, transport, tagCfg, pending!);
    expect(transport.tagPuts).toHaveLength(2);
    for (const [i, put] of transport.tagPuts.entries()) {
      expect(put.path).toMatch(/^\/pub\/pubky\.app\/tags\/.+/);
      expect(put.json.uri).toBe(replyUri);
      expect(put.json.label).toBe(["answer", "pubky"][i]);
      // Tags are not posts: the reply listing is untouched by tag PUTs.
      expect(transport.posts.filter((p) => p.parent === key)).toHaveLength(1);
    }
    const recorded = (await tagRow(key)).tag_uris;
    expect(Array.isArray(recorded) && recorded.length).toBe(2);
    for (const uri of recorded as string[]) {
      expect(uri).toMatch(new RegExp(`^pubky://${transport.botPk}/pub/pubky\\.app/tags/.+`));
    }
    expect(await store.claimPendingTags(TAG_MAX_ATTEMPTS), "already recorded → never re-tagged").toBeNull();
  });

  it("self-mode applyTags leaves the same DB trace as publisher tagOne", async () => {
    const tagOneKey = "pubky://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/pub/pubky.app/posts/SELFTAGONE001";
    const applyKey = "pubky://ffffffffffffffffffffffffffffffffffffffffffffffffffff/pub/pubky.app/posts/SELFTAGAPPLY1";
    const { transport: t1 } = await seedPublished(tagOneKey, ["answer", "pubky"]);
    const pending = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    expect(pending?.mention_key).toBe(tagOneKey);
    await tagOne(store, t1, tagCfg, pending!);
    const viaTagOne = (await tagRow(tagOneKey)).tag_uris;

    const { transport: t2 } = await seedPublished(applyKey, ["answer", "pubky"]);
    const replyUri = (await store.get(applyKey))!.reply_uri!;
    const out = await applyTags(
      { targetUri: replyUri, labels: ["answer", "pubky"], mode: "self" },
      { store, transport: t2, cfg: tagCfg },
    );
    const viaApply = (await tagRow(applyKey)).tag_uris;
    expect(Array.isArray(viaTagOne) && viaTagOne.length).toBe(2);
    expect(viaApply).toEqual(out.uris);
    expect(Array.isArray(viaApply) && viaApply.length).toBe(2);
    for (const uri of viaApply as string[]) {
      expect(uri).toMatch(new RegExp(`^pubky://${t2.botPk}/pub/pubky\\.app/tags/.+`));
    }
    const stillPending = await store.pool.query<{ id: number }>(
      "SELECT id FROM publish_requests WHERE mention_key = $1 AND tag_uris IS NULL",
      [applyKey],
    );
    expect(stillPending.rows).toHaveLength(0);
  });

  it("kill switch blocks the tag PUTs without consuming an attempt", async () => {
    const key = "pubky://dddddddddddddddddddddddddddddddddddddddddddddddddddd/pub/pubky.app/posts/0000000000002";
    const { transport } = await seedPublished(key, ["answer"]);
    const pending = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    expect(pending).not.toBeNull();
    process.env.JEB_SWITCH_REPLIES = "1";
    try {
      await expect(tagOne(store, transport, tagCfg, pending!)).rejects.toBeInstanceOf(TagsBlockedError);
    } finally {
      delete process.env.JEB_SWITCH_REPLIES;
    }
    expect(transport.tagPuts, "no tag PUT while the replies switch is on").toHaveLength(0);
    const row = await tagRow(key);
    expect(row.tag_uris).toBeNull();
    expect(row.tag_attempts, "a blocked pass is not an attempt").toBe(0);
    await tagOne(store, transport, tagCfg, pending!);
    expect(transport.tagPuts).toHaveLength(1);
    expect(Array.isArray((await tagRow(key)).tag_uris)).toBe(true);
  });

  it("JEB_SELF_TAGS=0 disables tagging (no PUTs, row stays untagged)", async () => {
    const key = "pubky://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/pub/pubky.app/posts/0000000000003";
    const { transport } = await seedPublished(key, ["answer"]);
    const pending = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    expect(pending).not.toBeNull();
    const disabledCfg = { ...tagCfg, selfTags: false } as Config;
    await tagOne(store, transport, disabledCfg, pending!);
    expect(transport.tagPuts).toHaveLength(0);
    expect((await tagRow(key)).tag_uris).toBeNull();
    // cleanup so the pending row does not leak into later assertions
    await store.markTagsDone(pending!.id, []);
  });

  it("tag failure never fails the publish; retried up to 3 attempts then given up", async () => {
    const key = "pubky://ffffffffffffffffffffffffffffffffffffffffffffffffffff/pub/pubky.app/posts/0000000000004";
    const { transport } = await seedPublished(key, ["answer", "graph"]);
    transport.tagFailures = 100; // every tag PUT fails
    for (let attempt = 1; attempt <= TAG_MAX_ATTEMPTS; attempt++) {
      const pending = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
      expect(pending, `attempt ${attempt} is claimable`).not.toBeNull();
      await tagOne(store, transport, tagCfg, pending!);
      const row = await tagRow(key);
      expect(row.status, "publish stays published despite tag failures").toBe("published");
      expect(row.tag_uris).toBeNull();
      expect(row.tag_attempts).toBe(attempt);
      expect((await store.get(key))?.status).toBe("published");
    }
    expect(await store.claimPendingTags(TAG_MAX_ATTEMPTS), "gives up after the attempt cap").toBeNull();
    // And the reply itself was published exactly once.
    expect(transport.posts.filter((p) => p.parent === key)).toHaveLength(1);
  });

  it("recovers when a later attempt succeeds: tags written and recorded", async () => {
    const key = "pubky://9999999999999999999999999999999999999999999999999999/pub/pubky.app/posts/00000000000T9";
    const { transport } = await seedPublished(key, ["answer"]);
    transport.tagFailures = 1;
    const first = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    await tagOne(store, transport, tagCfg, first!);
    expect((await tagRow(key)).tag_attempts).toBe(1);
    const second = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
    expect(second).not.toBeNull();
    await tagOne(store, transport, tagCfg, second!);
    expect(transport.tagPuts).toHaveLength(1);
    expect(Array.isArray((await tagRow(key)).tag_uris)).toBe(true);
    expect(await store.claimPendingTags(TAG_MAX_ATTEMPTS)).toBeNull();
  });
});

describe("publisher stop awaits in-flight tick before ending the pool", () => {
  let store: Store;
  const key = "pubky://ssssssssssssssssssssssssssssssssssssssssssssssssssss/pub/pubky.app/posts/00000000000ST";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
  });
  afterAll(async () => {
    await store.close();
  });

  it("stop() waits for a slow PUT; no pool-after-end; no activity after stop resolves", async () => {
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({
      mentionKey: key,
      parentUri: key,
      content: "hello",
      evidenceId: null,
      categories: ["answer"],
    });
    const t = new FakeTransport();
    t.putJson = async function (this: FakeTransport, path: string, json: unknown) {
      await new Promise((r) => setTimeout(r, 500));
      return FakeTransport.prototype.putJson.call(this, path, json);
    };
    const warnSpy = vi.spyOn(log, "warn");
    const errorSpy = vi.spyOn(log, "error");
    const loopCfg = {
      disabledEnv: false,
      maxPublishAttempts: 5,
      publishStaleMs: 120_000,
      selfTags: true,
      databaseUrl: url,
      secretKeyHex: "00".repeat(32),
    } as Config;
    const stop = await runPublish(loopCfg, { transport: t });
    await stop();
    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      .join("\n");
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    expect(logged, "must not use the pool after end").not.toMatch(/pool after calling end/i);
    expect(logged).not.toMatch(/Cannot use a pool after calling end/i);
    expect(t.puts, "exactly one reply PUT").toBe(1);
    const mention = await store.get(key);
    expect(mention?.status).toBe("published");
    const listed = await t.listPosts();
    expect(listed.filter((p) => p.parent === key)).toHaveLength(1);
    const snapshot = await store.pool.query<{ tag_uris: unknown; updated_at: Date; status: string }>(
      "SELECT tag_uris, updated_at, status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    const putsAfterStop = t.puts;
    await new Promise((r) => setTimeout(r, 600));
    expect(t.puts, "no PUT after stop resolves").toBe(putsAfterStop);
    const later = await store.pool.query<{ tag_uris: unknown; updated_at: Date; status: string }>(
      "SELECT tag_uris, updated_at, status FROM publish_requests WHERE mention_key = $1",
      [key],
    );
    expect(later.rows[0]?.status).toBe(snapshot.rows[0]?.status);
    expect(JSON.stringify(later.rows[0]?.tag_uris)).toBe(JSON.stringify(snapshot.rows[0]?.tag_uris));
    expect(later.rows[0]?.updated_at.getTime()).toBe(snapshot.rows[0]?.updated_at.getTime());
  });
});

/** Captures the post JSON content actually PUT under the bot key. */
class ContentCaptureTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  contents: string[] = [];
  lastPath = "";

  async putJson(path: string, json: unknown): Promise<void> {
    if (path.includes("/tags/")) return;
    this.lastPath = path;
    this.contents.push(String((json as { content?: unknown }).content ?? ""));
  }
  async putBytes(): Promise<void> {}
  async getJson(): Promise<unknown> {
    return { content: "ok" };
  }
  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return [];
  }
  async reauth(): Promise<void> {}
  async deleteJson(): Promise<void> {}
}

describe("publisher secret scrubber (last gate before the PUT)", () => {
  let store: Store;
  const scrubKey = "pubky://cccccccccccccccccccccccccccccccccccccccccccccccccccc/pub/pubky.app/posts/00000000000S1";
  const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  beforeAll(async () => {
    // The outbound gate value-matches configured key material; the fixture
    // hex below stands in for the signing key for the duration of this suite.
    process.env.PUBKY_BOT_SECRET_KEY_HEX = HEX;
    store = new Store(url);
    await store.migrate();
    await failQueuedPublish(store);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [scrubKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [scrubKey]);
  });
  afterAll(async () => {
    delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
    await store.close();
  });

  it("never PUTs secret-shaped content; publishes the deterministic decline instead", async () => {
    expect(await store.claim(scrubKey, "author", "bot")).toBe("claimed");
    const evidenceId = await store.insertEvidence({
      mentionKey: scrubKey,
      intent: "answer",
      toolTrace: [],
      sources: [],
      model: "canned",
      tokens: 0,
      latencyMs: 1,
    });
    await store.insertPublishRequest({
      mentionKey: scrubKey,
      parentUri: scrubKey,
      content: `sure, here it is: ${HEX}`,
      evidenceId,
      categories: ["answer"],
    });
    const t = new ContentCaptureTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.contents).toHaveLength(1);
    expect(t.contents[0]).not.toContain(HEX);
    expect(t.contents[0]).toBe("I don't share configuration or credentials, mine or anyone's.");
    expect((await store.get(scrubKey))?.status).toBe("published");
    // security_event recorded in evidence (rule ids only) and categories downgraded.
    const ev = await store.pool.query<{ voice_violations: unknown }>("SELECT voice_violations FROM evidence WHERE id = $1", [
      evidenceId,
    ]);
    expect(JSON.stringify(ev.rows[0]?.voice_violations)).toContain("security_event");
    expect(JSON.stringify(ev.rows[0]?.voice_violations)).toMatch(/env_secret|key_material/);
    expect(JSON.stringify(ev.rows[0]?.voice_violations)).not.toContain(HEX);
    const pr = await store.pool.query<{ categories: unknown; scrubbed: boolean }>(
      "SELECT categories, scrubbed FROM publish_requests WHERE mention_key = $1",
      [scrubKey],
    );
    expect(JSON.stringify(pr.rows[0]?.categories)).toBe(JSON.stringify(["declined"]));
    // The scrub is persisted so retries publish the decline without re-scanning.
    expect(pr.rows[0]?.scrubbed).toBe(true);
  });

  it("a retried scrubbed row publishes the decline without re-scanning or duplicating evidence", async () => {
    const retryKey = "pubky://cccccccccccccccccccccccccccccccccccccccccccccccccccc/pub/pubky.app/posts/00000000000S3";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [retryKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [retryKey]);
    expect(await store.claim(retryKey, "author", "bot")).toBe("claimed");
    const evidenceId = await store.insertEvidence({
      mentionKey: retryKey,
      intent: "answer",
      toolTrace: [],
      sources: [],
      model: "canned",
      tokens: 0,
      latencyMs: 1,
    });
    await store.insertPublishRequest({
      mentionKey: retryKey,
      parentUri: retryKey,
      content: `sure, here it is: ${HEX}`,
      evidenceId,
      categories: ["declined"],
    });
    // Simulate an earlier attempt that fired the gate but crashed before the
    // PUT: the row carries scrubbed=true and evidence was recorded once.
    await store.pool.query("UPDATE publish_requests SET scrubbed = TRUE WHERE mention_key = $1", [retryKey]);
    await store.appendEvidenceSecurityEvents(evidenceId, ["key_material"]);
    const before = await store.pool.query<{ voice_violations: unknown }>(
      "SELECT voice_violations FROM evidence WHERE id = $1",
      [evidenceId],
    );
    const t = new ContentCaptureTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.mention_key).toBe(retryKey);
    expect(row!.scrubbed).toBe(true);
    await publishOne(store, t, cfg, row!);
    expect(t.contents).toHaveLength(1);
    expect(t.contents[0]).toBe("I don't share configuration or credentials, mine or anyone's.");
    // Evidence is unchanged: no duplicate security_event entries on retry.
    const after = await store.pool.query<{ voice_violations: unknown }>(
      "SELECT voice_violations FROM evidence WHERE id = $1",
      [evidenceId],
    );
    expect(JSON.stringify(after.rows[0]?.voice_violations)).toBe(JSON.stringify(before.rows[0]?.voice_violations));
  });

  it("publishes clean content untouched", async () => {
    const cleanKey = "pubky://cccccccccccccccccccccccccccccccccccccccccccccccccccc/pub/pubky.app/posts/00000000000S2";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [cleanKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [cleanKey]);
    expect(await store.claim(cleanKey, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({
      mentionKey: cleanKey,
      parentUri: cleanKey,
      content: "Pubky homeservers keep your data portable.",
      evidenceId: null,
    });
    const t = new ContentCaptureTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    await publishOne(store, t, cfg, row!);
    expect(t.contents[0]).toBe("Pubky homeservers keep your data portable.");
  });
});


describe("publisher in-place replace", () => {
  let store: Store;
  const parent = "pubky://4444444444444444444444444444444444444444444444444444/pub/pubky.app/posts/REPLPARENT001";
  const replaceId = "0035N9BXXT9VG";
  const botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const existingUri = `pubky://${botPk}/pub/pubky.app/posts/${replaceId}`;

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await failQueuedPublish(store);
  });
  afterAll(async () => {
    await store.close();
  });

  it("PUTs the reply at replace_post_id with parent set and does not duplicate on retry", async () => {
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [parent]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [parent]);
    expect(await store.claim(parent, "author", "bot")).toBe("claimed");
    expect(
      await store.insertPublishRequest({
        mentionKey: parent,
        parentUri: parent,
        content: "corrected answer",
        evidenceId: null,
        replacePostId: replaceId,
      }),
    ).toBe(true);
    const t = new FakeTransport();
    t.seedPost(parent, existingUri);
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.replace_post_id).toBe(replaceId);
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(1);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${replaceId}`);
    const listed = await t.listPosts();
    expect(listed.filter((p) => p.parent === parent)).toHaveLength(1);
    expect(listed[0]?.uri).toBe(existingUri);
    expect((await store.get(parent))?.reply_uri).toBe(existingUri);

    await store.pool.query(
      `UPDATE publish_requests SET status = 'retry', next_attempt_at = now() WHERE mention_key = $1`,
      [parent],
    );
    const again = await store.claimPublish(5);
    expect(again).not.toBeNull();
    await publishOne(store, t, cfg, again!);
    expect(t.puts).toBe(1);
    expect((await t.listPosts()).filter((p) => p.parent === parent)).toHaveLength(1);
  });

  it("fails the row loudly and never PUTs when replace_post_id fails the shape check", async () => {
    const badParent = "pubky://5555555555555555555555555555555555555555555555555555/pub/pubky.app/posts/REPLBADID0001";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [badParent]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [badParent]);
    expect(await store.claim(badParent, "author", "bot")).toBe("claimed");
    expect(
      await store.insertPublishRequest({
        mentionKey: badParent,
        parentUri: badParent,
        content: "corrected answer",
        evidenceId: null,
        replacePostId: "../../etc/passwd",
      }),
    ).toBe(true);
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.mention_key).toBe(badParent);
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM publish_requests WHERE mention_key = $1",
      [badParent],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toContain("replace_post_id");
    // The mention is left for operator inspection, not marked published.
    expect((await store.get(badParent))?.status).not.toBe("published");
  });
});

describe("standalone posts, collections, and artifact tags", () => {
  let store: Store;
  const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const foreign = "pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/00000000000TG";

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await failQueuedPublish(store);
  });
  afterAll(async () => {
    delete process.env.JEB_SWITCH_PROACTIVE;
    delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
    await store.close();
  });

  it("standalone publish row PUTs at posts path with the queued id", async () => {
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key LIKE 'standalone:%'");
    const queued = await enqueueStandalonePost(store, {
      content: "Weekly Pubky notes.",
      kind: "short",
      approvedBy: "operator",
    });
    expect(queued.inserted).toBe(true);
    expect(queued.postId).toMatch(/^[A-F0-9]{13}$/);
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.standalone).toBe(true);
    expect(row!.replace_post_id).toBe(queued.postId);
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(1);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${queued.postId}`);
  });

  it("proactive switch blocks standalone and artifact tags but not replies", async () => {
    const replyKey = "pubky://6666666666666666666666666666666666666666666666666666/pub/pubky.app/posts/PROACTIVEREPL";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [replyKey]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [replyKey]);
    await store.pool.query("DELETE FROM artifact_tags");
    expect(await store.claim(replyKey, "author", "bot")).toBe("claimed");
    await store.insertPublishRequest({ mentionKey: replyKey, parentUri: replyKey, content: "reply ok", evidenceId: null });
    await enqueueStandalonePost(store, { content: "proactive post", kind: "short", approvedBy: "op" });
    await enqueuePostTag(store, { postUri: foreign, label: "debate", approvedBy: "op" });
    process.env.JEB_SWITCH_PROACTIVE = "1";
    try {
      const t = new FakeTransport();
      const first = await store.claimPublish(5);
      expect(first).not.toBeNull();
      if (first!.standalone) {
        await expect(publishOne(store, t, cfg, first!)).rejects.toThrow(/proactive switch on/);
        await store.markPublishRetry(first!.id, "proactive switch on", first!.attempts);
        const replyRow = await store.claimPublish(5);
        expect(replyRow).not.toBeNull();
        expect(replyRow!.standalone).toBe(false);
        await publishOne(store, t, cfg, replyRow!);
        expect(t.puts).toBe(1);
      } else {
        await publishOne(store, t, cfg, first!);
        expect(t.puts).toBe(1);
        const stand = await store.claimPublish(5);
        expect(stand?.standalone).toBe(true);
        await expect(publishOne(store, t, cfg, stand!)).rejects.toThrow(/proactive switch on/);
      }
      const tagRow = await store.claimPendingArtifactTag(3);
      expect(tagRow).not.toBeNull();
      await expect(applyArtifactTagOne(store, t, cfg, tagRow!)).rejects.toBeInstanceOf(TagsBlockedError);
    } finally {
      delete process.env.JEB_SWITCH_PROACTIVE;
    }
  });

  it("collection envelope is valid and the post id is deterministic from the title", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const title = "Recurring: homeservers";
    expect(collectionPostId(title)).toBe(collectionPostId(title));
    const first = await enqueueCollectionUpsert(store, {
      title,
      description: "notes",
      itemUris: [foreign],
      layout: "list",
      approvedBy: "op",
    });
    expect(first.inserted).toBe(true);
    expect(first.postId).toBe(collectionPostId(title));
    const env = JSON.parse(first.content) as { name: string; items: string[]; layout?: string };
    expect(env.name).toBe(title);
    expect(env.items).toEqual([foreign]);
    expect(env.layout).toBe("list");
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row?.post_kind).toBe("collection");
    await publishOne(store, t, cfg, row!);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${first.postId}`);
  });

  it("allows empty collection items for seed envelopes and rejects over-cap", async () => {
    const empty = await enqueueCollectionUpsert(store, {
      title: "empty seed",
      description: "",
      itemUris: [],
      approvedBy: "op",
    });
    expect(empty.inserted).toBe(true);
    const cap = collectionItemLimit();
    const tooMany = Array.from({ length: cap + 1 }, () => foreign);
    await expect(
      enqueueCollectionUpsert(store, { title: "cap", description: "", itemUris: tooMany, approvedBy: "op" }),
    ).rejects.toThrow(/collectionItemsMaxCount/);
    await expect(
      enqueueCollectionUpsert(store, {
        title: "bad",
        description: "",
        itemUris: ["https://example.com/x"],
        approvedBy: "op",
      }),
    ).rejects.toThrow(/pubky:\/\//);
  });

  it("proactive switch blocks collection upserts", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const queued = await enqueueCollectionUpsert(store, {
      title: "switch-gated collection",
      description: "x",
      itemUris: [foreign],
      approvedBy: "op",
    });
    process.env.JEB_SWITCH_PROACTIVE = "1";
    try {
      const t = new FakeTransport();
      const row = await store.claimPublish(5);
      expect(row?.mention_key).toBe(queued.mentionKey);
      await expect(publishOne(store, t, cfg, row!)).rejects.toThrow(/proactive switch on/);
      expect(t.puts).toBe(0);
    } finally {
      delete process.env.JEB_SWITCH_PROACTIVE;
    }
  });

  it("repeated collection upserts re-PUT the same path", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const title = "In-place collection";
    const other = "pubky://cccccccccccccccccccccccccccccccccccccccccccccccccccc/pub/pubky.app/posts/00000000000C2";
    const first = await enqueueCollectionUpsert(store, {
      title,
      description: "v1",
      itemUris: [foreign],
      approvedBy: "op",
    });
    const t = new FakeTransport();
    const row1 = await store.claimPublish(5);
    await publishOne(store, t, cfg, row1!);
    expect(t.puts).toBe(1);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${first.postId}`);
    const second = await enqueueCollectionUpsert(store, {
      title,
      description: "v2",
      itemUris: [foreign, other],
      approvedBy: "op",
    });
    expect(second.postId).toBe(first.postId);
    expect(second.inserted).toBe(true);
    const row2 = await store.claimPublish(5);
    expect(row2?.replace_post_id).toBe(first.postId);
    await publishOne(store, t, cfg, row2!);
    expect(t.puts).toBe(2);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${first.postId}`);
  });

  it("rejects artifact labels that fail open-vocabulary policy", async () => {
    await expect(enqueuePostTag(store, { postUri: foreign, label: "Hello", approvedBy: "op" })).rejects.toThrow(
      /invalid tag label/,
    );
    expect(ARTIFACT_TAG_VOCAB).toEqual(["sources-cited", "debate", "release-notes"]);
  });

  it("revoke deletes the tag object path", async () => {
    const t = new FakeTransport();
    const deleted: string[] = [];
    t.deleteJson = async (path: string) => {
      deleted.push(path);
    };
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    await enqueuePostTag(store, { postUri: foreign, label: "release-notes", approvedBy: "op" });
    const pending = await store.claimPendingArtifactTag(3);
    expect(pending).not.toBeNull();
    await applyArtifactTagOne(store, t, cfg, pending!);
    await revokePostTag(store, t, { postUri: foreign, label: "release-notes", approvedBy: "op" });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^\/pub\/pubky\.app\/tags\//);
    const listed = await store.listArtifactTags();
    expect(listed.some((r) => r.label === "release-notes" && r.status === "revoked")).toBe(true);
  });

  it("scrubber still runs on standalone content", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = HEX;
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    await store.pool.query("DELETE FROM publish_requests WHERE content LIKE '%sure, here it is%'");
    const queued = await enqueueStandalonePost(store, {
      content: `sure, here it is: ${HEX}`,
      kind: "short",
      approvedBy: "op",
    });
    const t = new ContentCaptureTransport();
    const row = await store.claimPublish(5);
    expect(row?.mention_key).toBe(queued.mentionKey);
    await publishOne(store, t, cfg, row!);
    expect(t.contents).toHaveLength(1);
    expect(t.contents[0]).not.toContain(HEX);
    expect(t.contents[0]).toBe("I don't share configuration or credentials, mine or anyone's.");
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${queued.postId}`);
    delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  });

  it("fails an unapproved standalone row and never PUTs", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const content = "unapproved standalone body";
    const mentionKey = standaloneMentionKey({ content, kind: "short" });
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionKey]);
    await store.pool.query(
      `INSERT INTO publish_requests (
         mention_key, parent_uri, content, evidence_id, standalone, post_kind, replace_post_id, approved_by
       ) VALUES ($1, $1, $2, null, true, 'short', 'ABCDEFGHIJKLM', null)`,
      [mentionKey, content],
    );
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.approved_by).toBeNull();
    expect(row!.standalone).toBe(true);
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM publish_requests WHERE mention_key = $1",
      [mentionKey],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toContain("approved_by");
  });

  it("fails an unapproved collection row and never PUTs", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const mentionKey = "collection:unapproved-a1-fix";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionKey]);
    await store.pool.query(
      `INSERT INTO publish_requests (
         mention_key, parent_uri, content, evidence_id, standalone, post_kind, replace_post_id, approved_by
       ) VALUES ($1, $1, $2, null, true, 'collection', 'NOPQRSTUVWXYZ', null)`,
      [mentionKey, JSON.stringify({ name: "unapproved", items: [foreign] })],
    );
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.approved_by).toBeNull();
    expect(row!.post_kind).toBe("collection");
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM publish_requests WHERE mention_key = $1",
      [mentionKey],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toContain("approved_by");
  });

  it("publishes an approved standalone row", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const queued = await enqueueStandalonePost(store, {
      content: "approved standalone still publishes",
      kind: "short",
      approvedBy: "operator",
    });
    expect(queued.inserted).toBe(true);
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.approved_by).toBe("operator");
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(1);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${queued.postId}`);
  });

  it("fails a standalone row whose mention_key does not match the content-seed hash", async () => {
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed' WHERE standalone AND status IN ('queued','retry','publishing')`,
    );
    const content = "mention key mismatch body";
    const mentionKey = "standalone:" + "0".repeat(64);
    expect(mentionKey).not.toBe(standaloneMentionKey({ content, kind: "short" }));
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [mentionKey]);
    await store.pool.query(
      `INSERT INTO publish_requests (
         mention_key, parent_uri, content, evidence_id, standalone, post_kind, replace_post_id, approved_by
       ) VALUES ($1, $1, $2, null, true, 'short', '1234567890ABC', 'operator')`,
      [mentionKey, content],
    );
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.approved_by).toBe("operator");
    await publishOne(store, t, cfg, row!);
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM publish_requests WHERE mention_key = $1",
      [mentionKey],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toContain("mention_key");
  });

  it("fails an artifact tag row with empty approved_by and never PUTs", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    await enqueuePostTag(store, { postUri: foreign, label: "debate", approvedBy: "op" });
    const pending = await store.claimPendingArtifactTag(3);
    expect(pending).not.toBeNull();
    expect(pending!.approved_by).toBe("op");
    const t = new FakeTransport();
    await applyArtifactTagOne(store, t, cfg, { ...pending!, approved_by: "" });
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM artifact_tags WHERE id = $1",
      [pending!.id],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toContain("approved_by");
  });

  it("fails jeb-answered artifact tags when the bot has not replied", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [foreign]);
    await enqueuePostTag(store, { postUri: foreign, label: "homeserver", approvedBy: "jeb-answered" });
    const pending = await store.claimPendingArtifactTag(3);
    expect(pending).not.toBeNull();
    const t = new FakeTransport();
    await applyArtifactTagOne(store, t, cfg, pending!);
    expect(t.puts).toBe(0);
    const after = await store.pool.query<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM artifact_tags WHERE id = $1",
      [pending!.id],
    );
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.last_error).toMatch(/operator approved_by/);
  });

  it("allows jeb-answered artifact tags after Jeb published a reply", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    await store.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, reply_uri, author)
       VALUES ($1, 'published', $2, $3)
       ON CONFLICT (mention_key) DO UPDATE SET status = 'published', reply_uri = EXCLUDED.reply_uri`,
      [foreign, "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/REPLY00000001", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    );
    await enqueuePostTag(store, { postUri: foreign, label: "homeserver", approvedBy: "jeb-answered" });
    const pending = await store.claimPendingArtifactTag(3);
    expect(pending).not.toBeNull();
    const t = new FakeTransport();
    await applyArtifactTagOne(store, t, cfg, pending!);
    expect(t.puts).toBe(1);
  });

  it("rejects an empty approved_by insert at the SQL CHECK", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1 AND label = $2", [foreign, "sources-cited"]);
    await expect(
      store.pool.query(`INSERT INTO artifact_tags (post_uri, label, approved_by) VALUES ($1, 'sources-cited', '')`, [
        foreign,
      ]),
    ).rejects.toThrow(/artifact_tags_approved_by_nonempty|check constraint/i);
  });

  it("simulated race (revoked between claim and done) leaves row revoked and tag deleted", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    await enqueuePostTag(store, { postUri: foreign, label: "debate", approvedBy: "op" });
    const pending = await store.claimPendingArtifactTag(3);
    expect(pending).not.toBeNull();
    expect(pending!.approved_by).toBe("op");
    const t = new FakeTransport();
    const deleted: string[] = [];
    t.deleteJson = async (path: string) => {
      deleted.push(path);
    };
    await revokePostTag(store, t, { postUri: foreign, label: "debate", approvedBy: "op" });
    expect(deleted).toHaveLength(1);
    await applyArtifactTagOne(store, t, cfg, pending!);
    expect(t.puts).toBe(1);
    expect(deleted.length).toBeGreaterThanOrEqual(2);
    const listed = await store.listArtifactTags();
    expect(listed.some((r) => r.post_uri === foreign && r.label === "debate" && r.status === "revoked")).toBe(true);
    expect(listed.some((r) => r.post_uri === foreign && r.label === "debate" && r.status === "published")).toBe(false);
  });

  it("revoke without an approval row refuses and does not DELETE", async () => {
    await store.pool.query("DELETE FROM artifact_tags WHERE post_uri = $1", [foreign]);
    const t = new FakeTransport();
    const deleted: string[] = [];
    t.deleteJson = async (path: string) => {
      deleted.push(path);
    };
    await expect(revokePostTag(store, t, { postUri: foreign, label: "debate", approvedBy: "op" })).rejects.toThrow(
      /no artifact tag approval row/,
    );
    expect(deleted).toHaveLength(0);
  });
});

