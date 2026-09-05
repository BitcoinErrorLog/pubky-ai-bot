import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import { classifyFeedbackPost } from "./classify.js";
import { sanitizeFeedbackQuote } from "./sanitize-quote.js";
import { authorExcluded, existingFeedbackUris, upsertFeedbackItem, weeklyTokensUsed } from "./store.js";
import { CLASSIFY_TOKEN_HEADROOM } from "./types.js";
import { isoWeekKey } from "./week-key.js";

/**
 * Fire-and-forget classifier. Never throws to the caller. Failure = no row.
 */
export function persistFeedbackFromMention(opts: {
  cfg: Config;
  store: Store;
  postUri: string;
  authorPk: string;
  content: string;
  now?: Date;
}): void {
  void classifyAndStore(opts).catch((e) => {
    log.warn({ err: String(e), uri: opts.postUri }, "feedback classify failed");
  });
}

export async function classifyAndStore(opts: {
  cfg: Config;
  store: Store;
  postUri: string;
  authorPk: string;
  content: string;
  now?: Date;
}): Promise<"stored" | "empty" | "failed"> {
  const now = opts.now ?? new Date();
  try {
    if (await authorExcluded(opts.store.pool, opts.authorPk, opts.cfg.blocklist).catch(() => false)) {
      return "empty";
    }
    const already = await existingFeedbackUris(opts.store.pool, [opts.postUri]).catch(() => new Set<string>());
    if (already.has(opts.postUri)) return "empty";
    const daily = typeof opts.store.globalDailyTokens === "function" ? await opts.store.globalDailyTokens() : 0;
    if (opts.cfg.dailyTokenBudget && daily + CLASSIFY_TOKEN_HEADROOM > opts.cfg.dailyTokenBudget) return "empty";
    const weekly = await weeklyTokensUsed(opts.store.pool, "feedback:").catch(() => 0);
    if (opts.cfg.weeklyTokenCap && weekly >= opts.cfg.weeklyTokenCap) return "empty";
    const { classification, tokens } = await classifyFeedbackPost(opts.cfg, opts.content);
    if (tokens > 0) {
      await opts.store.recordUsage({
        mentionKey: `feedback:${opts.postUri}`,
        publicKey: opts.authorPk,
        phase: "feedback",
        model: opts.cfg.model,
        totalTokens: tokens,
      });
    }
    if (!classification || classification.kinds.length === 0) return "empty";
    const quote = classification.quote || sanitizeFeedbackQuote(opts.content);
    await upsertFeedbackItem(opts.store.pool, {
      postUri: opts.postUri,
      authorPk: opts.authorPk,
      kinds: classification.kinds,
      quote,
      weekKey: isoWeekKey(now, opts.cfg.weeklyTz),
      source: "classifier",
    });
    return "stored";
  } catch (e) {
    log.warn({ err: String(e), uri: opts.postUri }, "feedback classify failed");
    return "failed";
  }
}
