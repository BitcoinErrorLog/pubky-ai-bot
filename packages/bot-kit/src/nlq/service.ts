import type pg from "pg";
import { log } from "../log.js";
import { Nexus } from "../nexus/nexus.js";
import { nexusTools } from "../nexus/tools.js";
import { publicScoutErrorCode, ScoutClient, ScoutToolError } from "../scout/client.js";
import { checkNlqDailyBudget, isPersistentCallerKey, scoutSwitchBlocked } from "../scout/budget.js";
import { scoutBreakerBlocked } from "../scout/circuit.js";
import { createScoutTools } from "../scout/tools.js";
import type { ScoutToolsConfig } from "../scout/scout-config.js";
import { TENANT_BOUND_PARAMS, type IntentRegexTables } from "./intent.js";
import type { AllowedTool } from "./intent.js";
import { parseNlqDailyQueries } from "./env.js";
import { loadPlannerSchema, planNlq, scopeForTool } from "./planner.js";
import { modelPlanPubchi, type ModelPlannerTools } from "./model-planner.js";
import { INVALID_PLAN_COPY, PLANNER_TIMEOUT_COPY, planConversational } from "./conversational-planner.js";
import type { ConversationalPlan } from "./conversational-plan.js";
import type { PlanExecution, PlanExecutorPort, PlanExecutorTool } from "./plan-port.js";
import { ScoutCallMeter } from "../scout/budget.js";
import { meteredScoutClient } from "../scout/metered-client.js";
import type { Brain } from "../brain/types.js";
import type { RemoteKnowledgeClient } from "../knowledge/remote-client.js";
import { nlqResult, type NlqPlannedCall, type NlqRequest, type NlqResult } from "./types.js";

export type NlqServiceOptions = {
  cfg: ScoutToolsConfig & { nexusUrl?: string };
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
  client: ScoutClient;
  nexus?: Nexus;
  mentionKey?: string;
  nlqDailyQueries?: number;
  brain?: Brain;
  screenQuestion?: (question: string) => string;
  plannerAbortSignal?: AbortSignal;
  /**
   * Executes cypher/chain/feed conversational plans. Injected by the Pubchi
   * service so bot-kit does not depend on the Pubchi package. Without it the
   * planner keeps the legacy single-tool behaviour.
   */
  planExecutor?: PlanExecutorPort;
  plannerCohort?: (owner: string) => boolean;
  /** Shared with the Scout client so D2 call/time caps see every call. */
  scoutCallMeter?: ScoutCallMeter;
  knowledge?: RemoteKnowledgeClient;
  webSearch?: { search(query: string, k?: number): Promise<unknown> };
  knowledgeBudget?: { allow(owner: string): Promise<boolean> };
};

/** §1 exact user-visible copy for a Scout failure inside a dispatched plan. */
export const PLAN_SCOUT_TIMEOUT_COPY =
  "The graph lookup timed out before I had enough evidence. No answer was inferred. Try a smaller window or scope.";

type ToolWithSchema = {
  parameters: { safeParse: (args: unknown) => { success: boolean; data?: unknown } };
  execute: (args: never) => Promise<unknown>;
};

function isPublicToolError(value: unknown): value is { error: string; message: string } {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string");
}

function collectSources(value: unknown): string[] {
  const uris: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s.startsWith("pubky://") || seen.has(s)) return;
    seen.add(s);
    uris.push(s);
  };
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      if (v.startsWith("pubky://")) add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.uri === "string") add(rec.uri);
      for (const child of Object.values(rec)) walk(child);
    }
  };
  walk(value);
  return uris;
}

function reasonForCode(code: string): string {
  const publicCode = publicScoutErrorCode(code);
  if (
    publicCode === "BUDGET" ||
    publicCode === "SCOUT_BACKOFF" ||
    publicCode === "RATE_LIMITED" ||
    publicCode === "SWITCH" ||
    publicCode === "DISABLED"
  ) {
    return "graph lookup unavailable right now";
  }
  if (publicCode === "QUERY_REJECTED") return "query rejected";
  if (publicCode === "SCHEMA_ERROR") return "scout schema unavailable";
  if (publicCode === "QUERY_TIMEOUT") return "graph lookup timed out";
  if (publicCode === "SHAPE_ERROR") return "unexpected scout payload";
  if (publicCode === "BAD_INPUT") return "invalid arguments";
  return "internal error";
}

export function nlqPublicReason(err: unknown): string {
  if (err instanceof ScoutToolError) return reasonForCode(err.code);
  if (err && typeof err === "object" && "error" in err && typeof (err as { error: unknown }).error === "string") {
    return reasonForCode((err as { error: string }).error);
  }
  if (err && typeof err === "object") {
    const code = "code" in err ? String((err as { code: unknown }).code) : "";
    if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|28P01|57P01|08006|EPIPE)$/.test(code)) {
      return "internal error";
    }
  }
  if (err instanceof Error) {
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|postgres|28P01|57P01|08006/i.test(err.message)) {
      return "internal error";
    }
    if (err.message.startsWith("invalid JEB_")) return "internal error";
  }
  return "internal error";
}

function mapToolError(err: { error: string; message: string }): Pick<NlqResult, "outcome" | "reason"> {
  const code = publicScoutErrorCode(err.error);
  if (code === "BUDGET") {
    return { outcome: "budget_exhausted", reason: reasonForCode(code) };
  }
  if (code === "SCOUT_BACKOFF" || code === "RATE_LIMITED") {
    return { outcome: "circuit_open", reason: reasonForCode(code) };
  }
  if (code === "SWITCH" || code === "DISABLED") {
    return { outcome: "switch_off", reason: reasonForCode(code) };
  }
  if (code === "QUERY_REJECTED") {
    return { outcome: "guard_rejected", reason: reasonForCode(code) };
  }
  if (code === "SCHEMA_ERROR") {
    return { outcome: "schema_unavailable", reason: reasonForCode(code) };
  }
  return { outcome: "tool_error", reason: reasonForCode(code) };
}

function publicToolError(err: { error: string; message: string }): { error: string; message: string } {
  const mapped = mapToolError(err);
  return { error: publicScoutErrorCode(err.error), message: mapped.reason };
}

function pinModelScope(req: NlqRequest, tool: AllowedTool, args: Record<string, unknown>): Record<string, unknown> {
  if (req.pubchiMode !== true) return args;
  const pinned = { ...args };
  const scope = scopeForTool(tool, req.question, req.scope);
  if (scope?.graph_scope) pinned.graph_scope = scope.graph_scope;
  else delete pinned.graph_scope;
  if (req.asker && (scope?.graph_scope || tool === "get_emerging_topics")) pinned.asker = req.asker;
  for (const param of TENANT_BOUND_PARAMS[tool] ?? []) {
    if (!req.asker) continue;
    if (param in args && args[param] !== req.asker) {
      log.warn({ event: "tenant_param_rejected", tool, param }, "nlq tenant parameter rejected");
    }
    pinned[param] = req.asker;
  }
  return pinned;
}

/** Codes whose §1 row is already wired through `mapToolError` in `runAsk`. */
function upstreamOutcome(code: string): Pick<NlqResult, "outcome" | "reason"> | null {
  if (code === "SCOUT_CALL_CAP" || code === "SCOUT_TIME_CAP") {
    return { outcome: "tool_error", reason: "graph lookup timed out" };
  }
  if (code === "COMPOSER_DENIED" || code === "COMPOSER_DISABLED" || code === "COMPOSER_COST" || code === "BAD_INPUT") {
    return null;
  }
  return mapToolError({ error: code, message: "" });
}

/**
 * Executes a cypher, chain or feed plan through the injected Pubchi executor
 * and turns the execution into an `NlqResult`: evidence keeps its positional
 * tool, scope comes from the execution, and every failure lands on a §1 row.
 */
async function dispatchPlan(input: {
  plan: ConversationalPlan;
  executor: PlanExecutorPort;
  tools: Record<string, PlanExecutorTool>;
  owner: string;
  meter: ScoutCallMeter;
  nowMs: number;
  question: string;
  plannerTokens: number;
  knowledge?: RemoteKnowledgeClient;
  webSearch?: { search(query: string, k?: number): Promise<unknown> };
  knowledgeBudget?: { allow(owner: string): Promise<boolean> };
}): Promise<NlqResult> {
  let execution: PlanExecution;
  try {
    execution = await input.executor({
      plan: input.plan,
      owner: input.owner,
      tools: input.tools,
      meter: input.meter,
      nowMs: input.nowMs,
      untrustedTexts: [input.question],
      knowledge: input.knowledge,
      webSearch: input.webSearch,
      knowledgeBudget: input.knowledgeBudget,
    });
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, "pubchi plan execution failed");
    return nlqResult({
      outcome: "ok",
      reason: "planner invalid",
      intent: "answer",
      answer: INVALID_PLAN_COPY,
      planKind: "none",
      scope: { time: null, graph: { kind: "none" }, filters: [], complete: false },
      brainTokens: input.plannerTokens,
      meter: input.meter.snapshot(),
    });
  }
  log.info({ event: "nlq_route", route_source: "planner", tool: execution.tools[0] ?? null }, "nlq route");
  const planned: NlqPlannedCall[] = (execution.executed ?? execution.tools.map((tool) => ({ tool, args: {} }))).map((call) => ({
    tool: call.tool as AllowedTool,
    args: call.args,
  }));
  const base = {
    intent: "research_pubky" as const,
    planned,
    results: execution.results,
    toolTrace: execution.results.map((result, index) => ({
      toolCalls: [{ name: execution.tools[index] ?? "", args: {} }],
      result,
    })),
    sources: [...new Set(execution.results.flatMap(collectSources))],
    planKind: execution.kind,
    scope: execution.scope,
    brainTokens: input.plannerTokens,
    meter: input.meter.snapshot(),
    ...(execution.failedStep ? { failedStep: execution.failedStep } : {}),
    ...(execution.message ? { message: execution.message } : {}),
  };
  if (execution.failureCode && execution.results.length === 0 && !execution.message) {
    if (execution.failureCode === "KNOWLEDGE_UNAVAILABLE") {
      return nlqResult({
        ...base,
        outcome: "ok",
        reason: "knowledge unavailable",
        message: "I can't reach Pubky's knowledge sources right now. I can still answer from what I know.",
      });
    }
    if (execution.failureCode === "KNOWLEDGE_BUDGET") {
      return nlqResult({
        ...base,
        outcome: "ok",
        reason: "knowledge budget exceeded",
        message: "I can't reach Pubky's knowledge sources right now. I can still answer from what I know.",
      });
    }
    if (execution.failureCode.startsWith("WEB_")) {
      return nlqResult({
        ...base,
        outcome: "ok",
        reason: "web unavailable",
        message: "I couldn't check the live web right now. I can still answer from what I know.",
      });
    }
    const upstream = upstreamOutcome(execution.failureCode);
    if (upstream) return nlqResult({ ...base, ...upstream });
  }
  return nlqResult({
    ...base,
    outcome: "ok",
    reason: execution.complete ? "ok" : "partial",
    ...(execution.answer ? { answer: execution.answer } : {}),
  });
}

export async function queryNlq(req: NlqRequest, opts: NlqServiceOptions): Promise<NlqResult> {
  const question = typeof req.question === "string" ? req.question : "";
  if (!question.trim()) {
    return nlqResult({
      outcome: "unsupported",
      reason: "question is required",
      intent: "ignore",
    });
  }

  if (!opts.client) {
    return nlqResult({
      outcome: "tool_error",
      reason: "internal error",
      intent: "answer",
    });
  }

  if (scoutBreakerBlocked()) {
    return nlqResult({
      outcome: "circuit_open",
      reason: "graph lookup unavailable right now",
      intent: "answer",
    });
  }

  const storeSwitchOn = opts.storeSwitchOn ?? (async () => false);
  if (await scoutSwitchBlocked(storeSwitchOn)) {
    return nlqResult({
      outcome: "switch_off",
      reason: "graph lookup unavailable right now",
      intent: "answer",
    });
  }

  const client = opts.client;
  let plan;
  try {
    plan = await planNlq(
      { question, asker: req.asker, scope: req.scope, pubchiMode: req.pubchiMode },
      { tables: opts.tables, client, rawEnabled: opts.cfg.scoutRawEnabled, nowMs: req.now_ms ?? Date.now() },
    );
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "nlq planner failed");
    return nlqResult({
      outcome: "tool_error",
      reason: nlqPublicReason(e),
      intent: "answer",
    });
  }

  if (!plan.ok) {
    if (!(req.pubchiMode === true && plan.kind === "unsupported")) {
      const intent = "intent" in plan ? plan.intent : "answer";
      return nlqResult({
        outcome: plan.kind,
        reason: plan.reason,
        intent,
      });
    }
  }

  const ceiling = opts.nlqDailyQueries ?? parseNlqDailyQueries(process.env.JEB_NLQ_DAILY_QUERIES);
  const nlqGate = await checkNlqDailyBudget(opts.pool, ceiling, opts.mentionKey);
  if (nlqGate.blocked) {
    return nlqResult({
      outcome: "budget_exhausted",
      reason: "graph lookup unavailable right now",
      intent: "intent" in plan ? plan.intent : "answer",
      planned: plan.ok ? plan.planned : [],
    });
  }

  const meter = opts.scoutCallMeter ?? new ScoutCallMeter();
  const scout = createScoutTools({
    cfg: opts.cfg,
    pool: opts.pool,
    mentionKey: opts.mentionKey,
    persistent: opts.mentionKey ? isPersistentCallerKey(opts.mentionKey) : undefined,
    storeSwitchOn,
    client: req.pubchiMode === true ? meteredScoutClient(client, meter) : client,
    nowMs: req.now_ms ?? Date.now(),
  });
  const nexus =
    opts.nexus ??
    (opts.cfg.nexusUrl
      ? new Nexus(opts.cfg.nexusUrl)
      : undefined);
  const rest = nexus ? nexusTools(nexus) : undefined;
  let modelFallback = false;
  let plannerTokens = 0;
  let plannerOutcomes: NonNullable<NlqResult["plannerOutcomes"]> = [];
  let plannerFailureCode: string | undefined;
  let planKind: NlqResult["planKind"];
  if (req.pubchiMode === true && !plan.ok && plan.kind === "unsupported") {
    const planner = process.env.PUBCHI_PLANNER_ENABLED === "1" &&
      (opts.plannerCohort?.(req.asker ?? "") ?? true)
      ? await planConversational({
          brain: opts.brain,
          question,
          owner: req.asker,
          ownerContext: req.ownerContext,
          conversationWindow: req.conversationWindow,
          nowMs: req.now_ms ?? Date.now(),
          tools: { ...scout, ...(rest ?? {}) } as ModelPlannerTools,
          screenQuestion: opts.screenQuestion,
          abortSignal: opts.plannerAbortSignal,
        })
      : undefined;
    plannerTokens = planner?.tokens ?? 0;
    plannerOutcomes = planner?.outcomes ?? [];
    plannerFailureCode = planner && !planner.ok ? planner.failureCode : undefined;
    for (const outcome of planner?.outcomes ?? []) {
      log.info({ event: "planner_outcome", ...outcome }, "planner outcome");
    }
    if (planner && !planner.ok) {
      // §1 failure copies. The planner never degrades to "unsupported" here.
      return nlqResult({
        outcome: "ok",
        reason: planner.code === "timeout" ? "planner timeout" : "planner invalid",
        intent: "answer",
        answer: planner.code === "timeout" ? PLANNER_TIMEOUT_COPY : INVALID_PLAN_COPY,
        planKind: "invalid",
        scope: { time: null, graph: { kind: "none" }, filters: [], complete: false },
        brainTokens: plannerTokens,
        plannerFailureCode: planner.failureCode,
        plannerOutcomes: planner.outcomes,
        meter: meter.snapshot(),
      });
    }
    if (planner?.ok && planner.plan.kind === "answer") {
      return nlqResult({
        outcome: "ok",
        reason: planner.plan.reason,
        intent: "answer",
        answer: planner.plan.text,
        planKind: "answer",
        scope: { time: null, graph: { kind: "none" }, filters: [], complete: true },
        brainTokens: plannerTokens,
        plannerOutcomes: planner.outcomes,
        meter: meter.snapshot(),
      });
    }
    if (planner?.ok && planner.plan.kind !== "template" && opts.planExecutor) {
      return dispatchPlan({
        plan: planner.plan,
        executor: opts.planExecutor,
        tools: { ...scout, ...(rest ?? {}) } as unknown as Record<string, PlanExecutorTool>,
        owner: req.asker ?? "",
        meter,
        nowMs: req.now_ms ?? Date.now(),
        question,
        plannerTokens,
        knowledge: opts.knowledge,
        webSearch: opts.webSearch,
        knowledgeBudget: opts.knowledgeBudget,
      });
    }
    if (planner?.ok && planner.plan.kind === "template") planKind = "template";
    const model = planner?.ok && planner.plan.kind === "template"
      ? {
          ok: true as const,
          planned: {
            tool: planner.plan.tool,
            args: {
              ...planner.plan.params,
              ...(planner.plan.scope.graph.kind === "owner_network"
                ? { graph_scope: { pubky: req.asker, hops: planner.plan.scope.graph.hops } }
                : {}),
            },
          },
          consumedTokens: plannerTokens,
        }
      : await modelPlanPubchi({
          brain: opts.brain,
          question,
          tools: { ...scout, ...(rest ?? {}) } as ModelPlannerTools,
          screenQuestion: opts.screenQuestion,
          abortSignal: opts.plannerAbortSignal,
        });
    plannerTokens += model.consumedTokens ?? 0;
    if (!model.ok) {
      log.info({ event: "nlq_route", route_source: "none", tool: null }, "nlq route");
      return nlqResult({
        outcome: "unsupported",
        reason: "no allowlisted typed tool matches this question",
        intent: "intent" in plan ? plan.intent : "answer",
        brainTokens: plannerTokens,
      });
    }
    const schema = loadPlannerSchema();
    if (!schema) {
      log.info({ event: "nlq_route", route_source: "none", tool: null }, "nlq route");
      return nlqResult({
        outcome: "unsupported",
        reason: "no allowlisted typed tool matches this question",
        intent: "intent" in plan ? plan.intent : "answer",
        brainTokens: plannerTokens,
      });
    }
    plan = {
      ok: true,
      intent: plan.intent,
      schema,
      planned: [{ ...model.planned, args: pinModelScope(req, model.planned.tool, model.planned.args) }],
    };
    modelFallback = true;
  }
  if (!plan.ok) throw new Error("unreachable planner state");
  log.info(
    { event: "nlq_route", route_source: modelFallback ? "model" : "regex", tool: plan.planned[0]?.tool ?? null },
    "nlq route",
  );

  const results: unknown[] = [];
  const executedPlanned: NlqPlannedCall[] = [];
  const toolTrace: unknown[] = [];
  const sources: string[] = [];

  for (const call of plan.planned) {
    const scopedArgs = pinModelScope(req, call.tool, call.args);
    const scoutTool = scout[call.tool as keyof typeof scout] as ToolWithSchema | undefined;
    const nexusTool = rest?.[call.tool as keyof NonNullable<typeof rest>] as ToolWithSchema | undefined;
    const tool = scoutTool ?? nexusTool;
    if (!tool) {
      return nlqResult({
        outcome: "unsupported",
        reason: `tool ${call.tool} is not registered on this service`,
        intent: plan.intent,
        planned: plan.planned,
        brainTokens: plannerTokens,
      });
    }
    const parsed = tool.parameters.safeParse(scopedArgs);
    if (!parsed.success) {
      return nlqResult({
        outcome: "unsupported",
        reason: "tool arguments are invalid",
        intent: plan.intent,
        planned: plan.planned,
        brainTokens: plannerTokens,
      });
    }
    const executedArgs = parsed.data as Record<string, unknown>;
    if (call.tool === "get_emerging_topics" && typeof scopedArgs.asker === "string") {
      executedArgs.asker = scopedArgs.asker;
    }
    executedPlanned.push({ tool: call.tool, args: executedArgs });
    let out: unknown;
    try {
      out = await tool.execute(parsed.data as never);
    } catch (e) {
      log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          error_class: e instanceof Error ? e.name : typeof e,
          tool: call.tool,
        },
        "nlq tool failed",
      );
      return nlqResult({
        outcome: "tool_error",
        reason: nlqPublicReason(e),
        intent: plan.intent,
        planned: plan.planned,
        results,
        toolTrace,
        sources,
        brainTokens: plannerTokens,
      });
    }
    if (isPublicToolError(out)) {
      const mapped = mapToolError(out);
      const publicErr = publicToolError(out);
      toolTrace.push({ toolCalls: [{ name: call.tool, args: call.args }], result: publicErr });
      return nlqResult({
        ...mapped,
        intent: plan.intent,
        planned: executedPlanned,
        results: [...results, publicErr],
        toolTrace,
        sources,
        brainTokens: plannerTokens,
      });
    }
    toolTrace.push({ toolCalls: [{ name: call.tool, args: call.args }], result: out });
    results.push(out);
    sources.push(...collectSources(out));
  }

  return {
    outcome: "ok",
    reason: "ok",
    intent: plan.intent,
    planned: executedPlanned,
    results,
    toolTrace,
    sources: [...new Set(sources)],
    brainTokens: plannerTokens,
    ...(plannerOutcomes.length ? { plannerOutcomes } : {}),
    ...(plannerFailureCode ? { plannerFailureCode } : {}),
    ...(planKind ? { planKind } : {}),
    meter: meter.snapshot(),
  };
}
