import pg from "pg";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import type { SwitchName } from "./switches.js";
import type { Draft, DraftEvidence, DraftFormat, DraftRow, DraftStatus } from "./drafts/types.js";
import {
  claim as claimSql,
  enqueueWork as enqueueWorkSql,
  getCursor as getCursorSql,
  getHandledMention,
  hasActivePublish as hasActivePublishSql,
  hasActiveWork as hasActiveWorkSql,
  setCursor as setCursorSql,
  type IngestStore,
  type MentionStatus,
  type Queryable as IngestQueryable,
} from "./bot-kit/queue/ingest-store.js";
import {
  killSwitchOn as killSwitchOnSql,
  setSwitch as setSwitchSql,
  switchOn as switchOnSql,
  type SwitchStore,
} from "./bot-kit/queue/switch-store.js";

export { switchOnSql };
import {
  claimWork as claimWorkSql,
  finishWork as finishWorkSql,
  heartbeatWork as heartbeatWorkSql,
  listStaleProcessingMentions as listStaleProcessingMentionsSql,
  markMention as markMentionSql,
  reapStaleWork as reapStaleWorkSql,
  retryWork as retryWorkSql,
  type MarkExtra,
  type WorkItem,
  type WorkStore,
} from "./bot-kit/queue/work-store.js";
import type { PolicyStore } from "./bot-kit/policy/policy.js";
import { collectionMentionKey } from "./bot-kit/publish/post.js";
import {
  claimPendingArtifactTag as claimPendingArtifactTagSql,
  claimPendingTags as claimPendingTagsSql,
  claimPublish as claimPublishSql,
  clearFailFirst as clearFailFirstSql,
  failExhaustedArtifactTags as failExhaustedArtifactTagsSql,
  failExhaustedPublishes as failExhaustedPublishesSql,
  getArtifactTag as getArtifactTagSql,
  insertArtifactTag as insertArtifactTagSql,
  insertPublishRequest as insertPublishRequestSql,
  markArtifactTagDone as markArtifactTagDoneSql,
  markArtifactTagFailed as markArtifactTagFailedSql,
  markArtifactTagRetry as markArtifactTagRetrySql,
  markArtifactTagRevoked as markArtifactTagRevokedSql,
  markPublishDone as markPublishDoneSql,
  markPublishFailed as markPublishFailedSql,
  markPublishFailedAuth as markPublishFailedAuthSql,
  markPublishRetry as markPublishRetrySql,
  markPublishScrubbed as markPublishScrubbedSql,
  markTagRetry as markTagRetrySql,
  markTagsDone as markTagsDoneSql,
  setPublishCategories as setPublishCategoriesSql,
  supersedePublishForReplace as supersedePublishForReplaceSql,
  type PublishStore,
} from "./bot-kit/publish/publish-store.js";
import {
  insertWebQuery as insertWebQuerySql,
  type WebQueryInsert,
  type WebStore,
} from "./bot-kit/web/web-store.js";
import {
  listArtifactTags as listArtifactTagsSql,
  markSelfTagsDone as markSelfTagsDoneSql,
  recordTagEvent as recordTagEventSql,
  type TagEvent,
  type TagStore,
} from "./bot-kit/tags/tag-store.js";

export type Queryable = { query: pg.Pool["query"] };

export type { MentionStatus };

/** Transaction-scoped lock for the proactive daily cap (audit A2 F-1). */
export const JEB_PROACTIVE_CAP_LOCK = 2016090401;

export class Store implements IngestStore, SwitchStore, PolicyStore, WorkStore, PublishStore, WebStore, TagStore {
  readonly pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 8 });
  }

  async migrate(): Promise<void> {
    if (process.env.JEB_SKIP_MIGRATIONS === "1") return;
    const migrator = new DatabaseMigrator(this.pool);
    await migrator.runMigrations();
    await this.pool.query(`ALTER TABLE handled_mentions ADD COLUMN IF NOT EXISTS bot_id TEXT`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async killSwitchOn(): Promise<boolean> {
    return killSwitchOnSql(this.ingestDb());
  }

  async switchOn(name: SwitchName): Promise<boolean> {
    return switchOnSql(this.ingestDb(), name);
  }

  async setSwitch(name: SwitchName | "global", on: boolean): Promise<void> {
    await setSwitchSql(this.ingestDb(), name, on);
  }

  async insertWebQuery(row: WebQueryInsert): Promise<void> {
    await insertWebQuerySql(this.ingestDb(), row);
  }

  private ingestDb(): IngestQueryable {
    return this.pool as unknown as IngestQueryable;
  }

  async getCursor(botId: string, nexusUrl: string): Promise<{ lastTs: number; firstBootDone: boolean }> {
    return getCursorSql(this.ingestDb(), botId, nexusUrl);
  }

  async setCursor(botId: string, nexusUrl: string, lastTs: number, firstBootDone: boolean): Promise<void> {
    await setCursorSql(this.ingestDb(), botId, nexusUrl, lastTs, firstBootDone);
  }

  async claim(mentionKey: string, author: string, botId: string): Promise<"claimed" | "exists"> {
    return claimSql(this.ingestDb(), mentionKey, author, botId);
  }

  /**
   * Operator reopen: set skipped/failed/processing rows back to processing
   * and clear skip/fallback reasons. Published rows are left alone.
   */
  async reopenMentionForRequeue(
    mentionKey: string,
    author: string,
    botId: string,
  ): Promise<"reopened" | "published"> {
    const r = await this.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id, skip_reason, fallback_reason, notice_suppressed, quota_notice)
       VALUES ($1, 'processing', $2, $3, NULL, NULL, FALSE, NULL)
       ON CONFLICT (mention_key) DO UPDATE
         SET status = 'processing',
             author = EXCLUDED.author,
             bot_id = EXCLUDED.bot_id,
             skip_reason = NULL,
             fallback_reason = NULL,
             notice_suppressed = FALSE,
             quota_notice = NULL,
             updated_at = now()
         WHERE handled_mentions.status <> 'published'
       RETURNING mention_key`,
      [mentionKey, author, botId],
    );
    return r.rowCount === 1 ? "reopened" : "published";
  }

  /**
   * Operator in-place re-answer: reopen even a published row (keep reply_uri)
   * so reason/publish can overwrite the existing reply.
   */
  async reopenMentionForReplace(mentionKey: string, author: string, botId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id, skip_reason, fallback_reason, notice_suppressed, quota_notice)
       VALUES ($1, 'processing', $2, $3, NULL, NULL, FALSE, NULL)
       ON CONFLICT (mention_key) DO UPDATE
         SET status = 'processing',
             author = EXCLUDED.author,
             bot_id = EXCLUDED.bot_id,
             skip_reason = NULL,
             fallback_reason = NULL,
             notice_suppressed = FALSE,
             quota_notice = NULL,
             updated_at = now()`,
      [mentionKey, author, botId],
    );
  }

  /** Drop the unique-index occupancy so a new publish_requests row can insert. */
  async supersedePublishForReplace(mentionKey: string): Promise<void> {
    await supersedePublishForReplaceSql(this.ingestDb(), mentionKey);
  }

  async get(mentionKey: string): Promise<{
    status: MentionStatus;
    reply_uri: string | null;
    root_uri: string | null;
    updated_at: Date;
    author: string | null;
    skip_reason: string | null;
    fallback_reason: string | null;
    notice_suppressed: boolean;
    quota_notice: string | null;
  } | null> {
    return getHandledMention(this.ingestDb(), mentionKey);
  }

  async mark(mentionKey: string, status: MentionStatus, extra?: MarkExtra): Promise<void> {
    await markMentionSql(this.ingestDb(), mentionKey, status, extra);
  }

  /**
   * R-01(a): reap work rows whose claim went stale (crash/restart of the
   * reason process between claimWork and finishWork). Rows under the attempt
   * cap go back to `queued` with attempts + 1; rows at the cap go terminal
   * `failed` and their `handled_mentions` row is marked `failed` too, so a
   * later mention can re-claim it. Idempotent: re-running reasonOne re-marks
   * the mention and the publish path dedupes on the active request.
   */
  async reapStaleWork(
    staleMs: number,
    maxAttempts: number,
  ): Promise<{ requeued: number; failed: number; exhaustedKeys: string[] }> {
    // Do not mark the mention failed: the reason tick inserts a fallback reply
    // so a policy-passed mention never ends with zero published answers.
    return reapStaleWorkSql(this.ingestDb(), staleMs, maxAttempts);
  }

  /**
   * R-01(b): fail `handled_mentions` rows stuck in `processing` with no
   * active work row and no active publish request past the same window
   * (e.g. a crash between the ingest claim and the enqueue). Runs after
   * reapStaleWork in the reason tick, so a requeued row still protects its
   * mention while a terminally failed one does not.
   */
  async listStaleProcessingMentions(staleMs: number): Promise<string[]> {
    return listStaleProcessingMentionsSql(this.ingestDb(), staleMs);
  }

  /** Mentions past the reply deadline with no active publish request yet. */
  async listOverdueUnpublished(deadlineMs: number): Promise<Array<{ mention_key: string; author: string; work_id: number | null }>> {
    const r = await this.pool.query<{ mention_key: string; author: string; work_id: string | null }>(
      `SELECT h.mention_key, h.author, w.id::text AS work_id
       FROM handled_mentions h
       LEFT JOIN work_queue w ON w.mention_key = h.mention_key AND w.status IN ('queued', 'claimed')
       WHERE h.status = 'processing'
         AND COALESCE(w.created_at, h.created_at) < now() - ($1::text || ' milliseconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM publish_requests p
           WHERE p.mention_key = h.mention_key AND p.status IN ('queued', 'retry', 'publishing', 'published')
         )`,
      [String(deadlineMs)],
    );
    return r.rows.map((row) => ({
      mention_key: row.mention_key,
      author: row.author,
      work_id: row.work_id === null ? null : Number(row.work_id),
    }));
  }

  async publishedInThread(botId: string, rootUri: string, exceptKey?: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM handled_mentions
       WHERE bot_id = $1 AND root_uri = $2 AND status IN ('published', 'processing')
         AND ($3::text IS NULL OR mention_key <> $3)`,
      [botId, rootUri, exceptKey ?? null],
    );
    return r.rows[0]?.n ?? 0;
  }

  async publishedByAuthorLastHour(author: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM handled_mentions
       WHERE author = $1 AND status = 'published' AND updated_at > now() - interval '1 hour'`,
      [author],
    );
    return r.rows[0]?.n ?? 0;
  }

  async oldestPublishedByAuthorLastHour(author: string): Promise<Date | null> {
    const r = await this.pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM handled_mentions
       WHERE author = $1 AND status = 'published' AND updated_at > now() - interval '1 hour'
       ORDER BY updated_at ASC LIMIT 1`,
      [author],
    );
    return r.rows[0]?.updated_at ?? null;
  }

  async publishedByAuthorInThread(author: string, rootUri: string, exceptKey?: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM handled_mentions
       WHERE author = $1 AND root_uri = $2 AND status IN ('published', 'processing')
         AND ($3::text IS NULL OR mention_key <> $3)`,
      [author, rootUri, exceptKey ?? null],
    );
    return r.rows[0]?.n ?? 0;
  }

  async blacklistHas(publicKey: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM blacklist WHERE public_key = $1", [publicKey]);
    return (r.rowCount ?? 0) > 0;
  }

  async isUserOptedOut(pubky: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM user_optouts WHERE pubky = $1 AND opted_in_at IS NULL`,
      [pubky],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setUserOptOut(pubky: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_optouts (pubky, opted_out_at, opted_in_at, reason)
       VALUES ($1, now(), NULL, $2)
       ON CONFLICT (pubky) DO UPDATE SET
         opted_out_at = now(), opted_in_at = NULL, reason = EXCLUDED.reason`,
      [pubky, reason.slice(0, 500)],
    );
  }

  async setUserOptIn(pubky: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_optouts SET opted_in_at = now() WHERE pubky = $1 AND opted_in_at IS NULL`,
      [pubky],
    );
  }

  async countActiveOptouts(): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_optouts WHERE opted_in_at IS NULL`,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async listUserOptouts(): Promise<Array<{ pubky: string; opted_out_at: Date; opted_in_at: Date | null; reason: string | null }>> {
    const r = await this.pool.query<{
      pubky: string;
      opted_out_at: Date;
      opted_in_at: Date | null;
      reason: string | null;
    }>(
      `SELECT pubky, opted_out_at, opted_in_at, reason FROM user_optouts
       WHERE opted_in_at IS NULL ORDER BY opted_out_at ASC`,
    );
    return r.rows;
  }

  async recordRateEvent(publicKey: string): Promise<void> {
    await this.pool.query("INSERT INTO rate_limit_events (public_key) VALUES ($1)", [publicKey]);
  }

  async rateCountLastHour(publicKey: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM rate_limit_events
       WHERE public_key = $1 AND occurred_at > now() - interval '1 hour'`,
      [publicKey],
    );
    return r.rows[0]?.n ?? 0;
  }

  /**
   * Active means `queued` or a non-stale `claimed` row. A stale claim (crash
   * before finishWork) must not block re-delivery — the reason-tick reaper
   * requeues it, and the partial unique index keeps the re-enqueue a no-op
   * until then.
   */
  async hasActiveWork(mentionKey: string, staleMs: number): Promise<boolean> {
    return hasActiveWorkSql(this.ingestDb(), mentionKey, staleMs);
  }

  async hasActivePublish(mentionKey: string): Promise<boolean> {
    return hasActivePublishSql(this.ingestDb(), mentionKey);
  }

  /** Returns true when a new queued row was inserted. */
  async enqueueWork(mentionKey: string, author: string, kind: string, payload: unknown): Promise<boolean> {
    return enqueueWorkSql(this.ingestDb(), mentionKey, author, kind, payload);
  }

  async mergeWorkPayload(mentionKey: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE work_queue SET payload = payload || $2::jsonb
       WHERE mention_key = $1 AND status IN ('queued', 'claimed')`,
      [mentionKey, JSON.stringify(payload)],
    );
  }

  async claimWork(): Promise<WorkItem | null> {
    return claimWorkSql(this.ingestDb());
  }

  async finishWork(id: number, status: "done" | "failed"): Promise<void> {
    await finishWorkSql(this.ingestDb(), id, status);
  }

  async retryWork(id: number): Promise<void> {
    await retryWorkSql(this.ingestDb(), id);
  }

  async heartbeatWork(id: number): Promise<void> {
    await heartbeatWorkSql(this.ingestDb(), id);
  }

  async knowledgeChunkCount(): Promise<number> {
    try {
      const r = await this.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM knowledge_chunks");
      return Number(r.rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }

  async insertEvidence(row: {
    mentionKey: string;
    intent: string;
    toolTrace: unknown;
    sources: unknown;
    model: string | null;
    tokens: number | null;
    latencyMs: number | null;
    voiceViolations?: unknown;
    phaseMs?: unknown;
    categories?: string[];
    kind?: string;
    fallbackReason?: string;
    quotaNotice?: string;
  }): Promise<number> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO evidence (mention_key, intent, tool_trace, sources, model, tokens, latency_ms, voice_violations, phase_ms, categories, kind, fallback_reason, quota_notice)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13) RETURNING id`,
      [
        row.mentionKey,
        row.intent,
        JSON.stringify(row.toolTrace),
        JSON.stringify(row.sources),
        row.model,
        row.tokens,
        row.latencyMs,
        JSON.stringify(row.voiceViolations ?? []),
        JSON.stringify(row.phaseMs ?? {}),
        JSON.stringify(row.categories ?? []),
        row.kind ?? null,
        row.fallbackReason ?? null,
        row.quotaNotice ?? null,
      ],
    );
    return Number(r.rows[0].id);
  }

  /** Distinct knowledge products whose chunks were used as evidence for a mention. */
  async knowledgeProducts(mentionKey: string): Promise<string[]> {
    const r = await this.pool.query<{ product: string }>(
      `SELECT DISTINCT product FROM knowledge_answer_evidence WHERE mention_key = $1`,
      [mentionKey],
    );
    return r.rows.map((row) => row.product);
  }

  /** Returns true when a new request was inserted. Duplicate active/published keys are a no-op. */
  async insertPublishRequest(row: {
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
  }): Promise<boolean> {
    return insertPublishRequestSql(this.ingestDb(), {
      ...row,
      client: row.client ? (row.client as unknown as IngestQueryable) : undefined,
    });
  }

  /**
   * Claims the next publishable row. Besides queued/retry rows this reclaims
   * rows stuck in `publishing` for longer than `staleMs` (a crash between
   * claim and completion). Reclaimed rows go through the same reconcile path
   * in publishOne, so a PUT that succeeded before the crash is recorded as
   * published instead of being re-published.
   */
  async claimPublish(maxAttempts: number, staleMs = 120_000): Promise<{
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
    approved_by: string | null;
    categories: string[];
  } | null> {
    return claimPublishSql(this.ingestDb(), maxAttempts, staleMs);
  }

  /**
   * Terminal state for rows that exhausted their attempts. `publishing` rows
   * are only touched once they are also stale (an in-flight claim by another
   * publisher process is never failed underneath it).
   */
  async failExhaustedPublishes(maxAttempts: number, staleMs = 120_000): Promise<number> {
    return failExhaustedPublishesSql(this.ingestDb(), maxAttempts, staleMs);
  }

  async failExhaustedArtifactTags(maxAttempts: number, staleMs = 120_000): Promise<number> {
    return failExhaustedArtifactTagsSql(this.ingestDb(), maxAttempts, staleMs);
  }

  async markPublishDone(id: number): Promise<void> {
    await markPublishDoneSql(this.ingestDb(), id);
  }

  async mergeEvidencePhaseMs(evidenceId: number | null, patch: Record<string, number>): Promise<void> {
    if (evidenceId === null) return;
    await this.pool.query(
      `UPDATE evidence SET phase_ms = COALESCE(phase_ms, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [evidenceId, JSON.stringify(patch)],
    );
  }

  /**
   * Records a secret-scrubber detection in the evidence bundle. Rule ids
   * only — the matched text is never stored.
   */
  async appendEvidenceSecurityEvents(evidenceId: number | null, rules: string[]): Promise<void> {
    if (evidenceId === null || rules.length === 0) return;
    const entries = rules.map((r) => ({ rule: "security_event", detail: r }));
    await this.pool.query(
      `UPDATE evidence SET voice_violations = COALESCE(voice_violations, '[]'::jsonb) || $2::jsonb WHERE id = $1`,
      [evidenceId, JSON.stringify(entries)],
    );
  }

  /**
   * Records that the outbound gate fired on this row. Retries then publish
   * the decline without re-scanning or re-appending security_event evidence.
   */
  async markPublishScrubbed(id: number): Promise<void> {
    await markPublishScrubbedSql(this.ingestDb(), id);
  }

  /** Replaces the queued self-tag categories (scrub gate downgrades to ["declined"]). */
  async setPublishCategories(id: number, categories: string[]): Promise<void> {
    await setPublishCategoriesSql(this.ingestDb(), id, categories);
  }

  async markPublishRetry(id: number, err: string, attempts: number): Promise<void> {
    await markPublishRetrySql(this.ingestDb(), id, err, attempts);
  }

  async clearFailFirst(id: number): Promise<void> {
    await clearFailFirstSql(this.ingestDb(), id);
  }

  /**
   * Ticket 12c: next published row whose category self-tags are still pending
   * (no recorded `tag_uris`, attempts under the give-up cap, non-empty
   * categories, and a known reply URI). Plain SELECT: a single publisher
   * process owns this queue, and a crash before the outcome is recorded just
   * retries on the next tick — re-PUT of a tag is idempotent by spec (the tag
   * id is a hash of uri+label).
   */
  async claimPendingTags(maxAttempts: number): Promise<{
    id: number;
    mention_key: string;
    reply_uri: string;
    categories: string[];
  } | null> {
    return claimPendingTagsSql(this.ingestDb(), maxAttempts);
  }

  async markTagsDone(id: number, tagUris: string[]): Promise<void> {
    await markTagsDoneSql(this.ingestDb(), id, tagUris);
  }

  async markTagRetry(id: number, err: string): Promise<void> {
    await markTagRetrySql(this.ingestDb(), id, err);
  }

  /** Terminal failure for a row that must never be retried (e.g. invalid shape). */
  async markPublishFailed(id: number, err: string): Promise<void> {
    await markPublishFailedSql(this.ingestDb(), id, err);
  }

  async markPublishFailedAuth(id: number, err: string): Promise<void> {
    await markPublishFailedAuthSql(this.ingestDb(), id, err);
  }

  async insertArtifactTag(row: { postUri: string; label: string; approvedBy: string }): Promise<boolean> {
    return insertArtifactTagSql(this.ingestDb(), row);
  }

  async claimPendingArtifactTag(maxAttempts: number, staleMs = 120_000): Promise<{
    id: number;
    post_uri: string;
    label: string;
    attempts: number;
    approved_by: string | null;
  } | null> {
    return claimPendingArtifactTagSql(this.ingestDb(), maxAttempts, staleMs);
  }

  async markArtifactTagDone(id: number, tagUri: string): Promise<number> {
    return markArtifactTagDoneSql(this.ingestDb(), id, tagUri);
  }

  async markArtifactTagRetry(id: number, err: string, attempts: number): Promise<void> {
    await markArtifactTagRetrySql(this.ingestDb(), id, err, attempts);
  }

  async markArtifactTagFailed(id: number, err: string): Promise<void> {
    await markArtifactTagFailedSql(this.ingestDb(), id, err);
  }

  async listArtifactTags(): Promise<
    Array<{ post_uri: string; label: string; status: string; tag_uri: string | null; approved_by: string }>
  > {
    return listArtifactTagsSql(this.ingestDb());
  }

  async recordTagEvent(event: TagEvent): Promise<void> {
    await recordTagEventSql(this.ingestDb(), event);
  }

  async getArtifactTag(
    postUri: string,
    label: string,
  ): Promise<{ id: number; status: string; tag_uri: string | null } | null> {
    return getArtifactTagSql(this.ingestDb(), postUri, label);
  }

  async markArtifactTagRevoked(id: number): Promise<void> {
    await markArtifactTagRevokedSql(this.ingestDb(), id);
  }

  async markSelfTagsDone(replyUri: string, tagUris: string[]): Promise<void> {
    await markSelfTagsDoneSql(this.ingestDb(), replyUri, tagUris);
  }

  async listCollectionRequests(): Promise<
    Array<{
      mention_key: string;
      content: string;
      status: string;
      replace_post_id: string | null;
      approved_by: string | null;
    }>
  > {
    const r = await this.pool.query(
      `SELECT mention_key, content, status, replace_post_id, approved_by
       FROM publish_requests
       WHERE standalone AND post_kind = 'collection'
       ORDER BY id`,
    );
    return r.rows.map((row) => ({
      mention_key: String(row.mention_key),
      content: String(row.content),
      status: String(row.status),
      replace_post_id: row.replace_post_id === null ? null : String(row.replace_post_id),
      approved_by: row.approved_by === null ? null : String(row.approved_by),
    }));
  }

  async recordUsage(row: {
    mentionKey: string;
    publicKey: string;
    phase: string;
    provider?: string;
    model?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
  }): Promise<void> {
    if (!row.totalTokens && !row.inputTokens && !row.outputTokens) return;
    await this.pool.query(
      `INSERT INTO token_usage (mention_key, public_key, phase, provider, model, input_tokens, output_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.mentionKey,
        row.publicKey,
        row.phase,
        row.provider ?? null,
        row.model ?? null,
        row.inputTokens ?? null,
        row.outputTokens ?? null,
        row.totalTokens ?? null,
      ],
    );
  }

  async globalDailyTokens(): Promise<number> {
    const r = await this.pool.query<{ total: string | null }>(
      `SELECT SUM(total_tokens)::text AS total FROM token_usage WHERE created_at >= date_trunc('day', now())`,
    );
    const val = r.rows[0]?.total ? parseInt(r.rows[0].total, 10) : 0;
    return Number.isNaN(val) ? 0 : val;
  }

  async userDailyTokens(publicKey: string): Promise<number> {
    const r = await this.pool.query<{ total: string | null }>(
      `SELECT SUM(total_tokens)::text AS total FROM token_usage
       WHERE public_key = $1 AND created_at >= date_trunc('day', now())`,
      [publicKey],
    );
    const val = r.rows[0]?.total ? parseInt(r.rows[0].total, 10) : 0;
    return Number.isNaN(val) ? 0 : val;
  }

  /** p50 of per-row total_tokens over 7 days; 20_000 when there is no history. */
  async typicalAnswerTokensP50(): Promise<number> {
    const r = await this.pool.query<{ p50: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_tokens)::text AS p50
       FROM token_usage
       WHERE created_at >= now() - interval '7 days'
         AND total_tokens IS NOT NULL AND total_tokens > 0`,
    );
    const raw = r.rows[0]?.p50;
    if (!raw) return 20_000;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 20_000;
  }

  async claimOperatorFlag(name: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO operator_flags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name`,
      [name],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async hasPolicyNoticeForAuthor(author: string, reason: string, hours: number): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM evidence e
       JOIN handled_mentions h ON h.mention_key = e.mention_key
       WHERE h.author = $1 AND e.fallback_reason = $2 AND e.kind = 'policy_notice'
         AND e.created_at > now() - ($3::text || ' hours')::interval
       LIMIT 1`,
      [author, reason, String(hours)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async hasPolicyNoticeInThread(rootUri: string, reason: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM evidence e
       JOIN handled_mentions h ON h.mention_key = e.mention_key
       WHERE h.root_uri = $1 AND e.fallback_reason = $2 AND e.kind = 'policy_notice'
       LIMIT 1`,
      [rootUri, reason],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async hasQuotaNoticeInThread(rootUri: string, rule: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM handled_mentions
       WHERE root_uri = $1 AND quota_notice = $2
       LIMIT 1`,
      [rootUri, rule],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async auditRoute(mentionKey: string, intent: string): Promise<void> {
    await this.pool.query("INSERT INTO routing_audit (mention_key, intent) VALUES ($1, $2)", [mentionKey, intent]);
  }

  async setDebugAncestors(ancestors: Array<{ uri: string; createdAt: number }>): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS debug_state (
         id INT PRIMARY KEY DEFAULT 1,
         ancestors JSONB NOT NULL DEFAULT '[]'::jsonb
       )`,
    );
    await this.pool.query(
      `INSERT INTO debug_state (id, ancestors) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET ancestors = EXCLUDED.ancestors`,
      [JSON.stringify(ancestors)],
    );
  }

  async getDebugAncestors(): Promise<Array<{ uri: string; createdAt: number }>> {
    try {
      const r = await this.pool.query<{ ancestors: Array<{ uri: string; createdAt: number }> }>(
        "SELECT ancestors FROM debug_state WHERE id = 1",
      );
      return r.rows[0]?.ancestors ?? [];
    } catch {
      return [];
    }
  }

  async insertDraft(draft: Draft): Promise<number> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO drafts (format, body, title, evidence, status)
       VALUES ($1, $2, $3, $4::jsonb, 'draft')
       RETURNING id`,
      [draft.format, draft.body, draft.title ?? null, JSON.stringify(draft.evidence)],
    );
    return Number(r.rows[0].id);
  }

  async getDraft(id: number): Promise<DraftRow | null> {
    const r = await this.pool.query(DRAFT_SELECT + " WHERE id = $1", [id]);
    return r.rows[0] ? mapDraftRow(r.rows[0]) : null;
  }

  async listDrafts(status?: DraftStatus): Promise<DraftRow[]> {
    const r = status
      ? await this.pool.query(DRAFT_SELECT + " WHERE status = $1 ORDER BY id DESC", [status])
      : await this.pool.query(DRAFT_SELECT + " ORDER BY id DESC LIMIT 200");
    return r.rows.map(mapDraftRow);
  }

  async countApprovedProactiveToday(): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM drafts
       WHERE status IN ('approved', 'published', 'declined')
         AND (decided_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date`,
    );
    return r.rows[0]?.n ?? 0;
  }

  async publishRequestIdForMention(mentionKey: string, client?: Queryable): Promise<number | null> {
    const exec = client ?? this.pool;
    const r = await exec.query<{ id: string }>(
      `SELECT id FROM publish_requests WHERE mention_key = $1 ORDER BY id DESC LIMIT 1`,
      [mentionKey],
    );
    return r.rows[0] ? Number(r.rows[0].id) : null;
  }

  async approveDraft(opts: {
    id: number;
    decidedBy: string;
    maxPerDay: number;
    enqueue: (
      client: Queryable,
      locked: DraftRow,
    ) => Promise<{ mentionKey: string; postId: string; inserted: boolean }>;
  }): Promise<{ draft: DraftRow; publishRequestId: number; mentionKey: string; postId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Cap is configurable (JEB_PROACTIVE_MAX_PER_DAY >= 1), so serialize
      // concurrent approves with a transaction advisory lock rather than a
      // unique index on proactive_utc_day (that would force the cap to 1).
      await client.query("SELECT pg_advisory_xact_lock($1)", [JEB_PROACTIVE_CAP_LOCK]);
      const locked = await client.query(DRAFT_SELECT + " WHERE id = $1 FOR UPDATE", [opts.id]);
      if (!locked.rows[0]) {
        await client.query("ROLLBACK");
        throw new Error(`draft ${opts.id} not found`);
      }
      const current = mapDraftRow(locked.rows[0]);
      if (current.status !== "draft") {
        await client.query("ROLLBACK");
        throw new Error(`draft ${opts.id} is ${current.status}, not draft`);
      }
      const capRow = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM drafts
         WHERE status IN ('approved', 'published', 'declined')
           AND (decided_at AT TIME ZONE 'utc')::date = (now() AT TIME ZONE 'utc')::date`,
      );
      const today = capRow.rows[0]?.n ?? 0;
      if (today >= opts.maxPerDay) {
        await client.query("ROLLBACK");
        throw new Error(`proactive daily cap reached (${opts.maxPerDay} approved per UTC day)`);
      }
      const queued = await opts.enqueue(client, current);
      const publishRequestId = await this.publishRequestIdForMention(queued.mentionKey, client);
      if (publishRequestId === null) {
        await client.query("ROLLBACK");
        throw new Error("standalone publish request not inserted");
      }
      if (queued.inserted === false) {
        await client.query("ROLLBACK");
        throw new Error(`identical content already queued/published as request #${publishRequestId}`);
      }
      const updated = await client.query(
        `UPDATE drafts SET
           status = 'approved',
           decided_at = now(),
           decided_by = $2,
           publish_request_id = $3,
           proactive_utc_day = (timezone('utc', now()))::date
         WHERE id = $1
         RETURNING *`,
        [opts.id, opts.decidedBy, publishRequestId],
      );
      await client.query("COMMIT");
      return {
        draft: mapDraftRow(updated.rows[0]),
        publishRequestId,
        mentionKey: queued.mentionKey,
        postId: queued.postId,
      };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async rejectDraft(id: number, decidedBy: string, reason: string): Promise<DraftRow> {
    const r = await this.pool.query(
      `UPDATE drafts SET status = 'rejected', decided_at = now(), decided_by = $2, reject_reason = $3
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [id, decidedBy, reason],
    );
    if (!r.rows[0]) throw new Error(`draft ${id} not found or not in draft status`);
    return mapDraftRow(r.rows[0]);
  }

  /**
   * Publisher hook only: a draft may become published after it is already
   * approved with a non-empty decided_by. There is no generate/cron path here.
   */
  async markDraftPublished(id: number): Promise<void> {
    const r = await this.pool.query(
      `UPDATE drafts SET status = 'published'
       WHERE id = $1 AND status = 'approved' AND decided_by IS NOT NULL AND decided_by <> ''
       RETURNING id`,
      [id],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new Error(`draft ${id} cannot be published without an approved row with decided_by`);
    }
  }

  /** Publisher hook: mark the draft linked to this publish_requests id, if any. */
  async markLinkedDraftPublished(publishRequestId: number): Promise<void> {
    await this.pool.query(
      `UPDATE drafts SET status = 'published'
       WHERE publish_request_id = $1 AND status = 'approved' AND decided_by IS NOT NULL AND decided_by <> ''`,
      [publishRequestId],
    );
  }

  /**
   * Publisher hook: standalone row was replaced by the outbound decline.
   * The approved content never appeared; do not count as published.
   */
  async markLinkedDraftDeclined(publishRequestId: number): Promise<void> {
    await this.pool.query(
      `UPDATE drafts SET status = 'declined'
       WHERE publish_request_id = $1 AND status = 'approved' AND decided_by IS NOT NULL AND decided_by <> ''`,
      [publishRequestId],
    );
  }

  async draftCountsByFormat(): Promise<
    Array<{
      format: DraftFormat;
      generated: number;
      approved: number;
      rejected: number;
      published: number;
      declined: number;
    }>
  > {
    const r = await this.pool.query<{
      format: DraftFormat;
      generated: number;
      approved: number;
      rejected: number;
      published: number;
      declined: number;
    }>(
      `SELECT format,
              COUNT(*)::int AS generated,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status = 'published')::int AS published,
              COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
       FROM drafts
       GROUP BY format
       ORDER BY format`,
    );
    return r.rows;
  }

  async botRepliedTo(postUri: string): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM handled_mentions
         WHERE mention_key = $1 AND status = 'published' AND reply_uri IS NOT NULL
       ) AS ok`,
      [postUri],
    );
    return r.rows[0]?.ok === true;
  }

  async seedCollectionRules(
    rules: ReadonlyArray<{
      collection_key: string;
      title: string;
      description: string;
      match: { series?: string; self_tag?: string };
    }>,
  ): Promise<number> {
    let n = 0;
    for (const rule of rules) {
      await this.pool.query(
        `INSERT INTO collection_rules (collection_key, title, description, match_series, match_self_tag)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (collection_key) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           match_series = EXCLUDED.match_series,
           match_self_tag = EXCLUDED.match_self_tag`,
        [rule.collection_key, rule.title, rule.description, rule.match.series ?? null, rule.match.self_tag ?? null],
      );
      n += 1;
    }
    return n;
  }

  async listCollectionRules(): Promise<
    Array<{
      collection_key: string;
      title: string;
      description: string;
      match_series: string | null;
      match_self_tag: string | null;
    }>
  > {
    const r = await this.pool.query(
      `SELECT collection_key, title, description, match_series, match_self_tag FROM collection_rules ORDER BY collection_key`,
    );
    return r.rows.map((row) => ({
      collection_key: String(row.collection_key),
      title: String(row.title),
      description: String(row.description),
      match_series: row.match_series === null ? null : String(row.match_series),
      match_self_tag: row.match_self_tag === null ? null : String(row.match_self_tag),
    }));
  }

  async getCollectionRule(key: string): Promise<import("./bot-kit/collections/rules.js").CollectionRule | null> {
    const r = await this.pool.query(
      `SELECT collection_key, title, description, match_series, match_self_tag FROM collection_rules WHERE collection_key = $1`,
      [key],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      collection_key: String(row.collection_key),
      title: String(row.title),
      description: String(row.description),
      match: {
        ...(row.match_series ? { series: String(row.match_series) } : {}),
        ...(row.match_self_tag ? { self_tag: String(row.match_self_tag) } : {}),
      },
    };
  }

  async latestCollectionRequest(key: string): Promise<{ status: string; replace_post_id: string | null } | null> {
    const rule = await this.getCollectionRule(key);
    if (!rule) return null;
    const r = await this.pool.query(
      `SELECT status, replace_post_id FROM publish_requests
       WHERE mention_key = $1
       ORDER BY id DESC LIMIT 1`,
      [collectionMentionKey(rule.title)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: String(row.status),
      replace_post_id: row.replace_post_id === null ? null : String(row.replace_post_id),
    };
  }

  async listCollectionItemUris(key: string): Promise<string[]> {
    const r = await this.pool.query<{ post_uri: string }>(
      `SELECT post_uri FROM collection_items WHERE collection_key = $1 ORDER BY position, added_at`,
      [key],
    );
    return r.rows.map((row) => row.post_uri);
  }

  async replaceCollectionItems(key: string, uris: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM collection_items WHERE collection_key = $1`, [key]);
      for (let i = 0; i < uris.length; i++) {
        await client.query(
          `INSERT INTO collection_items (collection_key, post_uri, position) VALUES ($1, $2, $3)`,
          [key, uris[i], i],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async upsertPublished(row: {
    uri: string;
    postId: string;
    kind: "short" | "long";
    content: string;
    selfTags: string[];
    series: string | null;
    publishRequestId: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO published (uri, post_id, kind, content, self_tags, series, publish_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (uri) DO UPDATE SET
         post_id = EXCLUDED.post_id,
         kind = EXCLUDED.kind,
         content = EXCLUDED.content,
         self_tags = EXCLUDED.self_tags,
         series = EXCLUDED.series,
         publish_request_id = EXCLUDED.publish_request_id,
         published_at = now()`,
      [row.uri, row.postId, row.kind, row.content, row.selfTags, row.series, row.publishRequestId],
    );
  }

  async listPublished(): Promise<
    Array<{ uri: string; kind: "short" | "long"; self_tags: string[]; series: string | null }>
  > {
    const r = await this.pool.query(
      `SELECT uri, kind, self_tags, series FROM published ORDER BY published_at, uri`,
    );
    return r.rows.map((row) => ({
      uri: String(row.uri),
      kind: row.kind === "long" ? "long" : "short",
      self_tags: Array.isArray(row.self_tags) ? row.self_tags.map(String) : [],
      series: row.series === null ? null : String(row.series),
    }));
  }

  async updateDraftContent(id: number, draft: Draft): Promise<DraftRow> {
    const r = await this.pool.query(
      `UPDATE drafts SET body = $2, title = $3, evidence = $4::jsonb
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [id, draft.body, draft.title ?? null, JSON.stringify(draft.evidence)],
    );
    if (!r.rows[0]) throw new Error(`draft ${id} not found or not in draft status`);
    return mapDraftRow(r.rows[0]);
  }
}

const DRAFT_SELECT = `SELECT id, format, body, title, evidence, status, created_at, decided_at, decided_by, reject_reason, publish_request_id, proactive_utc_day FROM drafts`;

function mapDraftRow(row: {
  id: string | number;
  format: string;
  body: string;
  title: string | null;
  evidence: DraftEvidence;
  status: DraftStatus;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  reject_reason: string | null;
  publish_request_id: string | number | null;
  proactive_utc_day: Date | string | null;
}): DraftRow {
  const day = row.proactive_utc_day;
  return {
    id: Number(row.id),
    format: row.format as DraftFormat,
    body: row.body,
    title: row.title,
    evidence: row.evidence,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    reject_reason: row.reject_reason,
    publish_request_id: row.publish_request_id === null ? null : Number(row.publish_request_id),
    proactive_utc_day: day instanceof Date ? day.toISOString().slice(0, 10) : day,
  };
}
