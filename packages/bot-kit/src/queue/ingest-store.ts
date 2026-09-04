/** pg.Pool / PoolClient compatible query surface — Kit does not import `pg`. */
export type Queryable = {
  query: (
    queryText: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export type MentionStatus = "processing" | "published" | "failed" | "skipped";

export type HandledMentionRow = {
  status: MentionStatus;
  reply_uri: string | null;
  root_uri: string | null;
  updated_at: Date;
  author: string | null;
  skip_reason: string | null;
  fallback_reason: string | null;
  notice_suppressed: boolean;
  quota_notice: string | null;
};

export type CursorState = { lastTs: number; firstBootDone: boolean };

/**
 * Queue subset ingest uses: cursor, handled_mentions claim, work enqueue,
 * plus ping/switch/migrate/close that the ingest loop already called on Store.
 */
export interface IngestStore {
  ping(): Promise<boolean>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  switchOn(name: "consumption"): Promise<boolean>;
  getCursor(botId: string, nexusUrl: string): Promise<CursorState>;
  setCursor(botId: string, nexusUrl: string, lastTs: number, firstBootDone: boolean): Promise<void>;
  get(mentionKey: string): Promise<HandledMentionRow | null>;
  claim(mentionKey: string, author: string, botId: string): Promise<"claimed" | "exists">;
  hasActiveWork(mentionKey: string, staleMs: number): Promise<boolean>;
  hasActivePublish(mentionKey: string): Promise<boolean>;
  enqueueWork(mentionKey: string, author: string, kind: string, payload: unknown): Promise<boolean>;
}

export async function getCursor(db: Queryable, botId: string, nexusUrl: string): Promise<CursorState> {
  const r = await db.query(
    `INSERT INTO cursor_state (bot_id, nexus_url, last_ts, first_boot_done) VALUES ($1, $2, 0, FALSE)
       ON CONFLICT (bot_id, nexus_url) DO UPDATE SET bot_id = EXCLUDED.bot_id
       RETURNING last_ts, first_boot_done`,
    [botId, nexusUrl],
  );
  const row = r.rows[0] as { last_ts: string | number; first_boot_done: boolean };
  return { lastTs: Number(row.last_ts), firstBootDone: row.first_boot_done };
}

export async function setCursor(
  db: Queryable,
  botId: string,
  nexusUrl: string,
  lastTs: number,
  firstBootDone: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO cursor_state (bot_id, nexus_url, last_ts, first_boot_done) VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id, nexus_url) DO UPDATE SET last_ts = EXCLUDED.last_ts, first_boot_done = EXCLUDED.first_boot_done`,
    [botId, nexusUrl, lastTs, firstBootDone],
  );
}

export async function claim(
  db: Queryable,
  mentionKey: string,
  author: string,
  botId: string,
): Promise<"claimed" | "exists"> {
  const r = await db.query(
    `INSERT INTO handled_mentions (mention_key, status, author, bot_id)
       VALUES ($1, 'processing', $2, $3)
       ON CONFLICT (mention_key) DO UPDATE
         SET status = 'processing', author = EXCLUDED.author, bot_id = EXCLUDED.bot_id, updated_at = now()
         WHERE handled_mentions.status = 'failed'
       RETURNING mention_key`,
    [mentionKey, author, botId],
  );
  return r.rowCount === 1 ? "claimed" : "exists";
}

export async function getHandledMention(db: Queryable, mentionKey: string): Promise<HandledMentionRow | null> {
  const r = await db.query(
    `SELECT status, reply_uri, root_uri, updated_at, author, skip_reason, fallback_reason, notice_suppressed, quota_notice FROM handled_mentions WHERE mention_key = $1`,
    [mentionKey],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    status: row.status as MentionStatus,
    reply_uri: row.reply_uri as string | null,
    root_uri: row.root_uri as string | null,
    updated_at: row.updated_at as Date,
    author: row.author as string | null,
    skip_reason: (row.skip_reason as string | null) ?? null,
    fallback_reason: (row.fallback_reason as string | null) ?? null,
    notice_suppressed: row.notice_suppressed === true,
    quota_notice: (row.quota_notice as string | null) ?? null,
  };
}

export async function hasActiveWork(db: Queryable, mentionKey: string, staleMs: number): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM work_queue
       WHERE mention_key = $1 AND (
         status = 'queued'
         OR (status = 'claimed' AND claimed_at IS NOT NULL
             AND claimed_at >= now() - ($2::text || ' milliseconds')::interval)
       )
       LIMIT 1`,
    [mentionKey, String(staleMs)],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function hasActivePublish(db: Queryable, mentionKey: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM publish_requests
       WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')
       LIMIT 1`,
    [mentionKey],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function enqueueWork(
  db: Queryable,
  mentionKey: string,
  author: string,
  kind: string,
  payload: unknown,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO work_queue (mention_key, author, kind, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'queued')
       ON CONFLICT (mention_key) WHERE status IN ('queued', 'claimed') DO NOTHING
       RETURNING id`,
    [mentionKey, author, kind, JSON.stringify(payload)],
  );
  return (r.rowCount ?? 0) > 0;
}
