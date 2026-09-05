import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { parsePostUri } from "../types.js";
import { postTimestampMs } from "../bot-kit/crockford.js";
import { classifyFeedbackPost } from "./classify.js";
import { isJebAuthor, isUnusableContent } from "./content.js";
import { mentionUrisFromNotifications } from "./gather.js";
import { sanitizeFeedbackQuote } from "./sanitize-quote.js";
import { upsertFeedbackItem } from "./store.js";
import {
  FEEDBACK_KINDS,
  JEB_PUBKY,
  type FeedbackItem,
  type FeedbackKind,
} from "./types.js";
import { isoWeekKey } from "./week-key.js";

export type ClassifierKindCounts = Record<FeedbackKind | "none", number>;

export function emptyClassifierCounts(): ClassifierKindCounts {
  return {
    advice: 0,
    complaint: 0,
    feature_request: 0,
    bug_report: 0,
    praise: 0,
    none: 0,
  };
}

export async function classifyJebMentions(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  sinceMs: number;
  untilMs: number;
  persist: boolean;
  now?: Date;
}): Promise<{ items: FeedbackItem[]; counts: ClassifierKindCounts; seen: number }> {
  const counts = emptyClassifierCounts();
  const items: FeedbackItem[] = [];
  const botPk = opts.cfg.botPk;
  const targets = [...new Set([JEB_PUBKY, botPk].filter((x): x is string => Boolean(x)))];
  const uris = new Set<string>();
  for (const pk of targets) {
    try {
      for (const uri of await mentionUrisFromNotifications(opts.nexus, pk, opts.sinceMs)) {
        uris.add(uri);
      }
    } catch (e) {
      log.warn({ err: String(e), pubky: pk }, "weekly classify mentions: notifications failed");
    }
  }
  let seen = 0;
  let ephemeralId = -10_000;
  for (const uri of uris) {
    let parsed;
    try {
      parsed = parsePostUri(uri);
    } catch {
      continue;
    }
    seen += 1;
    let view;
    try {
      view = await opts.nexus.post(uri);
    } catch (e) {
      log.warn({ err: String(e), uri }, "weekly classify mentions: post fetch failed");
      continue;
    }
    if (!view) continue;
    if (isJebAuthor(view.details.author, botPk)) continue;
    if (isUnusableContent(view.details.content)) continue;
    const details = view.details as typeof view.details & { created_at?: number };
    const ts = postTimestampMs({
      postId: view.details.id,
      indexedAt: view.details.indexed_at,
      createdAt: details.created_at,
    });
    if (ts === null || ts < opts.sinceMs || ts > opts.untilMs) continue;
    const { classification, tokens } = await classifyFeedbackPost(opts.cfg, view.details.content);
    if (tokens > 0) {
      await opts.store.recordUsage({
        mentionKey: `feedback:${uri}`,
        publicKey: view.details.author,
        phase: "feedback",
        model: opts.cfg.model,
        totalTokens: tokens,
      });
    }
    if (!classification) {
      counts.none += 1;
      continue;
    }
    if (classification.kinds.length === 0) counts.none += 1;
    else {
      for (const k of classification.kinds) counts[k] += 1;
    }
    if (classification.kinds.length === 0) continue;
    const quote = classification.quote || sanitizeFeedbackQuote(view.details.content);
    if (isUnusableContent(quote)) continue;
    const weekKey = isoWeekKey(new Date(ts), opts.cfg.weeklyTz);
    const item: FeedbackItem = {
      id: ephemeralId--,
      post_uri: uri,
      author_pk: parsed.author,
      kinds: classification.kinds,
      quote,
      detected_at: new Date(ts),
      week_key: weekKey,
      source: "classifier",
      included_in_post_uri: null,
    };
    items.push(item);
    if (opts.persist) {
      await upsertFeedbackItem(opts.store.pool, {
        postUri: uri,
        authorPk: parsed.author,
        kinds: classification.kinds,
        quote,
        weekKey,
        source: "classifier",
      });
    }
  }
  log.info({ seen, stored: items.length, counts }, "weekly classify mentions");
  return { items, counts, seen };
}

export function formatClassifierCounts(counts: ClassifierKindCounts): string {
  const parts = [...FEEDBACK_KINDS, "none" as const].map((k) => `${k}=${counts[k]}`);
  return `classifier ${parts.join(" ")}`;
}
