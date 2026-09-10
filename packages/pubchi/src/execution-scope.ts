import type { ExecutionScope } from "../bot-kit/nlq/plan-port.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
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
  if (answer) return { time: null, graph: { kind: "none" }, filters: [], complete };
  const range = rec(args?.time_range);
  const since = typeof range?.since === "number" ? range.since : Math.max(0, now - THIRTY_DAYS_MS);
  const until = typeof range?.until === "number" ? range.until : now;
  const graph = rec(args?.graph_scope);
  const hops = graph?.hops === 1 || graph?.hops === 2 || graph?.hops === 3 ? graph.hops : undefined;
  return {
    time: { since_ms: since, until_ms: until, label: "execution window", source: range ? "explicit" : "default" },
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
  if (scopes.length === 0) return { time: null, graph: { kind: "none" }, filters: [], complete };
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
          label: "execution window",
          source: times.every((time) => time.source === "explicit") ? "explicit" : "default",
        }
      : null,
    graph: widest,
    filters: [],
    complete,
  };
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
  const since = scope.time.since_ms > 100_000_000_000 ? scope.time.since_ms : scope.time.since_ms * 1000;
  const until = scope.time.until_ms > 100_000_000_000 ? scope.time.until_ms : scope.time.until_ms * 1000;
  const days = Math.max(1, Math.round((until - since) / DAY_MS));
  const format = (value: number) => new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
  const start = format(since);
  const end = format(until);
  const endDay = end.replace(/^[A-Za-z]+ /, "");
  return `Scope: last ${days} days (${start}–${end.startsWith(start.split(" ")[0] ?? "") ? endDay : end} UTC), ${graph}.`;
}
