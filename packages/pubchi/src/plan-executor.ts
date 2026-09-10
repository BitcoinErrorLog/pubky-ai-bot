import { ConversationalPlan, type ExecutionPlanScope, type PlanRef } from "../bot-kit/nlq/conversational-plan.js";
import { composeCypher, revalidateResolvedParams, type ComposeInput, type ComposeOk } from "../bot-kit/scout/composer.js";
import type { ComposedQueryBudget, ScoutCallMeter } from "../bot-kit/scout/budget.js";

export type ComposerPort = {
  composeCypher: (input: ComposeInput) => ComposeOk | { ok: false; code: string; hint: string; path?: string };
  revalidateResolvedParams: typeof revalidateResolvedParams;
};

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
  composedQueryBudget?: ComposedQueryBudget;
  composedCypherEnabled?: boolean;
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
  message?: string;
  feed?: unknown;
};

export async function executeTrendingFallback(opts: {
  emergingTopics: () => Promise<{ topics?: unknown[] }>;
  compose: () => Promise<unknown>;
}): Promise<{ result: unknown; summary: string }> {
  const emerging = await opts.emergingTopics();
  if (Array.isArray(emerging.topics) && emerging.topics.length > 0) {
    return { result: emerging, summary: "These tags are trending this week." };
  }
  const result = await opts.compose();
  return { result, summary: "I found no emerging topics, so this shows the most used this week." };
}

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
    const composer = opts.composer ?? { composeCypher, revalidateResolvedParams };
    const params = resolve(action.params, outputs) as Record<string, unknown>;
    composer.revalidateResolvedParams(params);
    const composed = composer.composeCypher({
      query: action.query,
      params,
      tenant: { owner: opts.owner },
      schema: opts.schema as ComposeInput["schema"],
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
  const composedCypherEnabled = opts.composedCypherEnabled ?? process.env.PUBCHI_COMPOSED_CYPHER_ENABLED === "1";
  if (plan.kind === "answer") {
    return { kind: "answer", results: [], tools: [], scope: scopeOf(undefined, opts.nowMs), complete: true, answer: plan.text };
  }
  if (plan.kind === "feed") {
    return { kind: "feed", results: [], tools: [], scope: scopeOf(undefined, opts.nowMs), complete: true, feed: plan.spec };
  }
  if (plan.kind !== "chain") {
    if (plan.kind === "cypher" && !composedCypherEnabled) {
      return {
        kind: "answer",
        results: [],
        tools: [],
        scope: scopeOf(plan.scope, opts.nowMs),
        complete: true,
        answer: "I couldn't make a safe read-only query for that request. I did not run it.",
      };
    }
    if (plan.kind === "cypher" && opts.composedQueryBudget && !(await opts.composedQueryBudget.allow(opts.owner))) {
      return {
        kind: "answer",
        results: [],
        tools: [],
        scope: scopeOf(plan.scope, opts.nowMs),
        complete: true,
        answer: "That graph question is too broad to run safely. Choose a smaller window, fewer hops, or one metric.",
      };
    }
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
      if (action.kind === "cypher" && !composedCypherEnabled) {
        return {
          kind: "answer",
          results,
          tools,
          scope: scopeOf(plan.scope, opts.nowMs, false),
          complete: false,
          answer: "I couldn't make a safe read-only query for that request. I did not run it.",
        };
      }
      if (action.kind === "cypher" && opts.composedQueryBudget && !(await opts.composedQueryBudget.allow(opts.owner))) {
        return {
          kind: "answer",
          results,
          tools,
          scope: scopeOf(plan.scope, opts.nowMs, false),
          complete: false,
          answer: "That graph question is too broad to run safely. Choose a smaller window, fewer hops, or one metric.",
        };
      }
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
        message: "I found the top tagger, but the follow-up tag lookup timed out; I can't answer the second part yet.",
      };
    }
  }
  return { kind: "chain", results, tools, scope: scopeOf(plan.scope, opts.nowMs), complete: true };
}
