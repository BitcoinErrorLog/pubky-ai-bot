import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { fetchJson, postJson } from "../http.js";
import type { ScoutClientConfig } from "./scout-config.js";
import { scoutEnvelopeSchema, scoutErrorSchema, type ScoutEnvelope } from "./types.js";
import { noteScoutOutcome, scoutBreakerBlocked } from "./circuit.js";
import { TokenBucket, scoutBucketCapacity } from "./limiter.js";

const PUBLIC_SCOUT_CODES = new Set([
  "BUDGET",
  "SCOUT_BACKOFF",
  "RATE_LIMITED",
  "SWITCH",
  "DISABLED",
  "QUERY_REJECTED",
  "QUERY_TIMEOUT",
  "SHAPE_ERROR",
  "INTERNAL_ERROR",
  "SCHEMA_ERROR",
  "upstream_error",
]);

/** Static public code. Raw upstream strings stay in scout_queries.error_code only. */
export function publicScoutErrorCode(code: string): string {
  if (PUBLIC_SCOUT_CODES.has(code)) return code;
  if (code.startsWith("SCHEMA_")) return "SCHEMA_ERROR";
  return "upstream_error";
}

export class ScoutToolError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "ScoutToolError";
  }

  toPublic(): { error: string; message: string; hint?: string } {
    const error = publicScoutErrorCode(this.code);
    if (error === "QUERY_REJECTED") {
      return { error, message: "query rejected" };
    }
    if (error === "SCHEMA_ERROR") {
      return { error, message: "scout schema unavailable" };
    }
    if (error === "QUERY_TIMEOUT") {
      return { error, message: "graph lookup timed out" };
    }
    if (error === "SHAPE_ERROR") {
      return { error, message: "unexpected scout payload" };
    }
    return { error, message: "graph lookup unavailable right now" };
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function canonicalParams(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

export function assertScoutUrl(url: URL, allowedHost: string): void {
  if (url.host !== allowedHost) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ssrf: bad protocol");
}

const backoffUntil = { t: 0 };

export function scoutBackoffUntil(): number {
  return backoffUntil.t;
}

export function setScoutBackoff(ms: number): void {
  backoffUntil.t = Date.now() + ms;
}

export interface QueryCost {
  rows: number;
  duration_ms: number;
  truncated: boolean;
  ok: boolean;
  error_code: string | null;
}

export class ScoutClient {
  readonly host: string;
  readonly origin: string;
  private readonly bucket: TokenBucket;
  constructor(
    private readonly cfg: ScoutClientConfig,
    private readonly pool?: pg.Pool,
  ) {
    const u = new URL(cfg.scoutUrl);
    this.host = u.host;
    this.origin = u.origin;
    const qps = cfg.scoutMaxQps && cfg.scoutMaxQps > 0 ? cfg.scoutMaxQps : 2;
    this.bucket = new TokenBucket(qps, scoutBucketCapacity(qps));
  }

  private url(path: string): URL {
    const url = new URL(path, this.origin.endsWith("/") ? this.origin : `${this.origin}/`);
    assertScoutUrl(url, this.host);
    return url;
  }

  async schema(): Promise<unknown> {
    if (scoutBreakerBlocked()) {
      throw new ScoutToolError("SCOUT_BACKOFF", "graph lookup unavailable right now");
    }
    const gotToken = await this.bucket.acquire(this.cfg.scoutTimeoutMs);
    if (!gotToken) {
      throw new ScoutToolError("RATE_LIMITED", "graph lookup unavailable right now");
    }
    const { status, body } = await fetchJson(this.url("/v1/schema"), this.cfg.scoutTimeoutMs);
    if (status !== 200) throw new ScoutToolError("SCHEMA_ERROR", "scout schema unavailable");
    return body;
  }

  async query(opts: {
    cypher: string;
    params?: Record<string, unknown>;
    limit?: number;
    tool: string;
    mentionKey?: string;
  }): Promise<{ envelope: ScoutEnvelope; cost: QueryCost }> {
    if (scoutBreakerBlocked()) {
      throw new ScoutToolError("SCOUT_BACKOFF", "graph lookup unavailable right now");
    }
    if (Date.now() < backoffUntil.t) {
      throw new ScoutToolError("SCOUT_BACKOFF", "graph lookup unavailable right now");
    }
    const gotToken = await this.bucket.acquire(this.cfg.scoutTimeoutMs);
    if (!gotToken) {
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params: opts.params ?? {},
        rows: 0,
        truncated: false,
        duration_ms: 0,
        ok: false,
        error_code: "RATE_LIMITED",
        mention_key: opts.mentionKey ?? null,
      });
      throw new ScoutToolError("RATE_LIMITED", "graph lookup unavailable right now");
    }
    const limit = Math.min(this.cfg.scoutLimitMax, Math.max(1, Math.floor(opts.limit ?? 25)));
    const params = opts.params ?? {};
    const started = Date.now();
    let status = 0;
    let body: unknown = null;
    try {
      const res = await postJson(this.url("/v1/query"), this.cfg.scoutTimeoutMs, {
        cypher: opts.cypher,
        params,
        limit,
      });
      status = res.status;
      body = res.body;
    } catch (e) {
      const duration = Date.now() - started;
      const code = e instanceof Error && e.name === "AbortError" ? "QUERY_TIMEOUT" : "INTERNAL_ERROR";
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params,
        rows: 0,
        truncated: false,
        duration_ms: duration,
        ok: false,
        error_code: code,
        mention_key: opts.mentionKey ?? null,
      });
      noteScoutOutcome(false);
      throw new ScoutToolError(code, "graph lookup unavailable right now");
    }
    const duration = Date.now() - started;
    if (status === 429) {
      setScoutBackoff(8_000);
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params,
        rows: 0,
        truncated: false,
        duration_ms: duration,
        ok: false,
        error_code: "RATE_LIMITED",
        mention_key: opts.mentionKey ?? null,
      });
      noteScoutOutcome(false);
      throw new ScoutToolError("RATE_LIMITED", "graph lookup unavailable right now");
    }
    if (status === 504) {
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params,
        rows: 0,
        truncated: false,
        duration_ms: duration,
        ok: false,
        error_code: "QUERY_TIMEOUT",
        mention_key: opts.mentionKey ?? null,
      });
      noteScoutOutcome(false);
      throw new ScoutToolError("QUERY_TIMEOUT", "graph lookup timed out");
    }
    const err = scoutErrorSchema.safeParse(body);
    if (status >= 400 || (err.success && err.data.error)) {
      const code = err.success ? err.data.error : `HTTP_${status}`;
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params,
        rows: 0,
        truncated: false,
        duration_ms: duration,
        ok: false,
        error_code: code,
        mention_key: opts.mentionKey ?? null,
      });
      noteScoutOutcome(false);
      throw new ScoutToolError(code, "graph lookup unavailable right now");
    }
    const parsed = scoutEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      await this.record({
        tool: opts.tool,
        cypher: opts.cypher,
        params,
        rows: 0,
        truncated: false,
        duration_ms: duration,
        ok: false,
        error_code: "SHAPE_ERROR",
        mention_key: opts.mentionKey ?? null,
      });
      noteScoutOutcome(false);
      throw new ScoutToolError("SHAPE_ERROR", "unexpected scout payload");
    }
    const envelope = parsed.data;
    const cost: QueryCost = {
      rows: envelope.count,
      duration_ms: duration,
      truncated: envelope.truncated,
      ok: true,
      error_code: null,
    };
    await this.record({
      tool: opts.tool,
      cypher: opts.cypher,
      params,
      rows: envelope.count,
      truncated: envelope.truncated,
      duration_ms: duration,
      ok: true,
      error_code: null,
      mention_key: opts.mentionKey ?? null,
    });
    noteScoutOutcome(true);
    return { envelope, cost };
  }

  async record(row: {
    tool: string;
    cypher: string;
    params: Record<string, unknown>;
    rows: number;
    truncated: boolean;
    duration_ms: number;
    ok: boolean;
    error_code: string | null;
    mention_key: string | null;
  }): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.tool,
        sha256(row.cypher),
        sha256(canonicalParams(row.params)),
        row.rows,
        row.truncated,
        row.duration_ms,
        row.ok,
        row.error_code,
        row.mention_key,
      ],
    );
  }
}

export const scoutToolErrorPublicSchema = z.object({
  error: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
