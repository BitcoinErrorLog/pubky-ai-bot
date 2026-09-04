import type { MentionStatus, Queryable } from "./ingest-store.js";

export type { MentionStatus };

export type WorkItem = {
  id: number;
  mention_key: string;
  author: string;
  kind: string;
  payload: unknown;
  attempts: number;
};

export type ReapResult = { requeued: number; failed: number; exhaustedKeys: string[] };

export type MarkExtra = {
  replyUri?: string;
  rootUri?: string;
  skipReason?: string;
  fallbackReason?: string;
  noticeSuppressed?: boolean;
  quotaNotice?: string;
};

/**
 * Queue subset the reason loop uses: claim/reap/complete/fail/skip of
 * work_queue and handled_mentions. Jeb's Store implements this; SQL lives
 * here so Kit consumers share the same transitions.
 */
export interface WorkStore {
  claimWork(): Promise<WorkItem | null>;
  finishWork(id: number, status: "done" | "failed"): Promise<void>;
  retryWork(id: number): Promise<void>;
  heartbeatWork(id: number): Promise<void>;
  reapStaleWork(staleMs: number, maxAttempts: number): Promise<ReapResult>;
  listStaleProcessingMentions(staleMs: number): Promise<string[]>;
  mark(mentionKey: string, status: MentionStatus, extra?: MarkExtra): Promise<void>;
}

export async function claimWork(db: Queryable): Promise<WorkItem | null> {
  const r = await db.query(
    `UPDATE work_queue SET status = 'claimed', claimed_at = now()
       WHERE id = (
         SELECT id FROM work_queue WHERE status = 'queued' ORDER BY id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, mention_key, author, kind, payload, attempts`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    mention_key: row.mention_key as string,
    author: row.author as string,
    kind: row.kind as string,
    payload: row.payload,
    attempts: Number(row.attempts ?? 0),
  };
}

export async function finishWork(db: Queryable, id: number, status: "done" | "failed"): Promise<void> {
  await db.query("UPDATE work_queue SET status = $2 WHERE id = $1", [id, status]);
}

/** Requeue a claimed row with attempts + 1 (same increment as the stale reaper). */
export async function retryWork(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE work_queue SET status = 'queued', attempts = attempts + 1, claimed_at = NULL
       WHERE id = $1 AND status = 'claimed'`,
    [id],
  );
}

/** Refresh the claim lease so a long handle is not reaped mid-flight. */
export async function heartbeatWork(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE work_queue SET claimed_at = now() WHERE id = $1 AND status = 'claimed'`,
    [id],
  );
}

export async function reapStaleWork(
  db: Queryable,
  staleMs: number,
  maxAttempts: number,
): Promise<ReapResult> {
  const stale = `status = 'claimed' AND claimed_at < now() - ($1::text || ' milliseconds')::interval`;
  const failed = await db.query(
    `UPDATE work_queue SET status = 'failed'
       WHERE ${stale} AND attempts >= $2
       RETURNING mention_key`,
    [String(staleMs), maxAttempts],
  );
  const requeued = await db.query(
    `UPDATE work_queue SET status = 'queued', attempts = attempts + 1, claimed_at = NULL
       WHERE ${stale} AND attempts < $2`,
    [String(staleMs), maxAttempts],
  );
  return {
    requeued: requeued.rowCount ?? 0,
    failed: failed.rows.length,
    exhaustedKeys: failed.rows.map((r) => r.mention_key as string),
  };
}

export async function listStaleProcessingMentions(db: Queryable, staleMs: number): Promise<string[]> {
  const r = await db.query(
    `SELECT h.mention_key
       FROM handled_mentions h
       WHERE h.status = 'processing' AND h.updated_at < now() - ($1::text || ' milliseconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM work_queue w
           WHERE w.mention_key = h.mention_key AND w.status IN ('queued', 'claimed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM publish_requests p
           WHERE p.mention_key = h.mention_key AND p.status IN ('queued', 'retry', 'publishing', 'published')
         )`,
    [String(staleMs)],
  );
  return r.rows.map((row) => row.mention_key as string);
}

export async function markMention(
  db: Queryable,
  mentionKey: string,
  status: MentionStatus,
  extra?: MarkExtra,
): Promise<void> {
  await db.query(
    `UPDATE handled_mentions SET status = $2, reply_uri = COALESCE($3, reply_uri),
       root_uri = COALESCE($4, root_uri),
       skip_reason = COALESCE($5, skip_reason),
       fallback_reason = COALESCE($6, fallback_reason),
       notice_suppressed = COALESCE($7, notice_suppressed),
       quota_notice = COALESCE($8, quota_notice),
       updated_at = now() WHERE mention_key = $1`,
    [
      mentionKey,
      status,
      extra?.replyUri ?? null,
      extra?.rootUri ?? null,
      extra?.skipReason ?? null,
      extra?.fallbackReason ?? null,
      extra?.noticeSuppressed ?? null,
      extra?.quotaNotice ?? null,
    ],
  );
}
