import { ConversationalPlan, type PlanRef } from "../bot-kit/nlq/conversational-plan.js";
import { composeCypher, revalidateResolvedParams, type ComposeInput, type ComposeOk } from "../bot-kit/scout/composer.js";
import { ScoutCallBudgetError, type ComposedQueryBudget, type ScoutCallMeter } from "../bot-kit/scout/budget.js";
import type { ExecutionScope, PlanExecution, PlanExecutorTool } from "../bot-kit/nlq/plan-port.js";
import { executionScope, mergeExecutionScopes, scopeForNoLookup } from "./execution-scope.js";
import { parseConversationalPlanForPubchi } from "./conversational-plan.js";
import type { RemoteKnowledgeClient } from "../bot-kit/knowledge/remote-client.js";
import { screenAskUntrusted } from "./screen.js";
import type { PubchiKnowledgeBudget } from "./knowledge-budget.js";
import { normalizeForMatching } from "../bot-kit/security/injection-detector.js";

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
  knowledge?: RemoteKnowledgeClient;
  webSearch?: { search(query: string, k?: number): Promise<unknown> };
  knowledgeBudget?: PubchiKnowledgeBudget;
  ownerContext?: string;
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
export const OWNER_CONTEXT_SEARCH_COPY =
  "I can't use your private notes in an outside search.";

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
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "upstream_error";
}

/** Copy for failures the service decided locally; upstream codes get none. */
function localDenialCopy(code: string): string | undefined {
  if (code === "COMPOSER_COST") return COMPOSER_COST_COPY;
  if (code === "COMPOSER_DENIED" || code === "COMPOSER_DISABLED" || code === "BAD_INPUT") return COMPOSER_DENIED_COPY;
  if (code === "OWNER_CONTEXT_SEARCH") return OWNER_CONTEXT_SEARCH_COPY;
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
type Executed = { tool: string; args: Record<string, unknown>; label: string };

function stepLabel(action: Extract<ConversationalPlan, { kind: "template" | "cypher" | "knowledge" | "web" | "answer" }>): string {
  if (action.kind === "knowledge") return "Pubky knowledge";
  if (action.kind === "web") return "live web";
  if (action.kind === "answer") return "answer";
  if (action.kind === "cypher") return "their tags";
  if (action.tool === "rank_users" && action.params.metric === "tags_applied") return "ranked taggers";
  if (action.tool === "get_user_tags") return "their tags";
  return action.tool.replaceAll("_", " ");
}

function resultHasNoRows(value: unknown): boolean {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!object) return false;
  const envelope = object.envelope && typeof object.envelope === "object" && !Array.isArray(object.envelope)
    ? object.envelope as Record<string, unknown>
    : object;
  const resultKeys = ["results", "users", "topics", "posts", "tags", "items"];
  const lists = resultKeys.map((key) => envelope[key]).filter(Array.isArray);
  return lists.length > 0 && lists.every((list) => list.length === 0);
}

function numberParam(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const COMMON_SEARCH_WORDS = new Set(["about", "answer", "context", "graph", "knowledge", "homeservers", "owner", "public", "search", "the", "this", "with"]);

/**
 * Owner-context fragments are never retrieval authority. Before knowledge or web search, the executor NFKC-normalizes query and owner fields, folds diacritics and common Latin-lookalike confusables, treats spaces, underscores, and hyphens as equivalent, and rejects a query containing a complete owner field, a distinctive owner token, a space-collapsed query matching a distinctive token, a camelCase-split owner token, or an eight-character shingle from a distinctive owner token. A token is distinctive when it is at least eight characters, contains at least three characters and both letters and digits, contains at least six digits, or contains a non-letter, non-digit compound marker; common vocabulary such as "homeservers" alone and pure short numbers or years do not trigger the guard. Cross-token shingles are intentionally omitted to avoid blocking ordinary phrase overlap such as "I love bitcoin" versus "do you love bitcoin" and "skiing trips" versus "best skiing trips in japan".
 */
function queryContainsOwnerContext(query: string, ownerContext: string | undefined): boolean {
  if (!ownerContext) return false;
  const normalizedQuery = normalizeForMatching(query);
  const collapsedQuery = normalizedQuery.replace(/ /g, "");
  const fields = [...ownerContext.matchAll(/^(?:About|Instructions):\s*(.+)$/gim)]
    .map((match) => ({
      value: normalizeForMatching(match[1]),
      camelCaseTokens: match[1]
        .split(/\s+/)
        .flatMap((token) => token.split(/(?<=[\p{Ll}\d])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu))
        .map((token) => normalizeForMatching(token))
        .filter(Boolean),
    }))
    .filter(Boolean);
  return fields.some(({ value: field, camelCaseTokens }) => {
    if (normalizedQuery.includes(field)) return true;
    const tokens = [...field.split(" "), ...camelCaseTokens];
    const distinctiveTokens = tokens.filter((token) =>
      !COMMON_SEARCH_WORDS.has(token) &&
      (
        token.length >= 8 ||
        (token.length >= 3 && /\p{L}/u.test(token) && /\d/.test(token)) ||
        /^\d{6,}$/.test(token) ||
        /[^\p{L}\d\s]/u.test(token)
      ),
    );
    if (distinctiveTokens.some((token) => normalizedQuery.includes(token) || collapsedQuery.includes(token))) return true;
    for (const token of distinctiveTokens) {
      for (let index = 0; index <= token.length - 8; index += 1) {
        if (normalizedQuery.includes(token.slice(index, index + 8))) return true;
      }
    }
    return false;
  });
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
  action: Extract<ConversationalPlan, { kind: "template" | "cypher" | "knowledge" | "web" | "answer" }>,
  opts: PlanExecutorOptions,
  outputs: Map<string, unknown>,
): Promise<{ result: unknown; executed: Executed }> {
  if (action.kind === "knowledge") {
    if (!opts.knowledge) throw new PlanStepError("KNOWLEDGE_UNAVAILABLE");
    if (queryContainsOwnerContext(action.query, opts.ownerContext)) throw new PlanStepError("OWNER_CONTEXT_SEARCH");
    if (opts.knowledgeBudget && !(await opts.knowledgeBudget.allow(opts.owner))) throw new PlanStepError("KNOWLEDGE_BUDGET");
    try {
      const result = await opts.knowledge.search(String(screenAskUntrusted(action.query)), action.k ?? 6);
      return { result, executed: { tool: "knowledge", args: { k: action.k ?? 6 }, label: "Pubky knowledge" } };
    } catch {
      throw new PlanStepError("KNOWLEDGE_UNAVAILABLE");
    }
  }
  if (action.kind === "web") {
    if (!opts.webSearch) throw new PlanStepError("WEB_DISABLED");
    if (queryContainsOwnerContext(action.query, opts.ownerContext)) throw new PlanStepError("OWNER_CONTEXT_SEARCH");
    const result = await opts.webSearch.search(String(screenAskUntrusted(action.query)), action.k ?? 5);
    const failure = publicToolErrorCode(result);
    if (failure) throw new PlanStepError(failure);
    return { result, executed: { tool: "web", args: { k: action.k ?? 5 }, label: "live web" } };
  }
  if (action.kind === "answer") {
    return { result: null, executed: { tool: "answer", args: {}, label: "answer" } };
  }
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
    const execute = opts.tools.query_graph.executeComposed ?? opts.tools.query_graph.execute;
    const result = await execute({
      cypher: composed.cypher,
      params: composed.params,
      limit: composed.limit,
    } as never);
    const composedFailure = publicToolErrorCode(result);
    // The canonical guard is the last word on a composed query: when it refuses
    // one the composer approved, the answer is the denial copy, not an outage.
    if (composedFailure === "QUERY_REJECTED") throw new PlanStepError("COMPOSER_DENIED");
    if (composedFailure) throw new PlanStepError(composedFailure);
    return { result, executed: { tool: "query_graph", args: cypherExecutionArgs(composed, opts.owner), label: stepLabel(action) } };
  }
  const tool = opts.tools[action.tool];
  if (!tool) throw new PlanStepError("BAD_INPUT");
  const parsed = tool.parameters.safeParse(resolve(action.params, outputs));
  if (!parsed.success) throw new PlanStepError("BAD_INPUT");
  const args = parsed.data as Record<string, unknown>;
  const result = await tool.execute(args as never);
  const failure = publicToolErrorCode(result);
  if (failure) throw new PlanStepError(failure);
  return { result, executed: { tool: action.tool, args, label: stepLabel(action) } };
}

function scopeOfExecutions(executed: Executed[], nowMs: number, complete: boolean): ExecutionScope {
  return mergeExecutionScopes(
    executed.map((entry) => executionScope(undefined, entry.args, nowMs, complete)),
    complete,
  );
}

/**
 * Name what completed and what failed. Never claim a specific finding the
 * execution did not produce.
 */
function failureDescription(code: string): string {
  if (code === "QUERY_TIMEOUT") return "timed out";
  if (code === "COMPOSER_DENIED" || code === "COMPOSER_DISABLED" || code === "QUERY_REJECTED") return "was rejected as unsafe";
  if (code === "EMPTY_RESULT") return "returned nothing";
  return "couldn't be completed";
}

function partialChainMessageForFailure(
  completed: Executed[],
  failedIndex: number,
  failed: Extract<ConversationalPlan, { kind: "template" | "cypher" | "knowledge" | "web" | "answer" }>,
  failureCode: string,
): string {
  const failedLabel = stepLabel(failed);
  const failure = failureDescription(failureCode);
  if (completed.length === 0) return `I couldn't complete the first lookup (${failedLabel}): it ${failure}.`;
  const completedLabel = completed.map((entry) => entry.label).join(", ");
  const ordinal = ["first", "second", "third"][failedIndex] ?? `${failedIndex + 1}th`;
  return `I completed step${completed.length === 1 ? "" : "s"} ${completed.map((_, index) => index + 1).join(" and ")} (${completedLabel}) but step ${failedIndex + 1} (${failedLabel}) ${failure}; I can't answer the ${ordinal} part yet.`;
}

export async function executeConversationalPlan(opts: PlanExecutorOptions): Promise<PlanExecution> {
  const parsed = parseConversationalPlanForPubchi(opts.plan);
  if (!parsed.success) {
    const base = ConversationalPlan.safeParse(opts.plan);
    if (base.success && base.data.kind === "feed") {
      return { kind: "feed", results: [], tools: [], scope: scopeForNoLookup(false), complete: false, message: FEED_INVALID_COPY };
    }
    throw new Error("invalid conversational plan");
  }
  const plan = parsed.data;
  const composedCypherEnabled = opts.composedCypherEnabled ?? process.env.PUBCHI_COMPOSED_CYPHER_ENABLED === "1";
  if (plan.kind === "answer") {
    return { kind: "answer", results: [], tools: [], scope: scopeForNoLookup(true), complete: true, answer: plan.text };
  }
  if (plan.kind === "knowledge" || plan.kind === "web") {
    try {
      const executed = await executeAction(plan, opts, new Map());
      return {
        kind: "answer",
        results: [executed.result],
        tools: [executed.executed.tool],
        scope: scopeForNoLookup(true),
        complete: true,
        executed: [{ tool: executed.executed.tool, args: executed.executed.args }],
      };
    } catch (error) {
      return {
        kind: "answer",
        results: [],
        tools: [],
        scope: scopeForNoLookup(false),
        complete: false,
        failureCode: failureCodeOf(error),
        ...(localDenialCopy(failureCodeOf(error)) ? { message: localDenialCopy(failureCodeOf(error)) } : {}),
      };
    }
  }
  if (plan.kind === "feed") {
    return {
      kind: "feed",
      results: [],
      tools: [],
      scope: scopeForNoLookup(true),
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
      scope: scopeForNoLookup(false),
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
      executed: [{ tool: executedStep.executed.tool, args: executedStep.executed.args }],
    };
  }
  const outputs = new Map<string, unknown>();
  const results: unknown[] = [];
  const executedSteps: Executed[] = [];
  let ownerContextBlocked = false;
  for (const [stepIndex, step] of plan.steps.entries()) {
    const denial = (message: string | undefined, failureCode: string): PlanExecution => ({
      kind: "chain",
      results,
      tools: executedSteps.map((entry) => entry.tool),
      scope: scopeOfExecutions(executedSteps, opts.nowMs, false),
      complete: false,
      failedStep: step.id,
      failureCode,
      ...(message ? { message } : {}),
      executed: executedSteps.map((entry) => ({ tool: entry.tool, args: entry.args })),
    });
    try {
      const action = step.action;
      if (action.kind === "cypher" && !composedCypherEnabled) return denial(COMPOSER_DENIED_COPY, "COMPOSER_DISABLED");
      if (action.kind === "cypher" && opts.composedQueryBudget && !(await opts.composedQueryBudget.allow(opts.owner))) {
        return denial(COMPOSER_COST_COPY, "COMPOSER_COST");
      }
      const { result, executed } = await executeAction(action, opts, outputs);
      if ((action.kind !== "template" || action.tool !== "get_emerging_topics") && resultHasNoRows(result)) {
        throw new PlanStepError("EMPTY_RESULT");
      }
      outputs.set(step.id, result);
      results.push(result);
      executedSteps.push(executed);
      opts.meter.assertBudget();
    } catch (error) {
      const failureCode = failureCodeOf(error);
      if (failureCode === "OWNER_CONTEXT_SEARCH") {
        ownerContextBlocked = true;
        continue;
      }
      // Partial evidence survives: name the completed steps and the failed one
      // rather than the local-denial copy, which would hide what did run.
      return denial(
        partialChainMessageForFailure(executedSteps, stepIndex, step.action, failureCode),
        failureCode,
      );
    }
  }
  return {
    kind: "chain",
    results,
    tools: executedSteps.map((entry) => entry.tool),
    scope: scopeOfExecutions(executedSteps, opts.nowMs, true),
    complete: !ownerContextBlocked,
    ...(ownerContextBlocked ? { message: OWNER_CONTEXT_SEARCH_COPY } : {}),
    executed: executedSteps.map((entry) => ({ tool: entry.tool, args: entry.args })),
  };
}
