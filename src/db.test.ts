import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
let store: Store;

describe("idempotency state machine", () => {
  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM handled_mentions");
  });
  afterAll(async () => {
    await store.close();
  });

  it("insert-if-absent then published; second claim is exists", async () => {
    const key = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/AAAAAAAAAAAAA";
    expect(await store.claim(key, "author", "bot")).toBe("claimed");
    expect(await store.claim(key, "author", "bot")).toBe("exists");
    await store.mark(key, "published", { replyUri: "pubky://bot/post", rootUri: key });
    const row = await store.get(key);
    expect(row?.status).toBe("published");
    expect(row?.reply_uri).toBe("pubky://bot/post");
    expect(await store.publishedInThread("bot", key)).toBe(1);
    const skipKey = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/SKIPREASON001";
    expect(await store.claim(skipKey, "author", "bot")).toBe("claimed");
    await store.mark(skipKey, "skipped", { skipReason: "user_turn_cap", rootUri: skipKey });
    expect((await store.get(skipKey))?.skip_reason).toBe("user_turn_cap");
  });

  it("counts per-author last hour", async () => {
    const n = await store.publishedByAuthorLastHour("author");
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("replace_post_id round-trip", () => {
  let local: Store;
  beforeAll(async () => {
    local = new Store(url);
    await local.migrate();
  });
  afterAll(async () => {
    await local.close();
  });

  it("persists replace_post_id on insert and claim", async () => {
    const key = "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/REPLACESTORE1";
    await local.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    await local.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [key]);
    await local.pool.query(
      "UPDATE publish_requests SET status = 'failed' WHERE status IN ('queued', 'retry', 'publishing')",
    );
    expect(await local.claim(key, "author", "bot")).toBe("claimed");
    expect(
      await local.insertPublishRequest({
        mentionKey: key,
        parentUri: key,
        content: "new",
        evidenceId: null,
        replacePostId: "0035N9BXXT9VG",
      }),
    ).toBe(true);
    const row = await local.claimPublish(5);
    expect(row?.mention_key).toBe(key);
    expect(row?.replace_post_id).toBe("0035N9BXXT9VG");
    await local.markPublishDone(row!.id);
    await local.supersedePublishForReplace(key);
    expect(
      await local.insertPublishRequest({
        mentionKey: key,
        parentUri: key,
        content: "newer",
        evidenceId: null,
        replacePostId: "0035N9BXXT9VG",
      }),
    ).toBe(true);
  });
});
