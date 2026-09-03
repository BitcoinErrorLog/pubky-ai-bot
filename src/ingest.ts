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
      for (const n of filtered) {
        await ingestOne(store, botPk, n);
      }
      const maxTs = items.length ? Math.max(...items.map((x) => x.timestamp), cur.lastTs) : cur.lastTs;
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

export async function ingestOne(store: Store, botPk: string, n: Notification): Promise<void> {
  const parsed = mentionKey(n);
  if (!parsed) return;
  metrics.incrementMentions("received");
  const lg = withMention(parsed.key);
  if (!(await store.ping())) return;
  const existing = await store.get(parsed.key);
  if (existing?.status === "published" || existing?.status === "skipped") return;
  if (!existing || existing.status === "failed") {
    const claimed = await store.claim(parsed.key, parsed.author, botPk);
    if (claimed === "exists") return;
  } else if (existing.status === "processing") {
    await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
    return;
  }
  await store.enqueueWork(parsed.key, parsed.author, parsed.kind, { mentionKey: parsed.key });
  lg.info("enqueued");
}
