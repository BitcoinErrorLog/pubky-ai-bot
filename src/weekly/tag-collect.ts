import { postTimestampMs } from "../bot-kit/crockford.js";
import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { parsePostUri } from "../types.js";
import { isJebAuthor, isUnusableContent } from "./content.js";
import { sanitizeFeedbackQuote } from "./sanitize-quote.js";
import { authorExcluded, upsertFeedbackItem } from "./store.js";
import type { FeedbackItem } from "./types.js";
import { FEEDBACK_TAG_LABELS, TAG_COLLECT_LOOKBACK_DAYS } from "./types.js";
import { isoWeekKey } from "./week-key.js";

export async function collectTaggedFeedback(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  now?: Date;
  persist?: boolean;
  sinceMs?: number;
  untilMs?: number;
}): Promise<{ seen: number; stored: number; items: FeedbackItem[] }> {
  const now = opts.now ?? new Date();
  const sinceMs = opts.sinceMs ?? now.getTime() - TAG_COLLECT_LOOKBACK_DAYS * 86_400_000;
  const untilMs = opts.untilMs ?? now.getTime();
  const botPk = opts.cfg.botPk;
  const persist = opts.persist !== false;
  const byUri = new Map<string, FeedbackItem>();
  let seen = 0;
  let stored = 0;
  let ephemeralId = -1;
  for (const tag of FEEDBACK_TAG_LABELS) {
    let skip = 0;
    for (;;) {
      const posts = await opts.nexus.streamPosts({
        tags: [tag],
        end: sinceMs,
        skip,
        limit: 30,
        sorting: "timeline",
      });
      if (posts.length === 0) break;
      for (const post of posts) {
        seen += 1;
        if (isJebAuthor(post.details.author, botPk)) continue;
        if (await authorExcluded(opts.store.pool, post.details.author, opts.cfg.blocklist).catch(() => false)) continue;
        if (isUnusableContent(post.details.content)) continue;
        const postUri = post.details.uri;
        try {
          parsePostUri(postUri);
        } catch {
          continue;
        }
        const details = post.details as typeof post.details & { created_at?: number };
        const ts = postTimestampMs({
          postId: post.details.id,
          indexedAt: post.details.indexed_at,
          createdAt: details.created_at,
        });
        if (ts === null || ts < sinceMs || ts > untilMs) continue;
        const quote = sanitizeFeedbackQuote(post.details.content);
        if (isUnusableContent(quote)) continue;
        const weekKey = isoWeekKey(new Date(ts), opts.cfg.weeklyTz);
        const item: FeedbackItem = {
          id: ephemeralId--,
          post_uri: postUri,
          author_pk: post.details.author,
          kinds: [],
          quote,
          detected_at: new Date(ts),
          week_key: weekKey,
          source: "tag",
          included_in_post_uri: null,
        };
        if (!byUri.has(postUri)) byUri.set(postUri, item);
        if (persist) {
          const result = await upsertFeedbackItem(opts.store.pool, {
            postUri,
            authorPk: post.details.author,
            kinds: [],
            quote,
            weekKey,
            source: "tag",
          });
          if (result === "inserted") stored += 1;
        } else {
          stored += 1;
        }
      }
      if (posts.length < 30) break;
      skip += posts.length;
      if (skip > 300) break;
    }
  }
  log.info({ seen, stored, persist }, "feedback tag collect");
  return { seen, stored, items: [...byUri.values()] };
}
