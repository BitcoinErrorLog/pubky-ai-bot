import type { Config } from "./config.js";
import { Store } from "./db.js";
import { listenHealth, closeServer } from "./health.js";
import { withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { Nexus } from "./nexus.js";
import { assertNoKeyMaterial } from "./keys.js";
import { envSwitchOn } from "./switches.js";
import { mentionKey, skipStaleFirstBoot, type Notification } from "./types.js";

export async function runIngest(cfg: Config): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  const botPk = cfg.botPk;
  if (!botPk) throw new Error("JEB_BOT_PK required for ingest");
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPollAt: number | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? listenHealth(cfg.port, () => lastPollAt, cfg.bind) : null;

  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void pollOnce(), ms);
  };

  const pollOnce = async () => {
    if (stopped) return;
    try {
      if (cfg.disabledEnv || envSwitchOn("consumption") || (await store.switchOn("consumption"))) {
        schedule(cfg.pollMs);
        return;
      }
      if (!(await store.ping())) {
        schedule(cfg.pollMs);
        return;
      }
      const cur = await store.getCursor(botPk, cfg.nexusUrl);
      const items = await nexus.notifications(botPk, cur.lastTs > 0 ? cur.lastTs : null);
      lastPollAt = Date.now();
      const filtered = cur.firstBootDone ? items : skipStaleFirstBoot(items, Date.now(), cfg.maxAgeMinutes);
      filtered.sort((a, b) => b.timestamp - a.timestamp);
      const processed: boolean[] = [];
      for (const n of filtered) {
        processed.push(await ingestOne(store, botPk, n));
      }
      // F-11: never advance the cursor past unprocessed items — a mid-batch
      // failure must leave those notifications for the next poll.
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
    if (!stopped) schedule(cfg.pollMs);
  };

  schedule(0);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await closeServer(health);
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
export async function ingestOne(store: Store, botPk: string, n: Notification): Promise<boolean> {
  const parsed = mentionKey(n);
  if (!parsed) return true;
  metrics.incrementMentions("received");
  const lg = withMention(parsed.key);
  if (!(await store.ping())) return false;
  const existing = await store.get(parsed.key);
  if (existing?.status === "published" || existing?.status === "skipped") return true;
  if (!existing || existing.status === "failed") {
    const claimed = await store.claim(parsed.key, parsed.author, botPk);
    if (claimed === "exists") {
      await enqueueIfIdle(store, parsed);
      return true;
    }
  } else if (existing.status === "processing") {
    await enqueueIfIdle(store, parsed);
    return true;
  }
  const inserted = await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
  if (inserted) lg.info("enqueued");
  return true;
}

async function enqueueIfIdle(
  store: Store,
  parsed: { key: string; author: string; kind: string },
): Promise<void> {
  if ((await store.hasActiveWork(parsed.key)) || (await store.hasActivePublish(parsed.key))) return;
  await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
}
