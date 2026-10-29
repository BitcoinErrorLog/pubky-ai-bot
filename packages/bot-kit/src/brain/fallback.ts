import { log } from "../log.js";
import type { ToolLoopGenerate } from "../answer/tool-loop.js";
import type { Brain } from "./types.js";

/**
 * Why a call on the primary model was retried on the fallback model.
 * Only provider-side failures qualify: overload, rate limiting, 5xx,
 * transport errors, and a primary that gave no response in time.
 * 4xx responses (bad key, bad request, forbidden) never do.
 */
export type ModelFallbackReason = "rate_limited" | "overloaded" | "server_error" | "timeout" | "network";

export type ModelRole = "primary" | "fallback";

export type ModelFallbackEvent =
  | { kind: "answered"; model: string; role: ModelRole }
  | {
      kind: "fallback";
      from: string;
      to: string;
      reason: ModelFallbackReason;
      status?: number;
    }
  | { kind: "failed"; model: string; role: ModelRole; reason?: ModelFallbackReason; status?: number };

export type ModelRouteSnapshot = {
  primary: string | null;
  fallback: string | null;
  fallbackAfterMs: number | null;
  lastAnsweredModel: string | null;
  lastAnsweredRole: ModelRole | null;
  lastAnsweredAt: string | null;
  answeredByModel: Record<string, number>;
  fallbackCount: number;
  fallbackFailedCount: number;
  lastFallback: {
    at: string;
    from: string;
    to: string;
    reason: ModelFallbackReason;
    status: number | null;
  } | null;
};

type StatusLike = { statusCode?: unknown; status?: unknown; responseBody?: unknown; data?: unknown; cause?: unknown };

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 4 && cur !== undefined && cur !== null; i++) {
    chain.push(cur);
    cur = typeof cur === "object" ? (cur as StatusLike).cause : undefined;
  }
  return chain;
}

function statusOf(error: unknown): number | undefined {
  for (const e of errorChain(error)) {
    if (e && typeof e === "object") {
      const s = (e as StatusLike).statusCode ?? (e as StatusLike).status;
      if (typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599) return s;
    }
  }
  return undefined;
}

function overloadText(error: unknown): boolean {
  for (const e of errorChain(error)) {
    if (!e || typeof e !== "object") continue;
    const body = (e as StatusLike).responseBody;
    if (typeof body === "string" && /overload/i.test(body)) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && /overload/i.test(message)) return true;
  }
  return false;
}

export type FallbackClassification = { reason: ModelFallbackReason; status?: number };

/**
 * Decide whether a failed primary call may be retried once on the fallback.
 * Returns null for anything that must surface to the caller unchanged.
 */
export function classifyFallbackError(
  error: unknown,
  ctx: { primaryTimedOut: boolean },
): FallbackClassification | null {
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 429) return { reason: overloadText(error) ? "overloaded" : "rate_limited", status };
    if (status === 408) return { reason: "timeout", status };
    if (status >= 500) return { reason: overloadText(error) ? "overloaded" : "server_error", status };
    if (status >= 400) return null;
    return null;
  }
  if (ctx.primaryTimedOut) return { reason: "timeout" };
  if (overloadText(error)) return { reason: "overloaded" };
  for (const e of errorChain(error)) {
    if (!e || typeof e !== "object") continue;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return { reason: "network" };
    const name = (e as { name?: unknown }).name;
    if (name === "TimeoutError") return { reason: "timeout" };
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && /^(fetch failed|terminated|socket hang up|network error)/i.test(message)) {
      return { reason: "network" };
    }
  }
  return null;
}

/** Process-wide record of which model answered, for health and metrics. */
export class ModelRouteStats {
  private primary: string | null = null;
  private fallback: string | null = null;
  private fallbackAfterMs: number | null = null;
  private last: { model: string; role: ModelRole; at: string } | null = null;
  private readonly byModel = new Map<string, number>();
  private fallbackCount = 0;
  private fallbackFailedCount = 0;
  private lastFallback: ModelRouteSnapshot["lastFallback"] = null;

  configure(route: { primary: string; fallback: string | null; fallbackAfterMs: number | null }): void {
    this.primary = route.primary;
    this.fallback = route.fallback;
    this.fallbackAfterMs = route.fallbackAfterMs;
  }

  record(event: ModelFallbackEvent): void {
    const at = new Date().toISOString();
    if (event.kind === "answered") {
      this.last = { model: event.model, role: event.role, at };
      this.byModel.set(event.model, (this.byModel.get(event.model) ?? 0) + 1);
    } else if (event.kind === "fallback") {
      this.fallbackCount += 1;
      this.lastFallback = { at, from: event.from, to: event.to, reason: event.reason, status: event.status ?? null };
    } else if (event.role === "fallback") {
      this.fallbackFailedCount += 1;
    }
  }

  snapshot(): ModelRouteSnapshot {
    return {
      primary: this.primary,
      fallback: this.fallback,
      fallbackAfterMs: this.fallbackAfterMs,
      lastAnsweredModel: this.last?.model ?? null,
      lastAnsweredRole: this.last?.role ?? null,
      lastAnsweredAt: this.last?.at ?? null,
      answeredByModel: Object.fromEntries(this.byModel),
      fallbackCount: this.fallbackCount,
      fallbackFailedCount: this.fallbackFailedCount,
      lastFallback: this.lastFallback,
    };
  }
}

export const modelRouteStats = new ModelRouteStats();

export function modelRouteSnapshot(): ModelRouteSnapshot {
  return modelRouteStats.snapshot();
}

export type WithModelFallbackOptions = {
  /** Abort the primary attempt and use the fallback when it has not answered by then. */
  primaryTimeoutMs?: number;
  stats?: ModelRouteStats;
  onEvent?: (event: ModelFallbackEvent) => void;
};

/**
 * One retry of the same request on a second model of the same provider
 * (same key, same base URL). The fallback failing too surfaces the fallback
 * error so the caller's existing canned-reply path runs. Caller aborts and
 * non-retryable errors (4xx other than 408/429) pass through untouched.
 */
export function withModelFallback(primary: Brain, fallback: Brain | null, opts: WithModelFallbackOptions = {}): Brain {
  const primaryModel = primary.capabilities.name;
  const fallbackModel = fallback?.capabilities.name ?? null;
  const stats = opts.stats ?? modelRouteStats;
  const timeoutMs = opts.primaryTimeoutMs !== undefined && opts.primaryTimeoutMs > 0 ? opts.primaryTimeoutMs : undefined;
  stats.configure({ primary: primaryModel, fallback: fallbackModel, fallbackAfterMs: fallback ? (timeoutMs ?? null) : null });
  const emit = (event: ModelFallbackEvent) => {
    stats.record(event);
    opts.onEvent?.(event);
  };

  const generate: ToolLoopGenerate = async (args) => {
    const callerSignal = args.abortSignal;
    const timeoutSignal = fallback && timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
    const primarySignal = timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : callerSignal;
    try {
      const out = await primary.generate({ ...args, abortSignal: primarySignal });
      emit({ kind: "answered", model: primaryModel, role: "primary" });
      log.info({ model: primaryModel, role: "primary" }, "model answered");
      return out;
    } catch (error) {
      const callerCancelled = callerSignal.aborted;
      const classified = !callerCancelled && fallback
        ? classifyFallbackError(error, { primaryTimedOut: timeoutSignal?.aborted === true })
        : null;
      if (!classified || !fallback) {
        emit({ kind: "failed", model: primaryModel, role: "primary" });
        throw error;
      }
      emit({ kind: "failed", model: primaryModel, role: "primary", reason: classified.reason, status: classified.status });
      emit({ kind: "fallback", from: primaryModel, to: fallback.capabilities.name, reason: classified.reason, status: classified.status });
      log.warn(
        { from: primaryModel, to: fallback.capabilities.name, reason: classified.reason, status: classified.status ?? null },
        "model fallback: primary failed, retrying on fallback",
      );
      try {
        const out = await fallback.generate(args);
        emit({ kind: "answered", model: fallback.capabilities.name, role: "fallback" });
        log.info({ model: fallback.capabilities.name, role: "fallback", primary: primaryModel }, "model answered via fallback");
        return out;
      } catch (fallbackError) {
        emit({ kind: "failed", model: fallback.capabilities.name, role: "fallback" });
        log.warn({ model: fallback.capabilities.name, primary: primaryModel }, "model fallback failed");
        throw fallbackError;
      }
    }
  };

  return { ...primary, generate };
}
