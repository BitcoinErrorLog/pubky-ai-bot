import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { publishOne } from "./publish.js";
import type { Config } from "./config.js";
import type { Transport } from "./homeserver.js";

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
