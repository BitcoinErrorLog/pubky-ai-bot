import type pg from "pg";
import {
  FEEDBACK_QUOTE_MAX,
  isFeedbackKind,
  SEEDED_TRACKED_PROJECTS,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackSource,
  type ProjectStatus,
  type TrackedProject,
  type WeeklyPostRow,
  type WeeklyPostStatus,
  type WeeklySeries,
} from "./types.js";

export type WeeklyQueryable = { query: pg.Pool["query"] };

function asKinds(raw: unknown): FeedbackKind[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is FeedbackKind => typeof k === "string" && isFeedbackKind(k));
}

function mapFeedback(row: {
  id: string | number;
  post_uri: string;
  author_pk: string;
  kinds: unknown;
  quote: string;
  detected_at: Date;
  week_key: string;
  source: FeedbackSource;
  included_in_post_uri: string | null;
}): FeedbackItem {
  return {
    id: Number(row.id),
    post_uri: row.post_uri,
    author_pk: row.author_pk,
    kinds: asKinds(row.kinds),
    quote: row.quote,
    detected_at: row.detected_at,
    week_key: row.week_key,
    source: row.source,
    included_in_post_uri: row.included_in_post_uri,
  };
}

function mapProject(row: {
  id: string;
  name: string;
  aliases: string[] | null;
  tags: string[] | null;
  pubky_ids: string[] | null;
  status: ProjectStatus;
}): TrackedProject {
  return {
    id: row.id,
    name: row.name,
    aliases: row.aliases ?? [],
    tags: row.tags ?? [],
    pubky_ids: row.pubky_ids ?? [],
    status: row.status,
  };
}

export async function upsertFeedbackItem(
  db: WeeklyQueryable,
  row: {
    postUri: string;
    authorPk: string;
    kinds: FeedbackKind[];
    quote: string;
    weekKey: string;
    source: FeedbackSource;
  },
): Promise<"inserted" | "merged"> {
  const quote = row.quote.slice(0, FEEDBACK_QUOTE_MAX);
  const r = await db.query<{ inserted: boolean }>(
    `INSERT INTO feedback_items (post_uri, author_pk, kinds, quote, week_key, source)
     VALUES ($1, $2, $3::text[], $4, $5, $6)
     ON CONFLICT (post_uri) DO UPDATE SET
       kinds = (
         SELECT ARRAY(SELECT DISTINCT unnest(feedback_items.kinds || EXCLUDED.kinds))
       ),
       quote = CASE
         WHEN char_length(btrim(feedback_items.quote)) = 0 OR feedback_items.quote = '[filtered]'
           THEN EXCLUDED.quote
         ELSE feedback_items.quote
       END
     RETURNING (xmax = 0) AS inserted`,
    [row.postUri, row.authorPk, row.kinds, quote, row.weekKey, row.source],
  );
  return r.rows[0]?.inserted === true ? "inserted" : "merged";
}

function missingRelation(e: unknown): boolean {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: string }).code) : "";
  const msg = e instanceof Error ? e.message : String(e);
  return code === "42P01" || /does not exist/i.test(msg);
}

export async function listUnincludedFeedbackSince(
  db: WeeklyQueryable,
  since: Date,
  until?: Date,
): Promise<FeedbackItem[]> {
  const r = until
    ? await db.query(
        `SELECT id, post_uri, author_pk, kinds, quote, detected_at, week_key, source, included_in_post_uri
         FROM feedback_items
         WHERE included_in_post_uri IS NULL AND detected_at >= $1 AND detected_at <= $2
         ORDER BY detected_at ASC`,
        [since, until],
      )
    : await db.query(
        `SELECT id, post_uri, author_pk, kinds, quote, detected_at, week_key, source, included_in_post_uri
         FROM feedback_items
         WHERE included_in_post_uri IS NULL AND detected_at >= $1
         ORDER BY detected_at ASC`,
        [since],
      );
  return r.rows.map(mapFeedback);
}

export async function listUnincludedFeedbackSinceSafe(
  db: WeeklyQueryable,
  since: Date,
  until?: Date,
): Promise<FeedbackItem[]> {
  try {
    return await listUnincludedFeedbackSince(db, since, until);
  } catch (e) {
    if (missingRelation(e)) return [];
    throw e;
  }
}

export async function markFeedbackIncluded(
  db: WeeklyQueryable,
  ids: number[],
  postUri: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`UPDATE feedback_items SET included_in_post_uri = $2 WHERE id = ANY($1::bigint[])`, [
    ids,
    postUri,
  ]);
}

export async function getWeeklyPost(
  db: WeeklyQueryable,
  series: WeeklySeries,
  weekKey: string,
): Promise<WeeklyPostRow | null> {
  const r = await db.query(
    `SELECT series, week_key, post_uri, mention_key, status, tags
     FROM weekly_posts WHERE series = $1 AND week_key = $2`,
    [series, weekKey],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    series: row.series,
    week_key: row.week_key,
    post_uri: row.post_uri,
    mention_key: row.mention_key,
    status: row.status,
    tags: row.tags ?? [],
  };
}

/** Claim the (series, week_key) slot. Returns false if already claimed. */
export async function claimWeeklySlot(
  db: WeeklyQueryable,
  series: WeeklySeries,
  weekKey: string,
  mentionKey?: string | null,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO weekly_posts (series, week_key, status, mention_key)
     VALUES ($1, $2, 'queued', $3)
     ON CONFLICT (series, week_key) DO NOTHING
     RETURNING series`,
    [series, weekKey, mentionKey ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function finishWeeklySlot(
  db: WeeklyQueryable,
  series: WeeklySeries,
  weekKey: string,
  patch: {
    status: WeeklyPostStatus;
    postUri?: string | null;
    mentionKey?: string | null;
    tags?: string[];
  },
): Promise<void> {
  await db.query(
    `UPDATE weekly_posts
     SET status = $3, post_uri = COALESCE($4, post_uri), mention_key = COALESCE($5, mention_key),
         tags = COALESCE($6::text[], tags)
     WHERE series = $1 AND week_key = $2`,
    [series, weekKey, patch.status, patch.postUri ?? null, patch.mentionKey ?? null, patch.tags ?? null],
  );
}

export async function listTrackedProjects(
  db: WeeklyQueryable,
  status?: ProjectStatus,
): Promise<TrackedProject[]> {
  const r = status
    ? await db.query(
        `SELECT id, name, aliases, tags, pubky_ids, status FROM tracked_projects WHERE status = $1 ORDER BY name`,
        [status],
      )
    : await db.query(`SELECT id, name, aliases, tags, pubky_ids, status FROM tracked_projects ORDER BY status, name`);
  return r.rows.map(mapProject);
}

export async function listTrackedProjectsSafe(
  db: WeeklyQueryable,
  status?: ProjectStatus,
): Promise<TrackedProject[]> {
  try {
    return await listTrackedProjects(db, status);
  } catch (e) {
    if (missingRelation(e)) {
      return status ? SEEDED_TRACKED_PROJECTS.filter((p) => p.status === status) : [...SEEDED_TRACKED_PROJECTS];
    }
    throw e;
  }
}

export async function getTrackedProject(db: WeeklyQueryable, id: string): Promise<TrackedProject | null> {
  const r = await db.query(
    `SELECT id, name, aliases, tags, pubky_ids, status FROM tracked_projects WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? mapProject(r.rows[0]) : null;
}

export async function insertTrackedProject(db: WeeklyQueryable, project: TrackedProject): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO tracked_projects (id, name, aliases, tags, pubky_ids, status)
     VALUES ($1, $2, $3::text[], $4::text[], $5::text[], $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [project.id, project.name, project.aliases, project.tags, project.pubky_ids, project.status],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function promoteTrackedProject(db: WeeklyQueryable, id: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE tracked_projects SET status = 'active' WHERE id = $1 AND status = 'candidate' RETURNING id`,
    [id],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function removeTrackedProject(db: WeeklyQueryable, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM tracked_projects WHERE id = $1 RETURNING id`, [id]);
  return (r.rowCount ?? 0) === 1;
}

export async function listCorrectionsSince(
  db: WeeklyQueryable,
  since: Date,
): Promise<Array<{ reply_uri: string; reason: string; created_at: Date }>> {
  const r = await db.query<{ reply_uri: string; reason: string; created_at: Date }>(
    `SELECT reply_uri, reason, created_at FROM corrections WHERE created_at >= $1 ORDER BY created_at ASC`,
    [since],
  );
  return r.rows;
}

export async function listCorrectionsSinceSafe(
  db: WeeklyQueryable,
  since: Date,
): Promise<Array<{ reply_uri: string; reason: string; created_at: Date }>> {
  try {
    return await listCorrectionsSince(db, since);
  } catch (e) {
    if (missingRelation(e)) return [];
    throw e;
  }
}

export async function weeklyTokensUsed(db: WeeklyQueryable, mentionKeyPrefix: string): Promise<number> {
  const r = await db.query<{ total: string | null }>(
    `SELECT SUM(total_tokens)::text AS total FROM token_usage WHERE mention_key LIKE $1`,
    [`${mentionKeyPrefix}%`],
  );
  const val = r.rows[0]?.total ? parseInt(r.rows[0].total, 10) : 0;
  return Number.isNaN(val) ? 0 : val;
}

export async function existingFeedbackUris(db: WeeklyQueryable, uris: string[]): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  const r = await db.query<{ post_uri: string }>(
    `SELECT post_uri FROM feedback_items WHERE post_uri = ANY($1::text[])`,
    [uris],
  );
  return new Set(r.rows.map((row) => row.post_uri));
}

export async function authorExcluded(
  db: WeeklyQueryable,
  author: string,
  blocklist?: ReadonlySet<string>,
): Promise<boolean> {
  if (blocklist?.has(author)) return true;
  const opted = await db.query(`SELECT 1 FROM user_optouts WHERE pubky = $1 AND opted_in_at IS NULL`, [author]);
  if ((opted.rowCount ?? 0) > 0) return true;
  const blocked = await db.query(`SELECT 1 FROM blacklist WHERE public_key = $1`, [author]);
  return (blocked.rowCount ?? 0) > 0;
}

/** Queued rows created before the start of today in `timeZone` (fire day has ended). */
export async function reapStaleWeeklyQueued(
  db: WeeklyQueryable,
  cutoff: Date,
): Promise<number> {
  const r = await db.query(
    `UPDATE weekly_posts SET status = 'skipped'
     WHERE status = 'queued' AND post_uri IS NULL AND created_at < $1`,
    [cutoff],
  );
  return r.rowCount ?? 0;
}

export async function countStaleWeeklyQueued(db: WeeklyQueryable, cutoff: Date): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM weekly_posts
     WHERE status = 'queued' AND post_uri IS NULL AND created_at < $1`,
    [cutoff],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function markWeeklyPublished(db: WeeklyQueryable, mentionKey: string): Promise<number> {
  const r = await db.query(
    `UPDATE weekly_posts SET status = 'published' WHERE mention_key = $1`,
    [mentionKey],
  );
  return r.rowCount ?? 0;
}

/** Latest skipped unpublished week per series (operator health). */
export async function lastSkippedWeeklyBySeries(
  db: WeeklyQueryable,
): Promise<Partial<Record<WeeklySeries, string>>> {
  const r = await db.query<{ series: WeeklySeries; week_key: string }>(
    `SELECT DISTINCT ON (series) series, week_key
     FROM weekly_posts
     WHERE status = 'skipped' AND post_uri IS NULL
     ORDER BY series, week_key DESC`,
  );
  const out: Partial<Record<WeeklySeries, string>> = {};
  for (const row of r.rows) out[row.series] = row.week_key;
  return out;
}

/** Delete a latched skipped slot so `claimWeeklySlot` can take it again. */
export async function reclaimSkippedWeeklySlot(
  db: WeeklyQueryable,
  series: WeeklySeries,
  weekKey: string,
): Promise<boolean> {
  const r = await db.query(
    `DELETE FROM weekly_posts WHERE series = $1 AND week_key = $2 AND status = 'skipped' RETURNING series`,
    [series, weekKey],
  );
  return (r.rowCount ?? 0) === 1;
}
