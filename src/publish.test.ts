import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { publishOne } from "./publish.js";
import type { Config } from "./config.js";
import type { Transport } from "./homeserver.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

class FakeTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  puts = 0;
  private posts: Array<{ parent?: string; uri: string }> = [];

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
    return this.posts;
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
