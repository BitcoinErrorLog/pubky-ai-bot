import type { ExecutionScope } from "../bot-kit/nlq/plan-port.js";
import { log } from "../bot-kit/log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXECUTED_WINDOW_MS = 365 * DAY_MS;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

export function scopeForNoLookup(complete: boolean): ExecutionScope {
  return { time: null, graph: { kind: "none" }, filters: [], complete };
}

/**
 * Canonical scope derivation. The only inputs are the parameters a tool was
 * actually executed with and the request clock — never the model's requested
 * scope, and never a model-authored label.
 */
export function executionScope(
  answer: string | undefined,
  args: Rec | undefined,
  now: number,
  complete: boolean,
): ExecutionScope {
  if (answer) return scopeForNoLookup(complete);
  const range = rec(args?.time_range);
  const clockDay = now > 100_000_000_000 ? DAY_MS : 24 * 60 * 60;
  const since = typeof range?.since === "number" ? range.since : Math.max(0, now - 30 * clockDay);
  const until = typeof range?.until === "number" ? range.until : now;
  const graph = rec(args?.graph_scope);
  const hops = graph?.hops === 1 || graph?.hops === 2 || graph?.hops === 3 ? graph.hops : undefined;
  const sinceMs = since > 100_000_000_000 ? since : since * 1000;
  const untilMs = until > 100_000_000_000 ? until : until * 1000;
  const invalidTime = since <= 0 || untilMs < sinceMs || untilMs - sinceMs > MAX_EXECUTED_WINDOW_MS;
  if (invalidTime) {
    log.error({ event: "pubchi_execution_scope_invalid_time", since, until }, "pubchi execution scope rejected invalid executed time window");
  }
  return {
    time: invalidTime ? null : {
      since_ms: since,
      until_ms: until,
      label: renderExecutionWindow({ since_ms: since, until_ms: until }),
      source: range ? "explicit" : "default",
    },
    graph: graph?.pubky ? { kind: "owner_network", ...(hops ? { hops } : {}) } : { kind: "whole_graph" },
    filters: [],
    complete,
  };
}

/**
 * Scope for a multi-step execution: the window the answer actually covers is
 * the union of the executed windows, and the graph reach is the widest one
 * read.
 */
export function mergeExecutionScopes(scopes: ExecutionScope[], complete: boolean): ExecutionScope {
  if (scopes.length === 0) return scopeForNoLookup(complete);
  const times = scopes.map((scope) => scope.time).filter((time): time is NonNullable<ExecutionScope["time"]> => Boolean(time));
  const graphs = scopes.map((scope) => scope.graph);
  const hops = graphs
    .map((graph) => graph.hops)
    .filter((value): value is 1 | 2 | 3 => value === 1 || value === 2 || value === 3);
  const widest = graphs.some((graph) => graph.kind === "whole_graph")
    ? { kind: "whole_graph" as const }
    : graphs.some((graph) => graph.kind === "owner_network")
      ? { kind: "owner_network" as const, ...(hops.length ? { hops: Math.max(...hops) as 1 | 2 | 3 } : {}) }
      : { kind: "none" as const };
  return {
    time: times.length
      ? {
          since_ms: Math.min(...times.map((time) => time.since_ms)),
          until_ms: Math.max(...times.map((time) => time.until_ms)),
          label: renderExecutionWindow({
            since_ms: Math.min(...times.map((time) => time.since_ms)),
            until_ms: Math.max(...times.map((time) => time.until_ms)),
          }),
          source: times.every((time) => time.source === "explicit") ? "explicit" : "default",
        }
      : null,
    graph: widest,
    filters: [],
    complete,
  };
}

export function renderExecutionWindow(time: { since_ms: number; until_ms: number }): string {
  const since = time.since_ms > 100_000_000_000 ? time.since_ms : time.since_ms * 1000;
  const until = time.until_ms > 100_000_000_000 ? time.until_ms : time.until_ms * 1000;
  const days = Math.max(1, Math.round((until - since) / DAY_MS));
  const format = (value: number) => new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
  const start = format(since);
  const end = format(until);
  const endDay = end.replace(/^[A-Za-z]+ /, "");
  return `last ${days} days (${start}–${end.startsWith(start.split(" ")[0] ?? "") ? endDay : end} UTC)`;
}

export function renderExecutionScope(scope: {
  time: { since_ms: number; until_ms: number } | null;
  graph: { kind: "whole_graph" | "owner_network" | "none"; hops?: 1 | 2 | 3 };
}): string {
  if (scope.graph.kind === "none") return "Scope: no graph lookup.";
  const graph = scope.graph.kind === "whole_graph"
    ? "whole graph"
    : `your ${scope.graph.hops ?? 1}-hop network`;
  if (!scope.time) return `Scope: current indexed graph, ${graph}.`;
  return `Scope: ${renderExecutionWindow(scope.time)}, ${graph}.`;
}
