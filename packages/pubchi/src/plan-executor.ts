import { ConversationalPlan, type ExecutionPlanScope, type PlanRef } from "../bot-kit/nlq/conversational-plan.js";
import type { ComposerPort, ScoutCallMeter } from "../bot-kit/nlq/composer-port.js";

export type ExecutionScope = {
  time: { since_ms: number; until_ms: number; label: string; source: "explicit" | "default" | "tool" } | null;
  graph: { kind: "whole_graph" | "owner_network" | "none"; hops?: 1 | 2 | 3 };
  filters: string[];
  complete: boolean;
};

export type PlanExecutorTool = {
  parameters: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  execute(value: never): Promise<unknown>;
};

export type PlanExecutorOptions = {
  plan: unknown;
  owner: string;
  tools: Record<string, PlanExecutorTool>;
  composer?: ComposerPort;
  schema?: unknown;
  meter: ScoutCallMeter;
  nowMs: number;
  untrustedTexts?: string[];
};

export type PlanExecution = {
  kind: "template" | "cypher" | "chain" | "answer" | "feed";
  results: unknown[];
  tools: string[];
  scope: ExecutionScope;
  complete: boolean;
  failedStep?: string;
  answer?: string;
  feed?: unknown;
};

function scopeOf(scope: ExecutionPlanScope | undefined, nowMs: number, complete = true): ExecutionScope {
  if (!scope) {
    return {
      time: null,
      graph: { kind: "none" },
      filters: [],
      complete,
    };
  }
  return {
    time: { ...scope.window },
    graph: {
      kind: scope.graph.kind,
      ...(scope.graph.hops === 1 || scope.graph.hops === 2 || scope.graph.hops === 3 ? { hops: scope.graph.hops } : {}),
    },
    filters: [],
    complete,
  };
}

function isRef(value: unknown): value is PlanRef {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as PlanRef).from_step === "string" &&
      typeof (value as PlanRef).path === "string",
  );
}

function readPath(value: unknown, path: PlanRef["path"]): unknown {
  const match = /^([a-z]+)\[(\d+)\]\.([a-z_]+)$/i.exec(path);
  if (!match || !value || typeof value !== "object") return undefined;
  const list = (value as Record<string, unknown>)[match[1]];
  return Array.isArray(list) ? (list[Number(match[2])] as Record<string, unknown> | undefined)?.[match[3]] : undefined;
}

function resolve(value: unknown, outputs: Map<string, unknown>): unknown {
  if (isRef(value)) return readPath(outputs.get(value.from_step), value.path);
  if (Array.isArray(value)) return value.map((item) => resolve(item, outputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, outputs)]));
  }
  return value;
}

async function executeAction(
  action: Extract<ConversationalPlan, { kind: "template" | "cypher" }>,
  opts: PlanExecutorOptions,
  outputs: Map<string, unknown>,
): Promise<unknown> {
  if (action.kind === "cypher") {
    if (!opts.composer) throw new Error("composer unavailable");
    const composed = opts.composer.composeCypher({
      query: action.query,
      params: resolve(action.params, outputs) as Record<string, unknown>,
      tenant: { owner: opts.owner },
      schema: opts.schema,
      untrustedTexts: opts.untrustedTexts ?? [],
      scopeKind: action.scope.graph.kind,
    });
    if (!composed.ok) throw new Error(composed.hint);
    return opts.tools.query_graph.execute({
      cypher: composed.cypher,
      params: composed.params,
      limit: composed.limit,
    } as never);
  }
  const tool = opts.tools[action.tool];
  if (!tool) throw new Error(`tool ${action.tool} is not registered`);
  const parsed = tool.parameters.safeParse(resolve(action.params, outputs));
  if (!parsed.success) throw new Error("tool arguments are invalid");
  return tool.execute(parsed.data as never);
}

export async function executeConversationalPlan(opts: PlanExecutorOptions): Promise<PlanExecution> {
  const parsed = ConversationalPlan.safeParse(opts.plan);
  if (!parsed.success) throw new Error("invalid conversational plan");
  const plan = parsed.data;
  if (plan.kind === "answer") {
    return { kind: "answer", results: [], tools: [], scope: scopeOf(undefined, opts.nowMs), complete: true, answer: plan.text };
  }
  if (plan.kind === "feed") {
    return { kind: "feed", results: [], tools: [], scope: scopeOf(undefined, opts.nowMs), complete: true, feed: plan.spec };
  }
  if (plan.kind !== "chain") {
    const result = await executeAction(plan, opts, new Map());
    opts.meter.record(0);
    opts.meter.assertBudget();
    return {
      kind: plan.kind,
      results: [result],
      tools: [plan.kind === "template" ? plan.tool : "query_graph"],
      scope: scopeOf(plan.scope, opts.nowMs),
      complete: true,
    };
  }
  const outputs = new Map<string, unknown>();
  const results: unknown[] = [];
  const tools: string[] = [];
  for (const step of plan.steps) {
    try {
      const action = step.action;
      const result = await executeAction(action, opts, outputs);
      outputs.set(step.id, result);
      results.push(result);
      tools.push(action.kind === "template" ? action.tool : "query_graph");
      opts.meter.assertBudget();
    } catch (error) {
      return {
        kind: "chain",
        results,
        tools,
        scope: { ...scopeOf(plan.scope, opts.nowMs, false), complete: false },
        complete: false,
        failedStep: step.id,
      };
    }
  }
  return { kind: "chain", results, tools, scope: scopeOf(plan.scope, opts.nowMs), complete: true };
}
