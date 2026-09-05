import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import { parsePostUri } from "../types.js";
import { sanitizeFeedbackQuote } from "./sanitize-quote.js";
import { upsertFeedbackItem } from "./store.js";
import type { FeedbackItem } from "./types.js";
import { FEEDBACK_TAG_LABELS, TAG_COLLECT_LOOKBACK_DAYS } from "./types.js";
import { isoWeekKey } from "./week-key.js";

export async function collectTaggedFeedback(opts: {
  cfg: Config;
  store: Store;
  nexus: Nexus;
  now?: Date;
  persist?: boolean;
}): Promise<{ seen: number; stored: number; items: FeedbackItem[] }> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - TAG_COLLECT_LOOKBACK_DAYS * 86_400_000;
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
        end: cutoff,
        skip,
        limit: 30,
        sorting: "timeline",
      });
      if (posts.length === 0) break;
      for (const post of posts) {
        seen += 1;
        if (post.details.indexed_at < cutoff) continue;
        if (botPk && post.details.author === botPk) continue;
        const postUri = post.details.uri;
        try {
          parsePostUri(postUri);
        } catch {
          continue;
        }
        const quote = sanitizeFeedbackQuote(post.details.content);
        const weekKey = isoWeekKey(new Date(post.details.indexed_at), opts.cfg.weeklyTz);
        const item: FeedbackItem = {
          id: ephemeralId--,
          post_uri: postUri,
          author_pk: post.details.author,
          kinds: [],
          quote,
          detected_at: new Date(post.details.indexed_at),
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
