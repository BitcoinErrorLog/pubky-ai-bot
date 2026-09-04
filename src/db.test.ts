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
