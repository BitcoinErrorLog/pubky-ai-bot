import { ConversationalPlan, type PlanRef } from "../bot-kit/nlq/conversational-plan.js";
import { composeCypher, revalidateResolvedParams, type ComposeInput, type ComposeOk } from "../bot-kit/scout/composer.js";
import { ScoutCallBudgetError, type ComposedQueryBudget, type ScoutCallMeter } from "../bot-kit/scout/budget.js";
import type { ExecutionScope, PlanExecution, PlanExecutorTool } from "../bot-kit/nlq/plan-port.js";
import { executionScope, mergeExecutionScopes } from "./execution-scope.js";
import { parseConversationalPlanForPubchi } from "./conversational-plan.js";

export type { ExecutionScope, PlanExecution, PlanExecutorTool };

export type ComposerPort = {
  composeCypher: (input: ComposeInput) => ComposeOk | { ok: false; code: string; hint: string; path?: string };
  revalidateResolvedParams: typeof revalidateResolvedParams;
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

/** §2 local-denial copy. A disabled composer degrades to this, never to "unsupported". */
export const COMPOSER_DENIED_COPY =
  "I couldn't make a safe read-only query for that request. I did not run it.";
/** §2 cost-denial copy. */
export const COMPOSER_COST_COPY =
  "That graph question is too broad to run safely. Choose a smaller window, fewer hops, or one metric.";
/** §1: a feed plan enters the builder flow; it never writes a feed. */
export const FEED_HANDOFF_COPY =
  "I drafted a feed from that request. Open the feed builder to review and save it.";
export const FEED_INVALID_COPY =
  "I couldn't turn that into a feed this App can author. Try naming tags, reach, sort, and layout.";

/** A step that did not produce usable evidence, carrying the public failure code. */
export class PlanStepError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlanStepError";
  }
}

function publicToolErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function failureCodeOf(error: unknown): string {
  if (error instanceof PlanStepError) return error.code;
  if (error instanceof ScoutCallBudgetError) return error.code;
  return "upstream_error";
}

/** Copy for failures the service decided locally; upstream codes get none. */
function localDenialCopy(code: string): string | undefined {
  if (code === "COMPOSER_COST") return COMPOSER_COST_COPY;
  if (code === "COMPOSER_DENIED" || code === "COMPOSER_DISABLED" || code === "BAD_INPUT") return COMPOSER_DENIED_COPY;
  return undefined;
}

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

/** One executed step: the tool that ran and the parameters it actually ran with. */
type Executed = { tool: string; args: Record<string, unknown> };

function numberParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Scope inputs for a composed query: the parameters the composer emitted and
 * whether the composed text is anchored on the injected `$owner`. The plan's
 * own scope object is not consulted.
 */
function cypherExecutionArgs(composed: ComposeOk, owner: string): Record<string, unknown> {
  const since = numberParam(composed.params, "since");
  const until = numberParam(composed.params, "until");
  return {
    ...(since !== undefined || until !== undefined
      ? { time_range: { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) } }
      : {}),
    ...(/\$owner\b/.test(composed.cypher) ? { graph_scope: { pubky: owner } } : {}),
  };
}

async function executeAction(
  action: Extract<ConversationalPlan, { kind: "template" | "cypher" }>,
  opts: PlanExecutorOptions,
  outputs: Map<string, unknown>,
): Promise<{ result: unknown; executed: Executed }> {
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
    if (!composed.ok) throw new PlanStepError("COMPOSER_DENIED");
    const result = await opts.tools.query_graph.execute({
      cypher: composed.cypher,
      params: composed.params,
      limit: composed.limit,
    } as never);
    const composedFailure = publicToolErrorCode(result);
    // The canonical guard is the last word on a composed query: when it refuses
    // one the composer approved, the answer is the denial copy, not an outage.
    if (composedFailure === "QUERY_REJECTED") throw new PlanStepError("COMPOSER_DENIED");
    if (composedFailure) throw new PlanStepError(composedFailure);
    return { result, executed: { tool: "query_graph", args: cypherExecutionArgs(composed, opts.owner) } };
  }
  const tool = opts.tools[action.tool];
  if (!tool) throw new PlanStepError("BAD_INPUT");
  const parsed = tool.parameters.safeParse(resolve(action.params, outputs));
  if (!parsed.success) throw new PlanStepError("BAD_INPUT");
  const args = parsed.data as Record<string, unknown>;
  const result = await tool.execute(args as never);
  const failure = publicToolErrorCode(result);
  if (failure) throw new PlanStepError(failure);
  return { result, executed: { tool: action.tool, args } };
}

function scopeOfExecutions(executed: Executed[], nowMs: number, complete: boolean): ExecutionScope {
  return mergeExecutionScopes(
    executed.map((entry) => executionScope(undefined, entry.args, nowMs, complete)),
    complete,
  );
}

function noGraphScope(complete: boolean): ExecutionScope {
  return { time: null, graph: { kind: "none" }, filters: [], complete };
}

/**
 * Name what completed and what failed. Never claim a specific finding the
 * execution did not produce.
 */
function partialChainMessage(completed: Executed[], failedStep: string, totalSteps: number): string {
  if (completed.length === 0) {
    return "The first step of this question failed, so I have no evidence yet. Try a smaller window or scope.";
  }
  const tools = [...new Set(completed.map((entry) => entry.tool))].join(", ");
  return `I completed ${completed.length} of ${totalSteps} steps (${tools}), but step ${failedStep} failed, so I can't answer the rest yet.`;
}

export async function executeConversationalPlan(opts: PlanExecutorOptions): Promise<PlanExecution> {
  const parsed = parseConversationalPlanForPubchi(opts.plan);
  if (!parsed.success) {
    const base = ConversationalPlan.safeParse(opts.plan);
    if (base.success && base.data.kind === "feed") {
      return { kind: "feed", results: [], tools: [], scope: noGraphScope(false), complete: false, message: FEED_INVALID_COPY };
    }
    throw new Error("invalid conversational plan");
  }
  const plan = parsed.data;
  const composedCypherEnabled = opts.composedCypherEnabled ?? process.env.PUBCHI_COMPOSED_CYPHER_ENABLED === "1";
  if (plan.kind === "answer") {
    return { kind: "answer", results: [], tools: [], scope: noGraphScope(true), complete: true, answer: plan.text };
  }
  if (plan.kind === "feed") {
    return {
      kind: "feed",
      results: [],
      tools: [],
      scope: noGraphScope(true),
      complete: true,
      message: FEED_HANDOFF_COPY,
      feed: plan.spec,
    };
  }
  if (plan.kind !== "chain") {
    const denied = (message: string | undefined, failureCode: string): PlanExecution => ({
      kind: plan.kind,
      results: [],
      tools: [],
      scope: noGraphScope(false),
      complete: false,
      failureCode,
      ...(message ? { message } : {}),
    });
    if (plan.kind === "cypher" && !composedCypherEnabled) return denied(COMPOSER_DENIED_COPY, "COMPOSER_DISABLED");
    if (plan.kind === "cypher" && opts.composedQueryBudget && !(await opts.composedQueryBudget.allow(opts.owner))) {
      return denied(COMPOSER_COST_COPY, "COMPOSER_COST");
    }
    let executedStep: { result: unknown; executed: Executed };
    try {
      executedStep = await executeAction(plan, opts, new Map());
      opts.meter.assertBudget();
    } catch (error) {
      const failureCode = failureCodeOf(error);
      // Upstream failures carry no executor copy: the service maps the code to
      // the §1 row (Scout timeout, budget, switch) with its existing wiring.
      return denied(localDenialCopy(failureCode), failureCode);
    }
    return {
      kind: plan.kind,
      results: [executedStep.result],
      tools: [executedStep.executed.tool],
      scope: scopeOfExecutions([executedStep.executed], opts.nowMs, true),
      complete: true,
    };
  }
  const outputs = new Map<string, unknown>();
  const results: unknown[] = [];
  const executedSteps: Executed[] = [];
  for (const step of plan.steps) {
    const denial = (message: string | undefined, failureCode: string): PlanExecution => ({
      kind: "chain",
      results,
      tools: executedSteps.map((entry) => entry.tool),
      scope: scopeOfExecutions(executedSteps, opts.nowMs, false),
      complete: false,
      failedStep: step.id,
      failureCode,
      ...(message ? { message } : {}),
    });
    try {
      const action = step.action;
      if (action.kind === "cypher" && !composedCypherEnabled) return denial(COMPOSER_DENIED_COPY, "COMPOSER_DISABLED");
      if (action.kind === "cypher" && opts.composedQueryBudget && !(await opts.composedQueryBudget.allow(opts.owner))) {
        return denial(COMPOSER_COST_COPY, "COMPOSER_COST");
      }
      const { result, executed } = await executeAction(action, opts, outputs);
      outputs.set(step.id, result);
      results.push(result);
      executedSteps.push(executed);
      opts.meter.assertBudget();
    } catch (error) {
      const failureCode = failureCodeOf(error);
      // Partial evidence survives: name the completed steps and the failed one
      // rather than the local-denial copy, which would hide what did run.
      return denial(
        executedSteps.length > 0
          ? partialChainMessage(executedSteps, step.id, plan.steps.length)
          : localDenialCopy(failureCode),
        failureCode,
      );
    }
  }
  return {
    kind: "chain",
    results,
    tools: executedSteps.map((entry) => entry.tool),
    scope: scopeOfExecutions(executedSteps, opts.nowMs, true),
    complete: true,
  };
}
