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

type StatusLike = {
  statusCode?: unknown;
  status?: unknown;
  responseBody?: unknown;
  data?: unknown;
  cause?: unknown;
  lastError?: unknown;
};

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
    // RetryError (SDK maxRetries > 0) carries the provider error in lastError.
    cur = typeof cur === "object" ? ((cur as StatusLike).lastError ?? (cur as StatusLike).cause) : undefined;
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

/**
 * Brain egress refuses redirects. Native fetch reports `redirect: "error"` as
 * TypeError("fetch failed") with a redirect cause, which must not read as a
 * transport failure.
 */
function isRedirectRefusal(error: unknown): boolean {
  return errorChain(error).some((e) => {
    const message = e && typeof e === "object" ? (e as { message?: unknown }).message : e;
    return typeof message === "string" && /redirect/i.test(message);
  });
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
  if (isRedirectRefusal(error)) return null;
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

const SETTLED = new WeakSet<object>();

/**
 * True when the model layer already made its retry decision for this error:
 * the fallback was tried and failed, or the error is one that must never be
 * retried (4xx). Callers with their own whole-answer retry skip it for these.
 * Only errors from a route with a configured fallback are marked.
 */
export function isModelFailureSettled(error: unknown): boolean {
  return typeof error === "object" && error !== null && SETTLED.has(error);
}

function settle(error: unknown): unknown {
  if (typeof error === "object" && error !== null) SETTLED.add(error);
  return error;
}

export type ModelRoute = {
  primary: string;
  fallback: string | null;
  /** Abort the primary attempt and use the fallback when it has not answered by then. */
  primaryTimeoutMs?: number;
  stats?: ModelRouteStats;
  /** When false the route records answers but does not overwrite the reported primary/fallback pair. */
  describesRoute?: boolean;
  onEvent?: (event: ModelFallbackEvent) => void;
};

export type ModelAttempt = {
  model: string;
  role: ModelRole;
  abortSignal: AbortSignal;
  /**
   * SDK-level retries for this attempt: 0 while a fallback is configured so
   * the fallback is the only retry; undefined keeps the SDK default otherwise.
   */
  maxRetries: number | undefined;
};

function timeoutOf(route: Pick<ModelRoute, "primaryTimeoutMs">): number | undefined {
  return route.primaryTimeoutMs !== undefined && route.primaryTimeoutMs > 0 ? route.primaryTimeoutMs : undefined;
}

function describe(route: ModelRoute): void {
  if (route.describesRoute === false) return;
  (route.stats ?? modelRouteStats).configure({
    primary: route.primary,
    fallback: route.fallback,
    fallbackAfterMs: route.fallback ? (timeoutOf(route) ?? null) : null,
  });
}

async function runRoute<T>(
  route: ModelRoute,
  callerSignal: AbortSignal,
  call: (attempt: ModelAttempt) => Promise<T>,
): Promise<T> {
  const stats = route.stats ?? modelRouteStats;
  const emit = (event: ModelFallbackEvent) => {
    stats.record(event);
    route.onEvent?.(event);
  };
  const { primary, fallback } = route;
  const timeoutMs = timeoutOf(route);
  const timeoutSignal = fallback && timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  const primarySignal = timeoutSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : callerSignal;
  const maxRetries = fallback ? 0 : undefined;
  try {
    const out = await call({ model: primary, role: "primary", abortSignal: primarySignal, maxRetries });
    emit({ kind: "answered", model: primary, role: "primary" });
    log.info({ model: primary, role: "primary" }, "model answered");
    return out;
  } catch (error) {
    const classified = !callerSignal.aborted && fallback
      ? classifyFallbackError(error, { primaryTimedOut: timeoutSignal?.aborted === true })
      : null;
    if (!classified || !fallback) {
      emit({ kind: "failed", model: primary, role: "primary" });
      throw fallback && !callerSignal.aborted ? settle(error) : error;
    }
    emit({ kind: "failed", model: primary, role: "primary", reason: classified.reason, status: classified.status });
    emit({ kind: "fallback", from: primary, to: fallback, reason: classified.reason, status: classified.status });
    log.warn(
      { from: primary, to: fallback, reason: classified.reason, status: classified.status ?? null },
      "model fallback: primary failed, retrying on fallback",
    );
    try {
      const out = await call({ model: fallback, role: "fallback", abortSignal: callerSignal, maxRetries });
      emit({ kind: "answered", model: fallback, role: "fallback" });
      log.info({ model: fallback, role: "fallback", primary }, "model answered via fallback");
      return out;
    } catch (fallbackError) {
      emit({ kind: "failed", model: fallback, role: "fallback" });
      log.warn({ model: fallback, primary }, "model fallback failed");
      throw callerSignal.aborted ? fallbackError : settle(fallbackError);
    }
  }
}

/**
 * Run one model request with at most one retry on the route's fallback model
 * (same provider, key and base URL). For call sites that use the SDK directly.
 */
export function runWithModelFallback<T>(
  route: ModelRoute,
  callerSignal: AbortSignal,
  call: (attempt: ModelAttempt) => Promise<T>,
): Promise<T> {
  describe(route);
  return runRoute(route, callerSignal, call);
}

export type WithModelFallbackOptions = Omit<ModelRoute, "primary" | "fallback">;

/**
 * One retry of the same request on a second model of the same provider
 * (same key, same base URL). The fallback failing too surfaces the fallback
 * error so the caller's existing canned-reply path runs. Caller aborts and
 * non-retryable errors (4xx other than 408/429) pass through untouched.
 */
export function withModelFallback(primary: Brain, fallback: Brain | null, opts: WithModelFallbackOptions = {}): Brain {
  const route: ModelRoute = { ...opts, primary: primary.capabilities.name, fallback: fallback?.capabilities.name ?? null };
  describe(route);
  if (!fallback) {
    const generate: ToolLoopGenerate = (args) => runRoute(route, args.abortSignal, () => primary.generate(args));
    return { ...primary, generate };
  }
  const generate: ToolLoopGenerate = (args) =>
    runRoute(route, args.abortSignal, (attempt) =>
      (attempt.role === "primary" ? primary : fallback).generate({ ...args, abortSignal: attempt.abortSignal }),
    );
  return { ...primary, generate };
}
