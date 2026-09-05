import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { envSwitchOn } from "../switches.js";
import { runWeeklySeries } from "./run.js";
import { shouldCollectTags, weeklyFiresDue } from "./schedule.js";
import { collectTaggedFeedback } from "./tag-collect.js";
import { TAG_COLLECT_INTERVAL_MS, WEEKLY_SCHEDULER_INTERVAL_MS } from "./types.js";
import { getWeeklyPost } from "./store.js";

export async function weeklyTick(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  now?: Date;
  lastTagCollectMs: number | null;
}): Promise<{ lastTagCollectMs: number | null }> {
  const now = opts.now ?? new Date();
  if (!opts.cfg.weeklyEnabled || envSwitchOn("weekly") || envSwitchOn("global") || (await opts.store.switchOn("weekly"))) {
    return { lastTagCollectMs: opts.lastTagCollectMs };
  }
  let lastTag = opts.lastTagCollectMs;
  if (shouldCollectTags(lastTag, now.getTime(), TAG_COLLECT_INTERVAL_MS)) {
    try {
      await collectTaggedFeedback({ cfg: opts.cfg, store: opts.store, nexus: opts.nexus, now });
      lastTag = now.getTime();
    } catch (e) {
      log.warn({ err: String(e) }, "weekly tag collect failed");
    }
  }
  let fires: ReturnType<typeof weeklyFiresDue> = [];
  try {
    fires = weeklyFiresDue(now, opts.cfg.weeklyTz);
  } catch (e) {
    log.warn({ err: String(e) }, "weekly schedule failed");
    return { lastTagCollectMs: lastTag };
  }
  for (const fire of fires) {
    const existing = await getWeeklyPost(opts.store.pool, fire.series, fire.weekKey);
    if (existing) continue;
    try {
      const result = await runWeeklySeries({
        cfg: opts.cfg,
        store: opts.store,
        nexus: opts.nexus,
        series: fire.series,
        weekKey: fire.weekKey,
        dryRun: false,
        now,
      });
      log.info(
        { series: fire.series, week: fire.weekKey, published: result.published, skipped: result.skipped },
        "weekly series tick",
      );
    } catch (e) {
      log.warn({ err: String(e), series: fire.series, week: fire.weekKey }, "weekly series failed");
    }
  }
  return { lastTagCollectMs: lastTag };
}

export function startWeeklyLoop(
  cfg: Config,
  store: Store,
  nexus: Nexus,
  clock: () => Date = () => new Date(),
): () => void {
  let lastTagCollectMs: number | null = null;
  const tick = () => {
    void weeklyTick({ cfg, store, nexus, now: clock(), lastTagCollectMs }).then((s) => {
      lastTagCollectMs = s.lastTagCollectMs;
    });
  };
  tick();
  const timer = setInterval(tick, WEEKLY_SCHEDULER_INTERVAL_MS);
  return () => clearInterval(timer);
}
