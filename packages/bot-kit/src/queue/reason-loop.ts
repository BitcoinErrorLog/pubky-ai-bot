import { Semaphore } from "../concurrency.js";
import { log } from "../log.js";
import { awaitWithGrace } from "../shutdown.js";
import type { ReapResult, WorkItem, WorkStore } from "./work-store.js";

export type { ReapResult, WorkItem, WorkStore } from "./work-store.js";

/** Same 40ms cadence as Jeb's reason tick. */
export const REASON_TICK_MS = 40;

export type WorkOutcome =
  | { status: "complete" }
  | { status: "skip"; reason: string; rootUri?: string }
  | { status: "fail" }
  | { status: "retry" };

export type ReasonLoopOptions = {
  store: WorkStore;
  handle: (item: WorkItem) => Promise<WorkOutcome>;
  workStaleMs: number;
  workMaxAttempts: number;
  concurrency: number;
  pollMs?: number;
  beforeTick?: () => Promise<void>;
  afterReap?: (reaped: ReapResult, staleMentions: string[]) => Promise<void>;
  shouldClaim?: () => Promise<boolean>;
};

export async function applyWorkOutcome(
  store: WorkStore,
  item: WorkItem,
  outcome: WorkOutcome,
  maxAttempts: number,
): Promise<void> {
  switch (outcome.status) {
    case "complete":
      await store.finishWork(item.id, "done");
      return;
    case "skip":
      await store.mark(item.mention_key, "skipped", {
        skipReason: outcome.reason,
        rootUri: outcome.rootUri,
      });
      await store.finishWork(item.id, "done");
      return;
    case "fail":
      await store.finishWork(item.id, "failed");
      return;
    case "retry":
      if (item.attempts >= maxAttempts) await store.finishWork(item.id, "failed");
      else await store.retryWork(item.id);
  }
}

/**
 * Claim / reap / dequeue shell. Jeb-specific answering is the `handle` callback.
 * On handle throw the row stays `claimed` so the stale-lease reaper applies the
 * same backoff and attempt cap as a crash between claim and finish.
 */
export async function runReasonLoop(opts: ReasonLoopOptions): Promise<() => Promise<void>> {
  const pollMs = opts.pollMs ?? REASON_TICK_MS;
  const sem = new Semaphore(opts.concurrency);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  const jobs = new Set<Promise<void>>();

  const tick = (): void => {
    if (stopped) return;
    tickInFlight = (async () => {
      try {
        if (opts.beforeTick) await opts.beforeTick();
        const reaped = await opts.store.reapStaleWork(opts.workStaleMs, opts.workMaxAttempts);
        if (reaped.requeued > 0 || reaped.failed > 0) {
          log.info({ requeued: reaped.requeued, failed: reaped.failed }, "reaped stale claimed work");
        }
        const staleMentions = await opts.store.listStaleProcessingMentions(opts.workStaleMs);
        if (opts.afterReap) await opts.afterReap(reaped, staleMentions);
        if (stopped) return;
        const allowClaim = opts.shouldClaim ? await opts.shouldClaim() : true;
        if (!allowClaim) {
          /* paused */
        } else if (sem.inFlight < sem.max) {
          const job = await opts.store.claimWork();
          if (job && !stopped) {
            const p = sem
              .run(async () => {
                try {
                  await opts.store.heartbeatWork(job.id);
                  const outcome = await opts.handle(job);
                  await applyWorkOutcome(opts.store, job, outcome, opts.workMaxAttempts);
                } catch {
                  /* leave claimed — reap applies stale backoff + attempt cap */
                }
              })
              .finally(() => {
                jobs.delete(p);
              });
            jobs.add(p);
            void p;
          }
        }
      } catch {
        /* keep looping */
      }
    })();
    void tickInFlight.then(() => {
      if (!stopped) timer = setTimeout(tick, pollMs);
    });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await awaitWithGrace(Promise.all([tickInFlight ?? Promise.resolve(), ...jobs]));
  };
}
