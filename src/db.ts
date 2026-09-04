import pg from "pg";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import type { SwitchName } from "./switches.js";
import { ALL_SWITCHES } from "./switches.js";

export type MentionStatus = "processing" | "published" | "failed" | "skipped";

export class Store {
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
    const r = await this.pool.query<{ disabled: boolean }>("SELECT disabled FROM kill_switch WHERE id = 1");
    return r.rows[0]?.disabled === true;
  }

  async switchOn(name: SwitchName): Promise<boolean> {
    if (await this.killSwitchOn()) return true;
    const g = await this.pool.query<{ on_flag: boolean }>("SELECT on_flag FROM switches WHERE name = 'global'");
    if (g.rows[0]?.on_flag === true) return true;
    const r = await this.pool.query<{ on_flag: boolean }>("SELECT on_flag FROM switches WHERE name = $1", [name]);
    return r.rows[0]?.on_flag === true;
  }

  async setSwitch(name: SwitchName | "global", on: boolean): Promise<void> {
    if (name === "global") {
      await this.pool.query(
        `INSERT INTO switches (name, on_flag) VALUES ('global', $1)
         ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
        [on],
      );
      for (const n of ALL_SWITCHES) {
        await this.pool.query(
          `INSERT INTO switches (name, on_flag) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
          [n, on],
        );
      }
      await this.pool.query("UPDATE kill_switch SET disabled = $1 WHERE id = 1", [on]);
      return;
    }
    await this.pool.query(
      `INSERT INTO switches (name, on_flag) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
      [name, on],
    );
    if (name === "consumption" || name === "generation" || name === "replies") {
      if (on) await this.pool.query("UPDATE kill_switch SET disabled = TRUE WHERE id = 1");
    }
  }

  async getCursor(botId: string, nexusUrl: string): Promise<{ lastTs: number; firstBootDone: boolean }> {
    const r = await this.pool.query(
      `INSERT INTO cursor_state (bot_id, nexus_url, last_ts, first_boot_done) VALUES ($1, $2, 0, FALSE)
       ON CONFLICT (bot_id, nexus_url) DO UPDATE SET bot_id = EXCLUDED.bot_id
       RETURNING last_ts, first_boot_done`,
      [botId, nexusUrl],
    );
    const row = r.rows[0] as { last_ts: string | number; first_boot_done: boolean };
    return { lastTs: Number(row.last_ts), firstBootDone: row.first_boot_done };
  }

  async setCursor(botId: string, nexusUrl: string, lastTs: number, firstBootDone: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO cursor_state (bot_id, nexus_url, last_ts, first_boot_done) VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_id, nexus_url) DO UPDATE SET last_ts = EXCLUDED.last_ts, first_boot_done = EXCLUDED.first_boot_done`,
      [botId, nexusUrl, lastTs, firstBootDone],
    );
  }

  async claim(mentionKey: string, author: string, botId: string): Promise<"claimed" | "exists"> {
    const r = await this.pool.query(
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
    const r = await this.pool.query(
      `SELECT status, reply_uri, root_uri, updated_at, author, skip_reason, fallback_reason, notice_suppressed, quota_notice FROM handled_mentions WHERE mention_key = $1`,
      [mentionKey],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: row.status as MentionStatus,
      reply_uri: row.reply_uri,
      root_uri: row.root_uri,
      updated_at: row.updated_at,
      author: row.author,
      skip_reason: row.skip_reason ?? null,
      fallback_reason: row.fallback_reason ?? null,
      notice_suppressed: row.notice_suppressed === true,
      quota_notice: row.quota_notice ?? null,
    };
  }

  async mark(
    mentionKey: string,
    status: MentionStatus,
    extra?: {
      replyUri?: string;
      rootUri?: string;
      skipReason?: string;
      fallbackReason?: string;
      noticeSuppressed?: boolean;
      quotaNotice?: string;
    },
  ): Promise<void> {
    await this.pool.query(
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
    const stale = `status = 'claimed' AND claimed_at < now() - ($1::text || ' milliseconds')::interval`;
    const failed = await this.pool.query<{ mention_key: string }>(
      `UPDATE work_queue SET status = 'failed'
       WHERE ${stale} AND attempts >= $2
       RETURNING mention_key`,
      [String(staleMs), maxAttempts],
    );
    // Do not mark the mention failed: the reason tick inserts a fallback reply
    // so a policy-passed mention never ends with zero published answers.
    const requeued = await this.pool.query(
      `UPDATE work_queue SET status = 'queued', attempts = attempts + 1, claimed_at = NULL
       WHERE ${stale} AND attempts < $2`,
      [String(staleMs), maxAttempts],
    );
    return {
      requeued: requeued.rowCount ?? 0,
      failed: failed.rows.length,
      exhaustedKeys: failed.rows.map((r) => r.mention_key),
    };
  }

  /**
   * R-01(b): fail `handled_mentions` rows stuck in `processing` with no
   * active work row and no active publish request past the same window
   * (e.g. a crash between the ingest claim and the enqueue). Runs after
   * reapStaleWork in the reason tick, so a requeued row still protects its
   * mention while a terminally failed one does not.
   */
  async listStaleProcessingMentions(staleMs: number): Promise<string[]> {
    const r = await this.pool.query<{ mention_key: string }>(
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
    return r.rows.map((row) => row.mention_key);
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
    const r = await this.pool.query(
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

  async hasActivePublish(mentionKey: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM publish_requests
       WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')
       LIMIT 1`,
      [mentionKey],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Returns true when a new queued row was inserted. */
  async enqueueWork(mentionKey: string, author: string, kind: string, payload: unknown): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO work_queue (mention_key, author, kind, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'queued')
       ON CONFLICT (mention_key) WHERE status IN ('queued', 'claimed') DO NOTHING
       RETURNING id`,
      [mentionKey, author, kind, JSON.stringify(payload)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async claimWork(): Promise<{
    id: number;
    mention_key: string;
    author: string;
    kind: string;
    payload: unknown;
  } | null> {
    const r = await this.pool.query(
      `UPDATE work_queue SET status = 'claimed', claimed_at = now()
       WHERE id = (
         SELECT id FROM work_queue WHERE status = 'queued' ORDER BY id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, mention_key, author, kind, payload`,
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      mention_key: row.mention_key,
      author: row.author,
      kind: row.kind,
      payload: row.payload,
    };
  }

  async finishWork(id: number, status: "done" | "failed"): Promise<void> {
    await this.pool.query("UPDATE work_queue SET status = $2 WHERE id = $1", [id, status]);
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
  }): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO publish_requests (mention_key, parent_uri, content, evidence_id, fail_first_attempt, categories)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (mention_key) WHERE status IN ('queued', 'retry', 'publishing', 'published') DO NOTHING
       RETURNING id`,
      [
        row.mentionKey,
        row.parentUri,
        row.content,
        row.evidenceId,
        row.failFirstAttempt ?? false,
        JSON.stringify(row.categories ?? []),
      ],
    );
    return (r.rowCount ?? 0) > 0;
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
  } | null> {
    const r = await this.pool.query(
      `UPDATE publish_requests SET status = 'publishing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM publish_requests
         WHERE attempts < $1 AND (
           (status IN ('queued', 'retry') AND next_attempt_at <= now())
           OR (status = 'publishing' AND updated_at < now() - ($2::text || ' milliseconds')::interval)
         )
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, mention_key, parent_uri, content, evidence_id, attempts, fail_first_attempt, scrubbed`,
      [maxAttempts, String(staleMs)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      mention_key: row.mention_key,
      parent_uri: row.parent_uri,
      content: row.content,
      evidence_id: row.evidence_id === null ? null : Number(row.evidence_id),
      attempts: Number(row.attempts),
      fail_first_attempt: row.fail_first_attempt === true,
      scrubbed: row.scrubbed === true,
    };
  }

  /**
   * Terminal state for rows that exhausted their attempts. `publishing` rows
   * are only touched once they are also stale (an in-flight claim by another
   * publisher process is never failed underneath it).
   */
  async failExhaustedPublishes(maxAttempts: number, staleMs = 120_000): Promise<number> {
    const r = await this.pool.query(
      `UPDATE publish_requests SET status = 'failed', updated_at = now()
       WHERE attempts >= $1 AND (
         status = 'retry'
         OR (status = 'publishing' AND updated_at < now() - ($2::text || ' milliseconds')::interval)
       )`,
      [maxAttempts, String(staleMs)],
    );
    return r.rowCount ?? 0;
  }

  async markPublishDone(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE publish_requests SET status = 'published', updated_at = now() WHERE id = $1`,
      [id],
    );
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
    await this.pool.query(`UPDATE publish_requests SET scrubbed = TRUE, updated_at = now() WHERE id = $1`, [id]);
  }

  /** Replaces the queued self-tag categories (scrub gate downgrades to ["declined"]). */
  async setPublishCategories(id: number, categories: string[]): Promise<void> {
    await this.pool.query(`UPDATE publish_requests SET categories = $2::jsonb, updated_at = now() WHERE id = $1`, [
      id,
      JSON.stringify(categories),
    ]);
  }

  async markPublishRetry(id: number, err: string, attempts: number): Promise<void> {
    const backoffMs = Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(
      `UPDATE publish_requests SET status = 'retry', last_error = $2,
       next_attempt_at = now() + ($3::text || ' milliseconds')::interval, updated_at = now() WHERE id = $1`,
      [id, err.slice(0, 500), String(backoffMs)],
    );
  }

  async clearFailFirst(id: number): Promise<void> {
    await this.pool.query("UPDATE publish_requests SET fail_first_attempt = FALSE WHERE id = $1", [id]);
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
    const r = await this.pool.query<{
      id: string;
      mention_key: string;
      reply_uri: string;
      categories: unknown;
    }>(
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
      mention_key: row.mention_key,
      reply_uri: row.reply_uri,
      categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    };
  }

  async markTagsDone(id: number, tagUris: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE publish_requests SET tag_uris = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(tagUris)],
    );
  }

  async markTagRetry(id: number, err: string): Promise<void> {
    await this.pool.query(
      `UPDATE publish_requests SET tag_attempts = tag_attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
      [id, err.slice(0, 500)],
    );
  }

  async markPublishFailedAuth(id: number, err: string): Promise<void> {
    await this.pool.query(
      `UPDATE publish_requests SET status = 'failed_auth', last_error = $2, updated_at = now() WHERE id = $1`,
      [id, err.slice(0, 500)],
    );
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
}
