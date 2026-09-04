import type pg from "pg";
import { SCOUT_TOOLS } from "./intent.js";

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

export interface WindowCounts {
  publishedAnswers: number;
  acceptedMentions: number;
  corrections: number;
  uniqueInvokers: number;
  uniquePublishedAuthors: number;
  repeatAuthors: number;
}

export interface CorrectionLoopWindow {
  days: 7 | 30;
  publishedAnswers: number;
  acceptedMentions: number;
  corrections: number;
  correctionRate: number | null;
  uniqueInvokers: number;
  repeatAuthors: number;
  repeatRate: number | null;
  successfulAnswerRate: number | null;
}

export interface IntentCount {
  intent: string;
  count: number;
}

export interface ScoutToolCount {
  tool: string;
  count: number;
}

export interface TokenCostRow {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** USD = (input × inPrice + output × outPrice) / 1e6. Unsplit totals are priced as output (upper bound). */
export function tokensToUsd(
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  priceIn: number,
  priceOut: number,
): number {
  const inTok = inputTokens;
  const outTok = outputTokens;
  if (inTok > 0 || outTok > 0) {
    return (inTok * priceIn + outTok * priceOut) / 1_000_000;
  }
  return (totalTokens * priceOut) / 1_000_000;
}

export async function loadWindowCounts(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<WindowCounts> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{
    published_answers: string;
    accepted: string;
    corrections: string;
    unique_invokers: string;
    unique_published_authors: string;
    repeat_authors: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM handled_mentions
        WHERE created_at >= $1 AND status = 'published' AND skip_reason IS NULL AND reply_uri IS NOT NULL${extra}) AS published_answers,
       (SELECT COUNT(*)::text FROM handled_mentions
        WHERE created_at >= $1 AND status <> 'skipped'${extra}) AS accepted,
       (SELECT COUNT(*)::text FROM corrections WHERE created_at >= $1${extra}) AS corrections,
       (SELECT COUNT(DISTINCT author)::text FROM handled_mentions
        WHERE created_at >= $1 AND status <> 'skipped'${extra}) AS unique_invokers,
       (SELECT COUNT(DISTINCT author)::text FROM handled_mentions
        WHERE created_at >= $1 AND status = 'published' AND skip_reason IS NULL AND reply_uri IS NOT NULL${extra}) AS unique_published_authors,
       (SELECT COUNT(*)::text FROM (
          SELECT author FROM handled_mentions
          WHERE created_at >= $1 AND status = 'published' AND skip_reason IS NULL AND reply_uri IS NOT NULL${extra}
          GROUP BY author HAVING COUNT(*) >= 2
        ) r) AS repeat_authors`,
    params,
  );
  const row = r.rows[0];
  return {
    publishedAnswers: n(row?.published_answers),
    acceptedMentions: n(row?.accepted),
    corrections: n(row?.corrections),
    uniqueInvokers: n(row?.unique_invokers),
    uniquePublishedAuthors: n(row?.unique_published_authors),
    repeatAuthors: n(row?.repeat_authors),
  };
}

export function ratesFromCounts(counts: WindowCounts, days: 7 | 30): CorrectionLoopWindow {
  const correctionRate =
    counts.publishedAnswers === 0 ? null : counts.corrections / counts.publishedAnswers;
  const repeatRate =
    counts.uniquePublishedAuthors === 0 ? null : counts.repeatAuthors / counts.uniquePublishedAuthors;
  const successfulAnswerRate =
    counts.acceptedMentions === 0 ? null : counts.publishedAnswers / counts.acceptedMentions;
  return {
    days,
    publishedAnswers: counts.publishedAnswers,
    acceptedMentions: counts.acceptedMentions,
    corrections: counts.corrections,
    correctionRate,
    uniqueInvokers: counts.uniqueInvokers,
    repeatAuthors: counts.repeatAuthors,
    repeatRate,
    successfulAnswerRate,
  };
}

export async function loadIntentCounts(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<IntentCount[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("h.", mentionKeys, params);
  const r = await pool.query<{ intent: string; n: string }>(
    `SELECT COALESCE(e.intent, '(unset)') AS intent, COUNT(*)::text AS n
     FROM evidence e
     JOIN handled_mentions h ON h.mention_key = e.mention_key
     WHERE h.created_at >= $1${extra}
     GROUP BY 1 ORDER BY COUNT(*) DESC, intent`,
    params,
  );
  return r.rows.map((row) => ({ intent: row.intent, count: n(row.n) }));
}

export async function loadScoutToolCounts(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<ScoutToolCount[]> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ tool: string; n: string }>(
    `SELECT tool, COUNT(*)::text AS n FROM scout_queries
     WHERE created_at >= $1${extra}
     GROUP BY 1 ORDER BY COUNT(*) DESC, tool`,
    params,
  );
  const fromTable = r.rows.map((row) => ({ tool: row.tool, count: n(row.n) }));
  if (fromTable.length) return fromTable;
  return [];
}

export function filterScoutToolsFromTrace(toolUsage: { tool: string; count: number }[]): ScoutToolCount[] {
  const allowed = new Set<string>(SCOUT_TOOLS);
  return toolUsage.filter((t) => allowed.has(t.tool)).map((t) => ({ tool: t.tool, count: t.count }));
}

export async function loadEvidenceLatency(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<{ p50: number | null; p95: number | null; sampleSize: number }> {
  const params: unknown[] = [since];
  const extra = mentionFilter("h.", mentionKeys, params);
  const r = await pool.query<{ p50: string | null; p95: string | null; n: string }>(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY e.latency_ms)::text AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY e.latency_ms)::text AS p95,
       COUNT(*)::text AS n
     FROM evidence e
     JOIN handled_mentions h ON h.mention_key = e.mention_key
     WHERE h.created_at >= $1 AND h.status = 'published' AND h.skip_reason IS NULL
       AND e.latency_ms IS NOT NULL${extra}`,
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

export async function loadTokenCostTotals(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<TokenCostRow> {
  const params: unknown[] = [since];
  const extra = mentionFilter("", mentionKeys, params);
  const r = await pool.query<{ inp: string; outp: string; tot: string }>(
    `SELECT COALESCE(SUM(input_tokens), 0)::text AS inp,
            COALESCE(SUM(output_tokens), 0)::text AS outp,
            COALESCE(SUM(total_tokens), 0)::text AS tot
     FROM token_usage WHERE created_at >= $1${extra}`,
    params,
  );
  const row = r.rows[0];
  return { inputTokens: n(row?.inp), outputTokens: n(row?.outp), totalTokens: n(row?.tot) };
}

export async function loadRepeatUserTokenTotals(
  pool: pg.Pool,
  since: Date,
  mentionKeys?: string[],
): Promise<TokenCostRow & { repeatUsers: number }> {
  const params: unknown[] = [since];
  const extraH = mentionFilter("h.", mentionKeys, params);
  const extraT = mentionKeys?.length ? mentionFilter("", mentionKeys, params) : "";
  const r = await pool.query<{ inp: string; outp: string; tot: string; users: string }>(
    `WITH repeat AS (
       SELECT author FROM handled_mentions h
       WHERE h.created_at >= $1 AND h.status = 'published' AND h.skip_reason IS NULL AND h.reply_uri IS NOT NULL${extraH}
       GROUP BY author HAVING COUNT(*) >= 2
     )
     SELECT COALESCE(SUM(t.input_tokens), 0)::text AS inp,
            COALESCE(SUM(t.output_tokens), 0)::text AS outp,
            COALESCE(SUM(t.total_tokens), 0)::text AS tot,
            (SELECT COUNT(*)::text FROM repeat) AS users
     FROM token_usage t
     JOIN repeat r ON r.author = t.public_key
     WHERE t.created_at >= $1${extraT}`,
    params,
  );
  const row = r.rows[0];
  return {
    inputTokens: n(row?.inp),
    outputTokens: n(row?.outp),
    totalTokens: n(row?.tot),
    repeatUsers: n(row?.users),
  };
}
