import type { MentionStatus, Queryable } from "../queue/ingest-store.js";
import type { SwitchName } from "../policy/switches.js";

export type { Queryable, MentionStatus };

export type PublishRequestInsert = {
  mentionKey: string;
  parentUri: string;
  content: string;
  evidenceId: number | null;
  failFirstAttempt?: boolean;
  categories?: string[];
  replacePostId?: string | null;
  standalone?: boolean;
  postKind?: "short" | "long" | "collection" | null;
  attachments?: string[] | null;
  collectionId?: string | null;
  approvedBy?: string | null;
  client?: Queryable;
};

export type PublishClaimRow = {
  id: number;
  mention_key: string;
  parent_uri: string;
  content: string;
  evidence_id: number | null;
  attempts: number;
  fail_first_attempt: boolean;
  scrubbed: boolean;
  replace_post_id: string | null;
  standalone: boolean;
  post_kind: string | null;
  attachments: string[] | null;
  collection_id: string | null;
};

export type PendingTagRow = {
  id: number;
  mention_key: string;
  reply_uri: string;
  categories: string[];
};

export type PendingArtifactTagRow = {
  id: number;
  post_uri: string;
  label: string;
  attempts: number;
};

export type ArtifactTagRow = {
  id: number;
  status: string;
  tag_uri: string | null;
};

import type { MarkExtra as HandledMentionMark } from "../queue/work-store.js";
export type { HandledMentionMark };

/**
 * Queue subset the publisher uses: publish_requests, artifact_tags,
 * handled_mentions reconcile, switch reads, plus ping/migrate/close.
 * Evidence/drafts hooks stay on the implementor (Jeb Store).
 */
export interface PublishStore {
  ping(): Promise<boolean>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  switchOn(name: SwitchName): Promise<boolean>;
  setSwitch(name: SwitchName | "global", on: boolean): Promise<void>;
  get(mentionKey: string): Promise<{
    status: MentionStatus;
    reply_uri: string | null;
    root_uri: string | null;
    updated_at: Date;
    author: string | null;
    skip_reason: string | null;
    fallback_reason: string | null;
    notice_suppressed: boolean;
    quota_notice: string | null;
  } | null>;
  mark(mentionKey: string, status: MentionStatus, extra?: HandledMentionMark): Promise<void>;
  insertPublishRequest(row: PublishRequestInsert): Promise<boolean>;
  claimPublish(maxAttempts: number, staleMs?: number): Promise<PublishClaimRow | null>;
  failExhaustedPublishes(maxAttempts: number, staleMs?: number): Promise<number>;
  markPublishDone(id: number): Promise<void>;
  markPublishRetry(id: number, err: string, attempts: number): Promise<void>;
  markPublishFailed(id: number, err: string): Promise<void>;
  markPublishFailedAuth(id: number, err: string): Promise<void>;
  markPublishScrubbed(id: number): Promise<void>;
  setPublishCategories(id: number, categories: string[]): Promise<void>;
  clearFailFirst(id: number): Promise<void>;
  supersedePublishForReplace(mentionKey: string): Promise<void>;
  claimPendingTags(maxAttempts: number): Promise<PendingTagRow | null>;
  markTagsDone(id: number, tagUris: string[]): Promise<void>;
  markTagRetry(id: number, err: string): Promise<void>;
  insertArtifactTag(row: { postUri: string; label: string; approvedBy: string }): Promise<boolean>;
  claimPendingArtifactTag(maxAttempts: number, staleMs?: number): Promise<PendingArtifactTagRow | null>;
  markArtifactTagDone(id: number, tagUri: string): Promise<void>;
  markArtifactTagRetry(id: number, err: string, attempts: number): Promise<void>;
  markArtifactTagFailed(id: number, err: string): Promise<void>;
  getArtifactTag(postUri: string, label: string): Promise<ArtifactTagRow | null>;
  markArtifactTagRevoked(id: number): Promise<void>;
  mergeEvidencePhaseMs(evidenceId: number | null, patch: Record<string, number>): Promise<void>;
  appendEvidenceSecurityEvents(evidenceId: number | null, rules: string[]): Promise<void>;
  markLinkedDraftPublished(publishRequestId: number): Promise<void>;
  markLinkedDraftDeclined(publishRequestId: number): Promise<void>;
}

export async function supersedePublishForReplace(db: Queryable, mentionKey: string): Promise<void> {
  await db.query(
    `UPDATE publish_requests SET status = 'superseded', updated_at = now()
       WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')`,
    [mentionKey],
  );
}

export { markMention as markHandledMention } from "../queue/work-store.js";

export async function insertPublishRequest(db: Queryable, row: PublishRequestInsert): Promise<boolean> {
  const exec = row.client ?? db;
  const r = await exec.query(
    `INSERT INTO publish_requests (
         mention_key, parent_uri, content, evidence_id, fail_first_attempt, categories, replace_post_id,
         standalone, post_kind, attachments, collection_id, approved_by
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12)
       ON CONFLICT (mention_key) WHERE status IN ('queued', 'retry', 'publishing', 'published') DO NOTHING
       RETURNING id`,
    [
      row.mentionKey,
      row.parentUri,
      row.content,
      row.evidenceId,
      row.failFirstAttempt ?? false,
      JSON.stringify(row.categories ?? []),
      row.replacePostId ?? null,
      row.standalone === true,
      row.postKind ?? null,
      row.attachments ? JSON.stringify(row.attachments) : null,
      row.collectionId ?? null,
      row.approvedBy ?? null,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function claimPublish(
  db: Queryable,
  maxAttempts: number,
  staleMs = 120_000,
): Promise<PublishClaimRow | null> {
  const r = await db.query(
    `UPDATE publish_requests SET status = 'publishing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM publish_requests
         WHERE attempts < $1 AND (
           (status IN ('queued', 'retry') AND next_attempt_at <= now())
           OR (status = 'publishing' AND updated_at < now() - ($2::text || ' milliseconds')::interval)
         )
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, mention_key, parent_uri, content, evidence_id, attempts, fail_first_attempt, scrubbed,
         replace_post_id, standalone, post_kind, attachments, collection_id`,
    [maxAttempts, String(staleMs)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const attachments = Array.isArray(row.attachments) ? row.attachments.map(String) : null;
  return {
    id: Number(row.id),
    mention_key: row.mention_key as string,
    parent_uri: row.parent_uri as string,
    content: row.content as string,
    evidence_id: row.evidence_id === null ? null : Number(row.evidence_id),
    attempts: Number(row.attempts),
    fail_first_attempt: row.fail_first_attempt === true,
    scrubbed: row.scrubbed === true,
    replace_post_id: typeof row.replace_post_id === "string" ? row.replace_post_id : null,
    standalone: row.standalone === true,
    post_kind: typeof row.post_kind === "string" ? row.post_kind : null,
    attachments,
    collection_id: typeof row.collection_id === "string" ? row.collection_id : null,
  };
}

export async function failExhaustedPublishes(
  db: Queryable,
  maxAttempts: number,
  staleMs = 120_000,
): Promise<number> {
  const r = await db.query(
    `UPDATE publish_requests SET status = 'failed', updated_at = now()
       WHERE attempts >= $1 AND (
         status = 'retry'
         OR (status = 'publishing' AND updated_at < now() - ($2::text || ' milliseconds')::interval)
       )`,
    [maxAttempts, String(staleMs)],
  );
  return r.rowCount ?? 0;
}

export async function markPublishDone(db: Queryable, id: number): Promise<void> {
  await db.query(`UPDATE publish_requests SET status = 'published', updated_at = now() WHERE id = $1`, [id]);
}

export async function markPublishScrubbed(db: Queryable, id: number): Promise<void> {
  await db.query(`UPDATE publish_requests SET scrubbed = TRUE, updated_at = now() WHERE id = $1`, [id]);
}

export async function setPublishCategories(db: Queryable, id: number, categories: string[]): Promise<void> {
  await db.query(`UPDATE publish_requests SET categories = $2::jsonb, updated_at = now() WHERE id = $1`, [
    id,
    JSON.stringify(categories),
  ]);
}

export async function markPublishRetry(db: Queryable, id: number, err: string, attempts: number): Promise<void> {
  const backoffMs = Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
  await db.query(
    `UPDATE publish_requests SET status = 'retry', last_error = $2,
       next_attempt_at = now() + ($3::text || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
    [id, err.slice(0, 500), String(backoffMs)],
  );
}

export async function clearFailFirst(db: Queryable, id: number): Promise<void> {
  await db.query("UPDATE publish_requests SET fail_first_attempt = FALSE WHERE id = $1", [id]);
}

export async function claimPendingTags(db: Queryable, maxAttempts: number): Promise<PendingTagRow | null> {
  const r = await db.query(
    `SELECT p.id, p.mention_key, h.reply_uri, p.categories
       FROM publish_requests p
       JOIN handled_mentions h ON h.mention_key = p.mention_key
       WHERE p.status = 'published' AND p.tag_uris IS NULL AND p.tag_attempts < $1
         AND p.categories <> '[]'::jsonb AND h.reply_uri IS NOT NULL
       ORDER BY p.id LIMIT 1`,
    [maxAttempts],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    mention_key: row.mention_key as string,
    reply_uri: row.reply_uri as string,
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
  };
}

export async function markTagsDone(db: Queryable, id: number, tagUris: string[]): Promise<void> {
  await db.query(`UPDATE publish_requests SET tag_uris = $2::jsonb, updated_at = now() WHERE id = $1`, [
    id,
    JSON.stringify(tagUris),
  ]);
}

export async function markTagRetry(db: Queryable, id: number, err: string): Promise<void> {
  await db.query(
    `UPDATE publish_requests SET tag_attempts = tag_attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
    [id, err.slice(0, 500)],
  );
}

export async function markPublishFailed(db: Queryable, id: number, err: string): Promise<void> {
  await db.query(
    `UPDATE publish_requests SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, err.slice(0, 500)],
  );
}

export async function markPublishFailedAuth(db: Queryable, id: number, err: string): Promise<void> {
  await db.query(
    `UPDATE publish_requests SET status = 'failed_auth', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, err.slice(0, 500)],
  );
}

export async function insertArtifactTag(
  db: Queryable,
  row: { postUri: string; label: string; approvedBy: string },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO artifact_tags (post_uri, label, approved_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_uri, label) WHERE status IN ('queued', 'retry', 'publishing', 'published') DO NOTHING
       RETURNING id`,
    [row.postUri, row.label, row.approvedBy],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function claimPendingArtifactTag(
  db: Queryable,
  maxAttempts: number,
  staleMs = 120_000,
): Promise<PendingArtifactTagRow | null> {
  const r = await db.query(
    `UPDATE artifact_tags SET status = 'publishing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM artifact_tags
         WHERE attempts < $1 AND (
           (status IN ('queued', 'retry') AND next_attempt_at <= now())
           OR (status = 'publishing' AND updated_at < now() - ($2::text || ' milliseconds')::interval)
         )
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, post_uri, label, attempts`,
    [maxAttempts, String(staleMs)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    post_uri: row.post_uri as string,
    label: row.label as string,
    attempts: Number(row.attempts),
  };
}

export async function markArtifactTagDone(db: Queryable, id: number, tagUri: string): Promise<void> {
  await db.query(`UPDATE artifact_tags SET status = 'published', tag_uri = $2, updated_at = now() WHERE id = $1`, [
    id,
    tagUri,
  ]);
}

export async function markArtifactTagRetry(db: Queryable, id: number, err: string, attempts: number): Promise<void> {
  const backoffMs = Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
  await db.query(
    `UPDATE artifact_tags SET status = 'retry', last_error = $2,
       next_attempt_at = now() + ($3::text || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
    [id, err.slice(0, 500), String(backoffMs)],
  );
}

export async function markArtifactTagFailed(db: Queryable, id: number, err: string): Promise<void> {
  await db.query(`UPDATE artifact_tags SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [
    id,
    err.slice(0, 500),
  ]);
}

export async function getArtifactTag(db: Queryable, postUri: string, label: string): Promise<ArtifactTagRow | null> {
  const r = await db.query(
    `SELECT id, status, tag_uri FROM artifact_tags WHERE post_uri = $1 AND label = $2
       ORDER BY id DESC LIMIT 1`,
    [postUri, label],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    status: String(row.status),
    tag_uri: row.tag_uri === null ? null : String(row.tag_uri),
  };
}

export async function markArtifactTagRevoked(db: Queryable, id: number): Promise<void> {
  await db.query(`UPDATE artifact_tags SET status = 'revoked', updated_at = now() WHERE id = $1`, [id]);
}
