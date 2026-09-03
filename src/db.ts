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

  async get(mentionKey: string): Promise<{
    status: MentionStatus;
    reply_uri: string | null;
    root_uri: string | null;
    updated_at: Date;
    author: string | null;
  } | null> {
    const r = await this.pool.query(
      `SELECT status, reply_uri, root_uri, updated_at, author FROM handled_mentions WHERE mention_key = $1`,
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
    };
  }

  async mark(mentionKey: string, status: MentionStatus, extra?: { replyUri?: string; rootUri?: string }): Promise<void> {
    await this.pool.query(
      `UPDATE handled_mentions SET status = $2, reply_uri = COALESCE($3, reply_uri),
       root_uri = COALESCE($4, root_uri), updated_at = now() WHERE mention_key = $1`,
      [mentionKey, status, extra?.replyUri ?? null, extra?.rootUri ?? null],
    );
  }

  async staleProcessing(olderThanMs: number): Promise<string[]> {
    const r = await this.pool.query<{ mention_key: string }>(
      `SELECT mention_key FROM handled_mentions
       WHERE status = 'processing' AND updated_at < now() - ($1::text || ' milliseconds')::interval`,
      [String(olderThanMs)],
    );
    return r.rows.map((x) => x.mention_key);
  }

  async publishedInThread(botId: string, rootUri: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM handled_mentions WHERE bot_id = $1 AND root_uri = $2 AND status = 'published'`,
      [botId, rootUri],
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

  async enqueueWork(mentionKey: string, author: string, kind: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO work_queue (mention_key, author, kind, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'queued')
       ON CONFLICT (mention_key) DO NOTHING`,
      [mentionKey, author, kind, JSON.stringify(payload)],
    );
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

  async insertEvidence(row: {
    mentionKey: string;
    intent: string;
    toolTrace: unknown;
    sources: unknown;
    model: string | null;
    tokens: number | null;
    latencyMs: number | null;
  }): Promise<number> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO evidence (mention_key, intent, tool_trace, sources, model, tokens, latency_ms)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) RETURNING id`,
      [
        row.mentionKey,
        row.intent,
        JSON.stringify(row.toolTrace),
        JSON.stringify(row.sources),
        row.model,
        row.tokens,
        row.latencyMs,
      ],
    );
    return Number(r.rows[0].id);
  }

  async insertPublishRequest(row: {
    mentionKey: string;
    parentUri: string;
    content: string;
    evidenceId: number | null;
    failFirstAttempt?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO publish_requests (mention_key, parent_uri, content, evidence_id, fail_first_attempt)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mention_key) DO NOTHING`,
      [row.mentionKey, row.parentUri, row.content, row.evidenceId, row.failFirstAttempt ?? false],
    );
  }

  async claimPublish(maxAttempts: number): Promise<{
    id: number;
    mention_key: string;
    parent_uri: string;
    content: string;
    evidence_id: number | null;
    attempts: number;
    fail_first_attempt: boolean;
  } | null> {
    const r = await this.pool.query(
      `UPDATE publish_requests SET status = 'publishing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM publish_requests
         WHERE status IN ('queued', 'retry') AND next_attempt_at <= now() AND attempts < $1
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id, mention_key, parent_uri, content, evidence_id, attempts, fail_first_attempt`,
      [maxAttempts],
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
    };
  }

  async markPublishDone(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE publish_requests SET status = 'published', updated_at = now() WHERE id = $1`,
      [id],
    );
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

  async auditRoute(mentionKey: string, intent: string): Promise<void> {
    await this.pool.query("INSERT INTO routing_audit (mention_key, intent) VALUES ($1, $2)", [mentionKey, intent]);
  }
}
