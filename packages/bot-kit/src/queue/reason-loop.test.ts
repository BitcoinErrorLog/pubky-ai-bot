import { describe, expect, it } from "vitest";
import { runReasonLoop, type WorkOutcome } from "./reason-loop.js";
import type { MarkExtra, MentionStatus, ReapResult, WorkItem, WorkStore } from "./work-store.js";

type Row = {
  id: number;
  mention_key: string;
  author: string;
  kind: string;
  payload: unknown;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  claimedAt: number | null;
};

type MentionRow = {
  status: MentionStatus;
  skipReason?: string;
  rootUri?: string;
  updatedAt: number;
};

class MemoryWorkStore implements WorkStore {
  now = 1_000_000;
  nextId = 1;
  readonly rows = new Map<number, Row>();
  readonly mentions = new Map<string, MentionRow>();
  reapCalls = 0;

  enqueue(item: { mention_key: string; author: string; kind: string; payload: unknown }): number {
    const id = this.nextId++;
    this.rows.set(id, {
      id,
      mention_key: item.mention_key,
      author: item.author,
      kind: item.kind,
      payload: item.payload,
      status: "queued",
      attempts: 0,
      claimedAt: null,
    });
    return id;
  }

  item(mentionKey: string): Row | undefined {
    return [...this.rows.values()].find((r) => r.mention_key === mentionKey);
  }

  seedClaimed(mentionKey: string, claimedAt: number, attempts = 0): number {
    const id = this.enqueue({ mention_key: mentionKey, author: "a", kind: "mention", payload: {} });
    const row = this.rows.get(id)!;
    row.status = "claimed";
    row.claimedAt = claimedAt;
    row.attempts = attempts;
    return id;
  }

  async claimWork(): Promise<WorkItem | null> {
    const queued = [...this.rows.values()]
      .filter((r) => r.status === "queued")
      .sort((a, b) => a.id - b.id);
    const row = queued[0];
    if (!row) return null;
    row.status = "claimed";
    row.claimedAt = this.now;
    return {
      id: row.id,
      mention_key: row.mention_key,
      author: row.author,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
    };
  }

  async finishWork(id: number, status: "done" | "failed"): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.status = status;
  }

  async retryWork(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== "claimed") return;
    row.status = "queued";
    row.attempts += 1;
    row.claimedAt = null;
  }

  async heartbeatWork(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.status === "claimed") row.claimedAt = this.now;
  }

  async reapStaleWork(staleMs: number, maxAttempts: number): Promise<ReapResult> {
    this.reapCalls += 1;
    const cutoff = this.now - staleMs;
    const stale = [...this.rows.values()].filter(
      (r) => r.status === "claimed" && r.claimedAt !== null && r.claimedAt < cutoff,
    );
    const exhaustedKeys: string[] = [];
    let requeued = 0;
    for (const row of stale) {
      if (row.attempts >= maxAttempts) {
        row.status = "failed";
        exhaustedKeys.push(row.mention_key);
      }
    }
    for (const row of stale) {
      if (row.status === "claimed" && row.attempts < maxAttempts) {
        row.status = "queued";
        row.attempts += 1;
        row.claimedAt = null;
        requeued += 1;
      }
    }
    return { requeued, failed: exhaustedKeys.length, exhaustedKeys };
  }

  async listStaleProcessingMentions(staleMs: number): Promise<string[]> {
    const cutoff = this.now - staleMs;
    const out: string[] = [];
    for (const [key, m] of this.mentions) {
      if (m.status !== "processing" || m.updatedAt >= cutoff) continue;
      const work = this.item(key);
      if (work && (work.status === "queued" || work.status === "claimed")) continue;
      out.push(key);
    }
    return out;
  }

  async mark(mentionKey: string, status: MentionStatus, extra?: MarkExtra): Promise<void> {
    const prev = this.mentions.get(mentionKey);
    this.mentions.set(mentionKey, {
      status,
      skipReason: extra?.skipReason ?? prev?.skipReason,
      rootUri: extra?.rootUri ?? prev?.rootUri,
      updatedAt: this.now,
    });
  }
}

async function waitFor(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("reason loop shell", () => {
  it("claims, handles ok, and completes", async () => {
    const store = new MemoryWorkStore();
    store.enqueue({ mention_key: "m1", author: "a", kind: "mention", payload: { k: 1 } });
    const seen: string[] = [];
    const stop = await runReasonLoop({
      store,
      handle: async (item) => {
        seen.push(item.mention_key);
        return { status: "complete" };
      },
      workStaleMs: 50_000,
      workMaxAttempts: 3,
      concurrency: 1,
      pollMs: 5,
    });
    await waitFor(() => store.item("m1")?.status === "done");
    await stop();
    expect(seen).toEqual(["m1"]);
    expect(store.item("m1")?.status).toBe("done");
  });

  it("retries a thrown handle with stale-lease backoff then fails after max attempts", async () => {
    const store = new MemoryWorkStore();
    store.enqueue({ mention_key: "m-throw", author: "a", kind: "mention", payload: {} });
    let n = 0;
    const stop = await runReasonLoop({
      store,
      handle: async () => {
        n += 1;
        throw new Error("boom");
      },
      workStaleMs: 20,
      workMaxAttempts: 2,
      concurrency: 1,
      pollMs: 5,
    });
    await waitFor(() => n >= 1);
    store.now += 25;
    await waitFor(() => n >= 2);
    store.now += 25;
    await waitFor(() => n >= 3);
    store.now += 25;
    await waitFor(() => store.item("m-throw")?.status === "failed");
    await stop();
    expect(n).toBe(3);
    expect(store.item("m-throw")?.attempts).toBe(2);
    expect(store.item("m-throw")?.status).toBe("failed");
  });

  it("reaps a stale lease exactly once", async () => {
    const store = new MemoryWorkStore();
    store.seedClaimed("m-stale", store.now - 100, 0);
    const reaps: ReapResult[] = [];
    const inner = store.reapStaleWork.bind(store);
    store.reapStaleWork = async (staleMs, maxAttempts) => {
      const r = await inner(staleMs, maxAttempts);
      reaps.push(r);
      return r;
    };
    let handled = 0;
    const stop = await runReasonLoop({
      store,
      handle: async () => {
        handled += 1;
        return { status: "complete" };
      },
      workStaleMs: 50,
      workMaxAttempts: 3,
      concurrency: 1,
      pollMs: 5,
    });
    await waitFor(() => handled === 1 && store.item("m-stale")?.status === "done");
    await stop();
    const requeuedTicks = reaps.filter((r) => r.requeued > 0);
    expect(requeuedTicks).toHaveLength(1);
    expect(requeuedTicks[0]?.requeued).toBe(1);
    expect(reaps.reduce((n, r) => n + r.requeued, 0)).toBe(1);
  });

  it("waits for the in-flight handle on shutdown", async () => {
    const store = new MemoryWorkStore();
    store.enqueue({ mention_key: "m-slow", author: "a", kind: "mention", payload: {} });
    let release!: () => void;
    let started = false;
    let finished = false;
    const stop = await runReasonLoop({
      store,
      handle: async () => {
        started = true;
        await new Promise<void>((r) => {
          release = r;
        });
        finished = true;
        return { status: "complete" } satisfies WorkOutcome;
      },
      workStaleMs: 50_000,
      workMaxAttempts: 3,
      concurrency: 1,
      pollMs: 5,
    });
    await waitFor(() => started);
    const stopping = stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    expect(finished).toBe(false);
    release();
    await stopping;
    expect(settled).toBe(true);
    expect(finished).toBe(true);
    expect(store.item("m-slow")?.status).toBe("done");
  });
});
