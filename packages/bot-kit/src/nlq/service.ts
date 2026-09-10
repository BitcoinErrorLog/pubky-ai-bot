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
import { loadPlannerSchema, normalizePubchiCourtesyPrefix, parseRankingWindow, planNlq, scopeForTool } from "./planner.js";
import { modelPlanPubchi, type ModelPlannerTools } from "./model-planner.js";
import { deterministicFeedPlan, INVALID_PLAN_COPY, PLANNER_TIMEOUT_COPY, planConversational } from "./conversational-planner.js";
import type { ConversationalPlan, ExecutionPlanScope } from "./conversational-plan.js";
import type { ExecutionScope, PlanExecution, PlanExecutorPort, PlanExecutorTool } from "./plan-port.js";
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

function previousUserQuestion(conversationWindow: string | undefined): string | null {
  const questions = (conversationWindow ?? "")
    .split("\n")
    .filter((line) => line.startsWith("USER:"))
    .map((line) => line.slice("USER:".length).trim())
    .filter(Boolean);
  return questions.at(-1) ?? null;
}

function isRelativeFollowup(question: string): boolean {
  const normalized = question.trim().replace(/[?!.,;:]+$/g, "").trim();
  return /^(?:and\s+)?(?:what|how)\s+about\b/i.test(normalized)
    || /^same\s+(?:for|but)\b/i.test(normalized)
    || /^what\s+about\b/i.test(normalized)
    || /^(?:and\s+for|now\s+(?:for|show))\b/i.test(normalized)
    || /^(?:and\s+)?(?:(?:this|last)\s+(?:week|month|year)|in\s+my\s+network|(?:in\s+the\s+)?whole\s+graph)$/i.test(normalized)
    || /^(?:last|this)\s+\d+\s+days?$/i.test(normalized)
    || /^and\s+the\s+top\s+\d+\s*$/i.test(normalized)
    || /^(?:and\s+)?(?:#[-\w]+|(?:tag|user)\s+[-\w]+)$/i.test(normalized);
}

function hasExplicitFollowupWindow(question: string): boolean {
  return /\b(?:today|this|last)\s+(?:week|month|year|\d+\s+days?)\b|\b(?:all[\s-]?time|ever)\b/i.test(question);
}

function followupWindow(question: string, nowMs: number): { since: number; until: number } | "all_time" | null {
  return hasExplicitFollowupWindow(question) ? parseRankingWindow(question, nowMs) : null;
}

function followupTopic(question: string): string | undefined {
  return question.match(/#([a-zA-Z0-9_-]{1,20})/)?.[1]
    ?? question.match(/\b(?:tag|user)\s+([a-zA-Z0-9_-]{2,52})\b/i)?.[1];
}

function deterministicKnowledgePlan(question: string, knowledge?: RemoteKnowledgeClient): ConversationalPlan | null {
  if (!knowledge) return null;
  const normalized = normalizePubchiCourtesyPrefix(question);
  if (!/^(?:what|who|how|why|explain|tell me about|describe)\b[\s\S]*\b(?:pubky|homeserver|pkarr|nexus|pubchi|paykit|bitkit|pubky\s+ring|synonym|censorship|keys?|recovery\s+phrase|self-custod)\b/i.test(normalized)) {
    return null;
  }
  if (/\bhow\s+many\b|\b(?:number|count)\s+of\b|\b(?:users?|followers?|tags?|posts?)\s+(?:count|number)\b/i.test(normalized)) {
    return null;
  }
  return { kind: "knowledge", query: normalized, k: 6 };
}

function deterministicWebPlan(question: string, tables: IntentRegexTables): ConversationalPlan | null {
  const normalized = normalizePubchiCourtesyPrefix(question);
  if (!tables.researchWeb.test(normalized) && !tables.currentEvents.test(normalized)) return null;
  if (!/\b(?:latest|news|current|today|this\s+week|this\s+month|recent|happen(?:ed|ing)?|price)\b/i.test(normalized)) return null;
  return { kind: "web", query: normalized, k: 5 };
}

async function deterministicFollowup(
  req: NlqRequest,
  opts: NlqServiceOptions,
): Promise<ConversationalPlan | null> {
  const question = normalizePubchiCourtesyPrefix(req.question);
  if (req.pubchiMode !== true || !isRelativeFollowup(question)) return null;
  const previous = previousUserQuestion(req.conversationWindow);
  if (!previous) return null;
  const routed = await planNlq(
    { question: previous, asker: req.asker, scope: req.scope, pubchiMode: true },
    { tables: opts.tables, client: opts.client, rawEnabled: opts.cfg.scoutRawEnabled, nowMs: req.now_ms ?? Date.now() },
  );
  if (!routed.ok || routed.planned.length !== 1) return null;

  const nowMs = req.now_ms ?? Date.now();
  const previousCall = routed.planned[0];
  const params = { ...previousCall.args };
  const window = followupWindow(question, nowMs);
  if (window) {
    params.time_range = window === "all_time"
      ? { since: 0, until: nowMs }
      : window;
  }
  const existingWindow = typeof params.time_range === "object" && params.time_range
    ? params.time_range as Record<string, unknown>
    : undefined;
  const existingSince = typeof existingWindow?.since === "number" ? existingWindow.since : nowMs - 30 * 24 * 60 * 60 * 1000;
  const existingUntil = typeof existingWindow?.until === "number" ? existingWindow.until : nowMs;
  const existingDays = Math.max(1, Math.round((existingUntil - existingSince) / (24 * 60 * 60 * 1000)));
  const scope: ExecutionPlanScope = {
    window: {
      since_ms: window === "all_time" ? 0 : window?.since ?? existingSince,
      until_ms: window === "all_time" ? nowMs : window?.until ?? existingUntil,
      source: window ? "explicit" as const : existingWindow ? "explicit" as const : "default" as const,
      label: window === "all_time"
        ? "all time"
        : window
          ? (/last\s+month/i.test(question) ? "last month" : /year/i.test(question) ? "last year" : `last ${Math.round((window.until - window.since) / (24 * 60 * 60 * 1000))} days`)
          : existingWindow
            ? `last ${existingDays} days`
            : "last 30 days",
    },
    graph: { kind: "whole_graph" as const },
  };
  const graphDelta = /\bwhole\s+graph\b/i.test(question)
    ? { kind: "whole_graph" as const }
    : /\b(?:in\s+my\s+network|my\s+network|people\s+i\s+follow)\b/i.test(question)
      ? { kind: "owner_network" as const, ...(req.asker ? { hops: 1 } : {}) }
      : null;
  if (graphDelta) {
    scope.graph = graphDelta;
    if (graphDelta.kind === "whole_graph") delete params.graph_scope;
    else if (req.asker) params.graph_scope = { pubky: req.asker };
  } else if (params.graph_scope) {
    scope.graph = { kind: "owner_network", hops: 1 };
  }
  const limit = question.match(/\btop\s+(\d+)\b/i)?.[1];
  if (limit) params.limit = Math.min(50, Math.max(1, Number(limit)));
  const topic = followupTopic(question);
  if (topic) {
    for (const key of ["topic", "tag", "pubky"]) {
      if (key in params) params[key] = topic;
    }
  }
  return {
    kind: "template",
    tool: previousCall.tool,
    params,
    scope,
  } as ConversationalPlan;
}

function scopeFromDeterministicPlan(plan: ConversationalPlan): ExecutionScope | undefined {
  if (plan.kind !== "template") return undefined;
  return {
    time: {
      since_ms: plan.scope.window.since_ms,
      until_ms: plan.scope.window.until_ms,
      label: plan.scope.window.label,
      source: plan.scope.window.source,
    },
    graph: {
      kind: plan.scope.graph.kind,
      ...(plan.scope.graph.hops ? { hops: plan.scope.graph.hops as 1 | 2 | 3 } : {}),
    },
    filters: [],
    complete: true,
  };
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
  knowledgeRoute?: "deterministic" | "planner" | "none";
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
    ...(execution.feed !== undefined ? { feed: execution.feed } : {}),
    ...(input.knowledgeRoute ? { knowledgeRoute: input.knowledgeRoute } : {}),
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
  const deterministicFeed = req.pubchiMode === true ? deterministicFeedPlan(normalizePubchiCourtesyPrefix(question)) : null;
  const deterministicKnowledge = req.pubchiMode === true ? deterministicKnowledgePlan(question, opts.knowledge) : null;
  const deterministicWeb = req.pubchiMode === true ? deterministicWebPlan(question, opts.tables) : null;
  let plan;
  if (deterministicFeed || deterministicKnowledge || deterministicWeb) {
    plan = { ok: false as const, kind: "unsupported" as const, reason: "deterministic conversational route", intent: "research_pubky" as const };
  } else {
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
  }
  const deterministicPlan = req.pubchiMode === true ? await deterministicFollowup(req, opts) : null;
  if (!plan.ok) {
    if (!(deterministicPlan || (req.pubchiMode === true && plan.kind === "unsupported"))) {
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
  let plannerSource: NlqResult["plannerSource"];
  let executionReq = req;
  const conversationalDeterministicPlan = deterministicFeed ?? deterministicKnowledge ?? deterministicPlan ?? deterministicWeb;
  if (conversationalDeterministicPlan || (req.pubchiMode === true && !plan.ok && plan.kind === "unsupported")) {
    const followup = conversationalDeterministicPlan;
    if (followup?.kind === "template" && followup.scope.graph.kind === "whole_graph") {
      executionReq = { ...req, scope: { ...req.scope, graph_scope: undefined } };
    }
    const planner = followup
      ? { ok: true as const, plan: followup, calls: 0, tokens: 0, outcomes: [] }
      : process.env.PUBCHI_PLANNER_ENABLED === "1" &&
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
    if (deterministicPlan) {
      plannerSource = "followup_deterministic";
      log.info(
        { event: "planner_outcome", run_id: req.run_id ?? null, source: plannerSource, plan_kind: "template", calls: 0, tokens: 0, tokens_prompt: 0, tokens_completion: 0, estimated: false },
        "planner outcome",
      );
    }
    plannerTokens = planner?.tokens ?? 0;
    plannerOutcomes = planner?.outcomes ?? [];
    plannerFailureCode = planner && !planner.ok ? planner.failureCode : undefined;
    for (const outcome of planner?.outcomes ?? []) {
      log.info({ event: "planner_outcome", run_id: req.run_id ?? null, ...outcome }, "planner outcome");
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
        ...(plannerSource ? { plannerSource } : {}),
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
        ...(plannerSource ? { plannerSource } : {}),
        meter: meter.snapshot(),
      });
    }
    if (planner?.ok && planner.plan.kind !== "template" && opts.planExecutor) {
      const dispatched = await dispatchPlan({
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
        knowledgeRoute: deterministicKnowledge
          ? "deterministic"
          : planner.plan.kind === "knowledge" || (planner.plan.kind === "chain" && planner.plan.steps.some((step) => step.action.kind === "knowledge"))
            ? "planner"
            : undefined,
      });
      return plannerSource ? { ...dispatched, plannerSource } : dispatched;
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
                ? { graph_scope: { pubky: executionReq.asker, hops: planner.plan.scope.graph.hops } }
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
      intent: "intent" in plan ? plan.intent : "research_pubky",
      schema,
      planned: [{ ...model.planned, args: pinModelScope(executionReq, model.planned.tool, model.planned.args) }],
    };
    modelFallback = !followup;
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
    const scopedArgs = pinModelScope(executionReq, call.tool, call.args);
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
        ...(plannerSource ? { plannerSource } : {}),
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
        ...(plannerSource ? { plannerSource } : {}),
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
        ...(plannerSource ? { plannerSource } : {}),
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
        ...(plannerSource ? { plannerSource } : {}),
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
    ...(plannerSource ? { plannerSource } : {}),
    knowledgeRoute: deterministicKnowledge ? "deterministic" : "none",
    ...(deterministicPlan ? { scope: scopeFromDeterministicPlan(deterministicPlan) } : {}),
    meter: meter.snapshot(),
  };
}
