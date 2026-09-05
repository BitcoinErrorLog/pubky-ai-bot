import type { Config } from "../config.js";
import { createSearchKnowledgeExecute } from "../knowledge/tool.js";
import { Nexus } from "../nexus.js";
import { createScoutTools } from "../scout/tools.js";
import { ScoutClient } from "../scout/client.js";
import type { Store } from "../db.js";
import { generateNewConnection } from "./new-connection.js";
import { generatePubkyExplained } from "./pubky-explained.js";
import { generateReleaseRadar } from "./release-radar.js";
import { generateTheDisagreement } from "./the-disagreement.js";
import { generateThreadWorthReading } from "./thread-worth-reading.js";
import { generateWhatChanged } from "./what-changed.js";
import { DEFAULT_PROACTIVE_MAX_PER_DAY, FORMAT_ENV, type Draft, type DraftFormat } from "./types.js";
import { DraftRejectedError } from "./finish.js";
import type { DraftCompleteFn } from "./compose.js";
import { DEFAULT_WINDOW_DAYS } from "./window.js";

export { DEFAULT_PROACTIVE_MAX_PER_DAY } from "./types.js";

export function draftsGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEB_DRAFTS_ENABLED === "1";
}

export function draftFormatEnabled(format: DraftFormat, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FORMAT_ENV[format]] === "1";
}

export function proactiveMaxPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEB_PROACTIVE_MAX_PER_DAY;
  if (raw === undefined || raw === "") return DEFAULT_PROACTIVE_MAX_PER_DAY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error("invalid JEB_PROACTIVE_MAX_PER_DAY");
  return Math.floor(n);
}

export function draftWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEB_DRAFT_WINDOW_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error("invalid JEB_DRAFT_WINDOW_DAYS");
  return Math.floor(n);
}

export async function generateFormat(opts: {
  format: DraftFormat;
  cfg: Config;
  store: Store;
  complete?: DraftCompleteFn;
  windowDays?: number;
  nowMs?: number;
}): Promise<Draft> {
  const { format, cfg, store } = opts;
  const windowDays = opts.windowDays ?? draftWindowDays();
  const scout = createScoutTools({
    cfg,
    pool: store.pool,
    mentionKey: `draft:generate:${format}`,
    storeSwitchOn: () => store.switchOn("scout"),
    client: new ScoutClient(cfg, store.pool),
  });
  const appUrl = cfg.appUrl;
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  const shared = {
    scout,
    appUrl,
    cfg,
    complete: opts.complete,
    windowDays,
    nowMs: opts.nowMs,
    botPk: cfg.botPk,
  };
  switch (format) {
    case "what_changed":
      return generateWhatChanged({
        ...shared,
        store,
        timeoutMs: cfg.nexusTimeoutMs,
      });
    case "thread_worth_reading":
      return generateThreadWorthReading({ ...shared, nexus });
    case "the_disagreement":
      return generateTheDisagreement({ ...shared, nexus });
    case "new_connection":
      return generateNewConnection(shared);
    case "pubky_explained": {
      const kn = createSearchKnowledgeExecute({ pool: store.pool, mentionKey: `draft:generate:${format}` });
      return generatePubkyExplained({
        ...shared,
        nexus,
        searchKnowledge: async (query) => {
          const out = await kn.execute({ query, k: 6 });
          if (out && typeof out === "object" && "error" in out) {
            throw new DraftRejectedError("pubky_explained", "knowledge unavailable");
          }
          return { chunks: (out as { chunks: Array<{ content: string; source_url: string | null }> }).chunks };
        },
      });
    }
    case "release_radar":
      return generateReleaseRadar({
        cfg,
        complete: opts.complete,
        timeoutMs: cfg.nexusTimeoutMs,
        windowDays,
        nowMs: opts.nowMs,
      });
    default: {
      const _never: never = format;
      throw new Error(`unhandled format ${_never}`);
    }
  }
}
