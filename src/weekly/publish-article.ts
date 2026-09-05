import type { Config } from "../config.js";
import type { Store } from "../db.js";
import { scanOutboundText } from "../outbound-gate.js";
import { enqueueStandalonePost } from "../publish.js";
import { isValidTagLabel } from "../reply-tags.js";
import { lintVoice } from "../voice.js";
import { claimWeeklySlot, finishWeeklySlot, markFeedbackIncluded } from "./store.js";
import { WEEKLY_APPROVED_BY, WEEKLY_SERIES_TAGS, type WeeklySeries } from "./types.js";

export interface PreparedArticle {
  title: string;
  body: string;
  tags: string[];
  feedbackIds?: number[];
}

export function longPostContent(title: string, body: string): string {
  return JSON.stringify({ title, body });
}

export function prepareArticleBytes(title: string, body: string): { title: string; body: string } {
  const linted = lintVoice(body, { citationCap: 40, allowMarkdown: true });
  const scan = scanOutboundText(`${title}\n${linted.text}`);
  if (!scan.clean) {
    throw new Error(`weekly article blocked by outbound gate: ${scan.hits.map((h) => h.rule).join(",")}`);
  }
  return { title, body: linted.text };
}

export async function enqueueWeeklyArticle(
  store: Store,
  cfg: Config,
  opts: {
    series: WeeklySeries;
    weekKey: string;
    article: PreparedArticle;
    dryRun: boolean;
  },
): Promise<{ markdown: string; mentionKey?: string; postUri?: string; inserted: boolean }> {
  const prepared = prepareArticleBytes(opts.article.title, opts.article.body);
  const markdown = `# ${prepared.title}\n\n${prepared.body}`;
  if (opts.dryRun) return { markdown, inserted: false };

  const claimed = await claimWeeklySlot(store.pool, opts.series, opts.weekKey);
  if (!claimed) {
    const existing = await store.pool.query(
      `SELECT status, post_uri, mention_key FROM weekly_posts WHERE series = $1 AND week_key = $2`,
      [opts.series, opts.weekKey],
    );
    const row = existing.rows[0];
    return {
      markdown,
      mentionKey: row?.mention_key ?? undefined,
      postUri: row?.post_uri ?? undefined,
      inserted: false,
    };
  }

  const tags = [...new Set([...WEEKLY_SERIES_TAGS[opts.series], ...opts.article.tags])]
    .map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20))
    .filter((t) => isValidTagLabel(t));
  const content = longPostContent(prepared.title, prepared.body);
  let queued;
  try {
    queued = await enqueueStandalonePost(store, {
      content,
      kind: "long",
      approvedBy: WEEKLY_APPROVED_BY,
      categories: tags,
    });
  } catch (e) {
    await store.pool.query(
      `DELETE FROM weekly_posts WHERE series = $1 AND week_key = $2 AND status = 'queued' AND post_uri IS NULL`,
      [opts.series, opts.weekKey],
    );
    throw e;
  }
  const botPk = cfg.botPk;
  const postUri = botPk ? `pubky://${botPk}/pub/pubky.app/posts/${queued.postId}` : null;
  if (postUri) {
    await store.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id, reply_uri)
       VALUES ($1, 'processing', $2, $2, $3)
       ON CONFLICT (mention_key) DO UPDATE SET reply_uri = EXCLUDED.reply_uri`,
      [queued.mentionKey, botPk, postUri],
    );
  }
  await finishWeeklySlot(store.pool, opts.series, opts.weekKey, {
    status: queued.inserted ? "queued" : "published",
    postUri,
    mentionKey: queued.mentionKey,
    tags,
  });
  if (opts.article.feedbackIds && opts.article.feedbackIds.length > 0 && postUri) {
    await markFeedbackIncluded(store.pool, opts.article.feedbackIds, postUri);
  }
  return { markdown, mentionKey: queued.mentionKey, postUri: postUri ?? undefined, inserted: queued.inserted };
}
