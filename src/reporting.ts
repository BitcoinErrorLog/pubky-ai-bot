import type pg from "pg";
import { ALL_SWITCHES, envSwitchOn, type SwitchName } from "./switches.js";

export interface DashboardWindow {
  since: Date;
  label: string;
}

export interface CountByReason {
  reason: string;
  count: number;
}

export interface AskerCount {
  author: string;
  count: number;
}

export interface TokenByModel {
  model: string;
  totalTokens: number;
}

export interface TokenByDay {
  day: string;
  totalTokens: number;
}

export interface TokenSpender {
  publicKey: string;
  totalTokens: number;
}

export interface SwitchRow {
  name: string;
  on: boolean;
  envOn: boolean;
}

export interface CorrectionRow {
  id: number;
  reply_uri: string;
  mention_key: string;
  reason: string;
  corrected_by: string;
  correct_answer: string | null;
  created_at: Date;
  exported_at: Date | null;
}

export interface KillSwitchState {
  killSwitchDisabled: boolean;
  envDisabled: boolean;
  envGlobal: boolean;
  switches: SwitchRow[];
}

export interface ToolUsageCount {
  tool: string;
  count: number;
}

export interface DashboardFacts {
  window: DashboardWindow;
  mentionsReceived: number;
  published: number;
  skippedByReason: CountByReason[];
  failed: number;
  fallbackByReason: CountByReason[];
  /**
   * Latency from `handled_mentions.created_at` (ingest claim / first index
   * in this database) to `publish_requests.updated_at` on a `published` row.
   * Mentions published without a publish_requests row are omitted.
   */
  latencyMs: { p50: number | null; p95: number | null; sampleSize: number };
  toolUsage: ToolUsageCount[];
  scoutFailures: number;
  webSearchFailures: number;
  tokenByModel: TokenByModel[];
  tokenByDay: TokenByDay[];
  dailyTokenBudget: number;
  userDailyTokenBudget: number;
  todayGlobalTokens: number;
  topSpendersToday: TokenSpender[];
  /**
   * No `security_event` table or marker exists. This is the count of
   * evidence rows with intent `decline` in the window.
   */
  securityDeclinedReplies: number;
  securityNote: string;
  killSwitch: KillSwitchState;
  topAskers: AskerCount[];
  corrections: CorrectionRow[];
}

function n(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function mentionFilter(alias: string, keys: string[] | undefined, params: unknown[]): string {
  if (!keys?.length) return "";
  params.push(keys);
  return ` AND ${alias}mention_key = ANY($${params.length}::text[])`;
}

export interface DashboardScope {
  mentionKeys?: string[];
  userDailyTokenBudget?: number;
}

export async function loadMentionCounts(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<{ received: number; published: number; failed: number }> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM handled_mentions
     WHERE created_at >= $1${extra} GROUP BY status`,
    params,
  );
  let received = 0;
  let published = 0;
  let failed = 0;
  for (const row of r.rows) {
    const c = n(row.n);
    received += c;
    if (row.status === "published") published = c;
    if (row.status === "failed") failed = c;
  }
  return { received, published, failed };
}

export async function loadSkippedByReason(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<CountByReason[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ reason: string | null; n: string }>(
    `SELECT COALESCE(skip_reason, '(unset)') AS reason, COUNT(*)::text AS n
     FROM handled_mentions
     WHERE created_at >= $1 AND status = 'skipped'${extra}
     GROUP BY 1 ORDER BY n DESC, reason`,
    params,
  );
  return r.rows.map((row) => ({ reason: row.reason ?? "(unset)", count: n(row.n) }));
}

export async function loadFallbackByReason(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<CountByReason[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ reason: string; n: string }>(
    `SELECT fallback_reason AS reason, COUNT(*)::text AS n
     FROM handled_mentions
     WHERE created_at >= $1 AND fallback_reason IS NOT NULL${extra}
     GROUP BY 1 ORDER BY n DESC, reason`,
    params,
  );
  return r.rows.map((row) => ({ reason: row.reason, count: n(row.n) }));
}

export async function loadReplyLatency(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<{ p50: number | null; p95: number | null; sampleSize: number }> {
  const params: unknown[] = [since];
  const extra = mentionFilter("h.", mentionKeys, params);
  const r = await pool.query<{ p50: string | null; p95: string | null; n: string }>(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.updated_at - h.created_at)) * 1000)::text AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.updated_at - h.created_at)) * 1000)::text AS p95,
       COUNT(*)::text AS n
     FROM handled_mentions h
     JOIN publish_requests p ON p.mention_key = h.mention_key AND p.status = 'published'
     WHERE h.created_at >= $1 AND h.status = 'published'${extra}`,
    params,
  );
  const row = r.rows[0];
  const sampleSize = n(row?.n);
  if (!row || sampleSize === 0) return { p50: null, p95: null, sampleSize: 0 };
  return {
    p50: row.p50 === null ? null : n(row.p50),
    p95: row.p95 === null ? null : n(row.p95),
    sampleSize,
  };
}

function toolNameFromTraceItem(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const rec = item as Record<string, unknown>;
  const calls = rec.toolCalls;
  if (!Array.isArray(calls)) return [];
  const names: string[] = [];
  for (const c of calls) {
    if (!c || typeof c !== "object") continue;
    const name = (c as { name?: unknown }).name;
    if (typeof name === "string" && name.length) names.push(name);
  }
  return names;
}

export async function loadToolUsageFromEvidence(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<ToolUsageCount[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("h.", mentionKeys, params);
  const r = await pool.query<{ tool_trace: unknown }>(
    `SELECT e.tool_trace FROM evidence e
     JOIN handled_mentions h ON h.mention_key = e.mention_key
     WHERE h.created_at >= $1${extra}`,
    params,
  );
  const counts = new Map<string, number>();
  for (const row of r.rows) {
    const trace = row.tool_trace;
    if (!Array.isArray(trace)) continue;
    for (const item of trace) {
      for (const name of toolNameFromTraceItem(item)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

export async function loadScoutFailures(pool: pg.Pool, since: Date, mentionKeys?: string[]): Promise<number> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM scout_queries WHERE created_at >= $1 AND ok = FALSE${extra}`,
    params,
  );
  return n(r.rows[0]?.n);
}

export async function loadWebSearchFailures(pool: pg.Pool, since: Date, mentionKeys?: string[]): Promise<number> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM web_queries WHERE created_at >= $1 AND ok = FALSE${extra}`,
    params,
  );
  return n(r.rows[0]?.n);
}

export async function loadTokenByModel(pool: pg.Pool, since: Date, mentionKeys?: string[]): Promise<TokenByModel[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ model: string | null; total: string }>(
    `SELECT COALESCE(model, '(unknown)') AS model, COALESCE(SUM(total_tokens), 0)::text AS total
     FROM token_usage WHERE created_at >= $1${extra}
     GROUP BY 1 ORDER BY SUM(total_tokens) DESC NULLS LAST, model`,
    params,
  );
  return r.rows.map((row) => ({ model: row.model ?? "(unknown)", totalTokens: n(row.total) }));
}

export async function loadTokenByDay(pool: pg.Pool, since: Date, mentionKeys?: string[]): Promise<TokenByDay[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ day: Date; total: string }>(
    `SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(total_tokens), 0)::text AS total
     FROM token_usage WHERE created_at >= $1${extra}
     GROUP BY 1 ORDER BY 1`,
    params,
  );
  return r.rows.map((row) => ({
    day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
    totalTokens: n(row.total),
  }));
}

export async function loadDeclinedEvidence(pool: pg.Pool, since: Date, mentionKeys?: string[]): Promise<number> {
  const params: unknown[] = [since];
  const extra = mentionFilter("h.", mentionKeys, params);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM evidence e
     JOIN handled_mentions h ON h.mention_key = e.mention_key
     WHERE h.created_at >= $1 AND e.intent = 'decline'${extra}`,
    params,
  );
  return n(r.rows[0]?.n);
}

export async function loadKillSwitchState(pool: pg.Pool): Promise<KillSwitchState> {
  const kill = await pool.query<{ disabled: boolean }>("SELECT disabled FROM kill_switch WHERE id = 1");
  const sw = await pool.query<{ name: string; on_flag: boolean }>("SELECT name, on_flag FROM switches");
  const byName = new Map(sw.rows.map((row) => [row.name, row.on_flag === true]));
  const switches: SwitchRow[] = ALL_SWITCHES.map((name: SwitchName) => ({
    name,
    on: byName.get(name) === true,
    envOn: envSwitchOn(name),
  }));
  switches.unshift({
    name: "global",
    on: byName.get("global") === true,
    envOn: envSwitchOn("global"),
  });
  return {
    killSwitchDisabled: kill.rows[0]?.disabled === true,
    envDisabled: process.env.JEB_DISABLED === "1",
    envGlobal: process.env.JEB_SWITCH_GLOBAL === "1",
    switches,
  };
}

export async function loadTopAskers(
  pool: pg.Pool,
  since: Date,
  limit = 10,
  mentionKeys?: string[],
): Promise<AskerCount[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  params.push(limit);
  const r = await pool.query<{ author: string | null; n: string }>(
    `SELECT COALESCE(author, '(unknown)') AS author, COUNT(*)::text AS n
     FROM handled_mentions WHERE created_at >= $1${extra}
     GROUP BY 1 ORDER BY COUNT(*) DESC, author LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({ author: row.author ?? "(unknown)", count: n(row.n) }));
}

export async function loadCorrections(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<CorrectionRow[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{
    id: string;
    reply_uri: string;
    mention_key: string;
    reason: string;
    corrected_by: string;
    correct_answer: string | null;
    created_at: Date;
    exported_at: Date | null;
  }>(
    `SELECT id, reply_uri, mention_key, reason, corrected_by, correct_answer, created_at, exported_at
     FROM corrections WHERE created_at >= $1${extra} ORDER BY id`,
    params,
  );
  return r.rows.map((row) => ({
    id: n(row.id),
    reply_uri: row.reply_uri,
    mention_key: row.mention_key,
    reason: row.reason,
    corrected_by: row.corrected_by,
    correct_answer: row.correct_answer,
    created_at: row.created_at,
    exported_at: row.exported_at,
  }));
}

export async function loadTodayGlobalTokens(pool: pg.Pool, mentionKeys?: string[]): Promise<number> {
  const params: unknown[] = [];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(total_tokens), 0)::text AS total FROM token_usage
     WHERE created_at >= date_trunc('day', now())${extra}`,
    params,
  );
  return n(r.rows[0]?.total);
}

export async function loadTopSpendersToday(
  pool: pg.Pool,
  limit = 10,
  mentionKeys?: string[],
): Promise<TokenSpender[]> {
  const params: unknown[] = [];
  const extra = mentionFilter("", mentionKeys, params);
  params.push(limit);
  const r = await pool.query<{ public_key: string; total: string }>(
    `SELECT public_key, COALESCE(SUM(total_tokens), 0)::text AS total FROM token_usage
     WHERE created_at >= date_trunc('day', now())${extra}
     GROUP BY 1 ORDER BY SUM(total_tokens) DESC NULLS LAST, public_key LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({ publicKey: row.public_key, totalTokens: n(row.total) }));
}

export async function collectDashboardFacts(
  pool: pg.Pool,
  window: DashboardWindow,
  dailyTokenBudget: number,
  scope: DashboardScope = {},
): Promise<DashboardFacts> {
  const since = window.since;
  const keys = scope.mentionKeys;
  const [counts, skippedByReason, fallbackByReason, latencyMs, toolUsage, scoutFailures, webSearchFailures, tokenByModel, tokenByDay, securityDeclinedReplies, killSwitch, topAskers, corrections, todayGlobalTokens, topSpendersToday] =
    await Promise.all([
      loadMentionCounts(pool, since, keys),
      loadSkippedByReason(pool, since, keys),
      loadFallbackByReason(pool, since, keys),
      loadReplyLatency(pool, since, keys),
      loadToolUsageFromEvidence(pool, since, keys),
      loadScoutFailures(pool, since, keys),
      loadWebSearchFailures(pool, since, keys),
      loadTokenByModel(pool, since, keys),
      loadTokenByDay(pool, since, keys),
      loadDeclinedEvidence(pool, since, keys),
      loadKillSwitchState(pool),
      loadTopAskers(pool, since, 10, keys),
      loadCorrections(pool, since, keys),
      loadTodayGlobalTokens(pool, keys),
      loadTopSpendersToday(pool, 10, keys),
    ]);
  return {
    window,
    mentionsReceived: counts.received,
    published: counts.published,
    skippedByReason,
    failed: counts.failed,
    fallbackByReason,
    latencyMs,
    toolUsage,
    scoutFailures,
    webSearchFailures,
    tokenByModel,
    tokenByDay,
    dailyTokenBudget,
    userDailyTokenBudget: scope.userDailyTokenBudget ?? 600_000,
    todayGlobalTokens,
    topSpendersToday,
    securityDeclinedReplies,
    securityNote:
      "No security_event marker exists. Count is evidence.intent = 'decline' for mentions in the window.",
    killSwitch,
    topAskers,
    corrections,
  };
}
