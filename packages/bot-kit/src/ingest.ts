import type { Server } from "node:http";
import { withMention } from "./log.js";
import { mentionKey, skipStaleFirstBoot, type Notification } from "./types.js";
import { awaitWithGrace } from "./shutdown.js";
import type { IngestStore } from "./queue/ingest-store.js";

export type { IngestStore, CursorState, MentionStatus, HandledMentionRow } from "./queue/ingest-store.js";

export type IngestConfig = {
  botPk?: string;
  databaseUrl: string;
  nexusUrl: string;
  nexusTimeoutMs: number;
  port?: number;
  bind?: string;
  disabledEnv: boolean;
  maxAgeMinutes: number;
  workStaleMs: number;
  pollMs: number;
};

export type IngestDeps = {
  createStore: (databaseUrl: string) => IngestStore;
  createNexus: (
    nexusUrl: string,
    timeoutMs: number,
  ) => { notifications(botPk: string, end: number | null): Promise<Notification[]> };
  listenHealth: (port: number, lastPoll: () => number | null, host?: string) => Server;
  closeServer: (server: Server | null) => Promise<void>;
  envSwitchOn: (name: "consumption") => boolean;
  assertNoKeyMaterial: () => void;
  incrementMentions: (status: "received") => void;
};

export async function runIngest(cfg: IngestConfig, deps: IngestDeps): Promise<() => Promise<void>> {
  deps.assertNoKeyMaterial();
  const botPk = cfg.botPk;
  if (!botPk) throw new Error("JEB_BOT_PK required for ingest");
  const store = deps.createStore(cfg.databaseUrl);
  await store.migrate();
  const nexus = deps.createNexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPollAt: number | null = null;
  let pollInFlight: Promise<void> | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? deps.listenHealth(cfg.port, () => lastPollAt, cfg.bind) : null;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(pollOnce, ms);
  };

  const pollOnce = (): void => {
    if (stopped) return;
    pollInFlight = (async () => {
      try {
        if (cfg.disabledEnv || deps.envSwitchOn("consumption") || (await store.switchOn("consumption"))) {
          return;
        }
        if (!(await store.ping())) {
          return;
        }
        const cur = await store.getCursor(botPk, cfg.nexusUrl);
        const items = await nexus.notifications(botPk, cur.lastTs > 0 ? cur.lastTs : null);
        lastPollAt = Date.now();
        const filtered = cur.firstBootDone ? items : skipStaleFirstBoot(items, Date.now(), cfg.maxAgeMinutes);
        filtered.sort((a, b) => b.timestamp - a.timestamp);
        const processed: boolean[] = [];
        for (const n of filtered) {
          if (stopped) break;
          processed.push(await ingestOne(store, botPk, n, cfg.workStaleMs, deps.incrementMentions));
        }
        // F-11: never advance the cursor past unprocessed items — a mid-batch
        // failure must leave those notifications for the next poll.
        if (stopped) return;
        const maxTs = maxProcessedTs({
          items,
          kept: filtered,
          processed,
          lastTs: cur.lastTs,
          firstBootDone: cur.firstBootDone,
        });
        await store.setCursor(botPk, cfg.nexusUrl, maxTs, true);
      } catch {
        /* keep polling */
      }
    })();
    void pollInFlight.then(() => {
      if (!stopped) schedule(cfg.pollMs);
    });
  };

  pollOnce();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await awaitWithGrace(pollInFlight);
    await deps.closeServer(health);
    await store.close();
  };
}

/**
 * Newest timestamp the cursor may advance to (F-11). If any kept item was
 * not processed (e.g. a mid-batch store failure), the cursor stops just
 * below the oldest unprocessed item so the next poll re-fetches it; the
 * handled_mentions claim makes re-processing of newer items idempotent.
 * Items dropped by the first-boot stale filter count as processed (they are
 * intentionally never ingested) and unparseable notifications never block.
 */
export function maxProcessedTs(args: {
  items: Notification[];
  kept: Notification[];
  processed: boolean[];
  lastTs: number;
  firstBootDone: boolean;
}): number {
  const unprocessed = args.kept.filter((_, i) => !args.processed[i]);
  if (unprocessed.length > 0) {
    const oldestUnprocessed = Math.min(...unprocessed.map((n) => n.timestamp));
    return Math.max(args.lastTs, oldestUnprocessed - 1);
  }
  let max = args.lastTs;
  for (const n of args.kept) max = Math.max(max, n.timestamp);
  if (!args.firstBootDone) {
    const kept = new Set(args.kept);
    for (const n of args.items) {
      if (!kept.has(n)) max = Math.max(max, n.timestamp);
    }
  }
  return max;
}

/** Returns false only when the item could not be processed and must be retried (F-11). */
export async function ingestOne(
  store: IngestStore,
  botPk: string,
  n: Notification,
  workStaleMs = 180_000,
  incrementMentions: (status: "received") => void = () => undefined,
): Promise<boolean> {
  const parsed = mentionKey(n);
  if (!parsed) return true;
  incrementMentions("received");
  const lg = withMention(parsed.key);
  if (!(await store.ping())) return false;
  const existing = await store.get(parsed.key);
  if (existing?.status === "published" || existing?.status === "skipped") return true;
  if (!existing || existing.status === "failed") {
    const claimed = await store.claim(parsed.key, parsed.author, botPk);
    if (claimed === "exists") {
      await enqueueIfIdle(store, parsed, workStaleMs);
      return true;
    }
  } else if (existing.status === "processing") {
    await enqueueIfIdle(store, parsed, workStaleMs);
    return true;
  }
  const inserted = await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
  if (inserted) lg.info("enqueued");
  return true;
}

async function enqueueIfIdle(
  store: IngestStore,
  parsed: { key: string; author: string; kind: string },
  workStaleMs: number,
): Promise<void> {
  if ((await store.hasActiveWork(parsed.key, workStaleMs)) || (await store.hasActivePublish(parsed.key))) return;
  await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
}
