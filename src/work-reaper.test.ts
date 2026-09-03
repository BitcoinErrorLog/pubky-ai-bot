import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { ingestOne } from "./ingest.js";
import type { Notification } from "./types.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STALE_MS = 180_000;
const MAX_ATTEMPTS = 3;

const key = (id: string) => `pubky://${USER}/pub/pubky.app/posts/${id}`;
const mention = (k: string): Notification => ({
  timestamp: 50,
  body: { type: "mention", post_uri: k, mentioned_by: USER },
});

describe("reason-work reaper (R-01)", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    // claimWork is global (oldest queued row); clear leftovers from other
    // test files/runs so claims below are deterministic. Test files run
    // sequentially (fileParallelism: false).
    await store.pool.query("DELETE FROM work_queue");
  });
  afterAll(async () => {
    // The contract suite shares this database — leave no active rows behind.
    await store.pool.query("DELETE FROM work_queue WHERE mention_key LIKE '%/REAPER%'");
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key LIKE '%/REAPER%'");
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key LIKE '%/REAPER%'");
    await store.close();
  });

  async function wipe(k: string): Promise<void> {
    await store.pool.query("DELETE FROM work_queue WHERE mention_key = $1", [k]);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [k]);
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [k]);
  }

  async function ageClaim(k: string): Promise<void> {
    await store.pool.query(
      `UPDATE work_queue SET claimed_at = now() - interval '10 minutes' WHERE mention_key = $1`,
      [k],
    );
  }

  it("requeues a stale claimed row after a crash; the mention publishes exactly once", async () => {
    const k = key("REAPER0000001");
    await wipe(k);
    expect(await store.claim(k, USER, BOT)).toBe("claimed");
    expect(await store.enqueueWork(k, USER, "mention", { mentionKey: k })).toBe(true);
    const job = await store.claimWork();
    expect(job?.mention_key).toBe(k);
    // Crash between claimWork and finishWork: the row stays claimed, stale.
    await ageClaim(k);
    expect(await store.hasActiveWork(k, STALE_MS)).toBe(false);

    const reaped = await store.reapStaleWork(STALE_MS, MAX_ATTEMPTS);
    expect(reaped).toEqual({ requeued: 1, failed: 0 });
    const row = await store.pool.query<{ status: string; attempts: number; claimed_at: Date | null }>(
      "SELECT status, attempts, claimed_at FROM work_queue WHERE mention_key = $1",
      [k],
    );
    expect(row.rows[0]?.status).toBe("queued");
    expect(row.rows[0]?.attempts).toBe(1);
    expect(row.rows[0]?.claimed_at).toBeNull();
    expect((await store.get(k))?.status).toBe("processing");

    // Next tick picks it up and finishes; the publish request dedupes.
    const job2 = await store.claimWork();
    expect(job2?.id).toBe(job?.id);
    expect(await store.insertPublishRequest({ mentionKey: k, parentUri: k, content: "a", evidenceId: null })).toBe(true);
    expect(await store.insertPublishRequest({ mentionKey: k, parentUri: k, content: "b", evidenceId: null })).toBe(false);
    await store.finishWork(job2!.id, "done");
    const pubs = await store.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM publish_requests WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')`,
      [k],
    );
    expect(pubs.rows[0]?.n).toBe(1);
  });

  it("does not reap a fresh claimed row", async () => {
    const k = key("REAPER0000002");
    await wipe(k);
    expect(await store.claim(k, USER, BOT)).toBe("claimed");
    await store.enqueueWork(k, USER, "mention", { mentionKey: k });
    const job = await store.claimWork();
    expect(job?.mention_key).toBe(k);
    expect(await store.hasActiveWork(k, STALE_MS)).toBe(true);
    const reaped = await store.reapStaleWork(STALE_MS, MAX_ATTEMPTS);
    expect(reaped).toEqual({ requeued: 0, failed: 0 });
    const row = await store.pool.query<{ status: string }>(
      "SELECT status FROM work_queue WHERE mention_key = $1",
      [k],
    );
    expect(row.rows[0]?.status).toBe("claimed");
    await store.finishWork(job!.id, "done");
  });

  it("exhausted attempts fail the work row and the mention; a fresh notification re-claims", async () => {
    const k = key("REAPER0000003");
    await wipe(k);
    expect(await store.claim(k, USER, BOT)).toBe("claimed");
    await store.enqueueWork(k, USER, "mention", { mentionKey: k });
    const job = await store.claimWork();
    expect(job?.mention_key).toBe(k);
    await store.pool.query("UPDATE work_queue SET attempts = $2 WHERE mention_key = $1", [k, MAX_ATTEMPTS]);
    await ageClaim(k);

    const reaped = await store.reapStaleWork(STALE_MS, MAX_ATTEMPTS);
    expect(reaped).toEqual({ requeued: 0, failed: 1 });
    const row = await store.pool.query<{ status: string }>(
      "SELECT status FROM work_queue WHERE mention_key = $1",
      [k],
    );
    expect(row.rows[0]?.status).toBe("failed");
    expect((await store.get(k))?.status).toBe("failed");

    // A fresh notification re-claims the failed mention and enqueues new work.
    expect(await ingestOne(store, BOT, mention(k), STALE_MS)).toBe(true);
    expect((await store.get(k))?.status).toBe("processing");
    const active = await store.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM work_queue WHERE mention_key = $1 AND status IN ('queued', 'claimed')`,
      [k],
    );
    expect(active.rows[0]?.n).toBe(1);
  });

  it("fails stale processing mentions with no active work or publish request only", async () => {
    const orphan = key("REAPER0000004");
    const withPub = key("REAPER0000005");
    const fresh = key("REAPER0000006");
    const withWork = key("REAPER0000007");
    for (const k of [orphan, withPub, fresh, withWork]) {
      await wipe(k);
      expect(await store.claim(k, USER, BOT)).toBe("claimed");
    }
    expect(await store.insertPublishRequest({ mentionKey: withPub, parentUri: withPub, content: "x", evidenceId: null })).toBe(true);
    await store.enqueueWork(withWork, USER, "mention", { mentionKey: withWork });
    await store.pool.query(
      `UPDATE handled_mentions SET updated_at = now() - interval '10 minutes' WHERE mention_key = ANY($1)`,
      [[orphan, withPub, withWork]],
    );

    const failed = await store.failStaleProcessingMentions(STALE_MS);
    expect(failed).toBe(1);
    expect((await store.get(orphan))?.status).toBe("failed");
    expect((await store.get(withPub))?.status).toBe("processing");
    expect((await store.get(fresh))?.status).toBe("processing");
    expect((await store.get(withWork))?.status).toBe("processing");

    // Failed mention is claimable again by a later notification.
    expect(await ingestOne(store, BOT, mention(orphan), STALE_MS)).toBe(true);
    expect((await store.get(orphan))?.status).toBe("processing");
  });
});
