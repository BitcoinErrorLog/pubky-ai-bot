import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { publishOne, runPublish, tagOne, TagsBlockedError } from "./publish.js";
import { TAG_MAX_ATTEMPTS } from "./reply-tags.js";
import type { Config } from "./config.js";
import type { Transport } from "./homeserver.js";
import { log } from "./log.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

class FakeTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  puts = 0;
  listErrors = 0;
  protected posts: Array<{ parent?: string; uri: string }> = [];

  async putBytes(_path: string, _body: Uint8Array): Promise<void> {}

  async putJson(_path: string, json: unknown): Promise<void> {
    this.puts += 1;
    const parent = typeof json === "object" && json && "parent" in json ? String((json as { parent?: string }).parent) : undefined;
    this.posts.push({
      parent,
      uri: `pubky://${this.botPk}/pub/pubky.app/posts/0000000000001`,
    });
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
    this.posts.push({ parent, uri: `pubky://${this.botPk}/pub/pubky.app/posts/00000000000T1` });
  }

  async putBytes(): Promise<void> {}
  async getJson(): Promise<unknown> {
    return { content: "ok" };
  }
  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return this.posts;
  }
  async reauth(): Promise<void> {}
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

  async putJson(path: string, json: unknown): Promise<void> {
    if (path.includes("/tags/")) return;
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
    const pr = await store.pool.query<{ categories: unknown }>(
      "SELECT categories FROM publish_requests WHERE mention_key = $1",
      [scrubKey],
    );
    expect(JSON.stringify(pr.rows[0]?.categories)).toBe(JSON.stringify(["declined"]));
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
