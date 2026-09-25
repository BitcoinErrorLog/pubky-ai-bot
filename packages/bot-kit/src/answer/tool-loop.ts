import { tool, zodSchema, type CoreMessage } from "ai";
import type { ScreenFlag } from "../security/tool-screen.js";

export type ToolLoopIdentity = {
  /** System prompt body. Kit does not bake a bot name. */
  systemPrompt: string;
  /** §2.3 role label; used by the caller’s thread assembler, not the loop. */
  assistantRoleLabel?: string;
  /** §2.3 intro line; used by the caller’s thread assembler, not the loop. */
  introLine?: (botPk: string) => string;
};

export type ToolLoopAddenda = {
  security?: string;
  knowledge?: string;
  scout?: string;
  capability?: string;
  webSearch?: string;
  pubkyOnly?: string;
  guidance?: string;
  /** Already-prefixed extras (evidence map, translate, …). */
  extra?: string;
};

export type ToolLoopTimeouts = {
  modelTimeoutMs: number;
};

export type ToolLoopBudgets = {
  answerBudgetMs: number;
  toolMaxSteps: number;
};

export type ToolLoopCompose = {
  fromEvidencePrompt: string;
  deterministicText: string;
};

export type ToolLoopScreen = (
  value: unknown,
  opts: { tool: string },
) => { value: unknown; flags: ScreenFlag[] };

export type ToolLoopSpec = {
  description: string;
  parameters: unknown;
  execute: (args: never) => Promise<unknown>;
};

export type ToolLoopGenerateResult = {
  text: string;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
  toolResults?: unknown[];
  finishReason?: string;
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
  response: { messages: CoreMessage[] };
};

export type ToolLoopGenerate = (args: {
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  temperature: number;
  abortSignal: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
}) => Promise<ToolLoopGenerateResult>;

export type ToolLoopModel = {
  generate: ToolLoopGenerate;
  temperature: number;
};

export type ToolLoopOutcome = "complete" | "deadline" | "budget";

/** Caller-supplied policy. The loop executes `tool` before the model and before any other tool. */
export type KnowledgeFirstRoute = {
  tool: string;
  args: unknown;
  /** Names omitted from the model catalog when `allowGraphTools` is false. */
  graphTools: readonly string[];
  allowGraphTools: boolean;
};

export type CreateToolLoopOptions = {
  model: ToolLoopModel;
  tools: Record<string, ToolLoopSpec>;
  screen: ToolLoopScreen;
  compose: ToolLoopCompose;
  timeouts: ToolLoopTimeouts;
  budgets: ToolLoopBudgets;
  identity?: ToolLoopIdentity;
  addenda?: ToolLoopAddenda;
  maxOutputTokens?: number;
  knowledgeFirst?: KnowledgeFirstRoute;
  beforeModel?: (call: {
    messages: CoreMessage[];
    toolSchemas: unknown[];
    maxOutputTokens: number | undefined;
  }) => Promise<CoreMessage[] | void>;
  beforeTool?: (name: string) => Promise<void>;
  afterTool?: (name: string, value: unknown) => Promise<void>;
  takeAdditionalMessages?: () => CoreMessage[];
  knowledgeTool?: (name: string) => boolean;
  isAbortError?: (err: unknown) => boolean;
  fatalToolMessages?: readonly string[];
};

export type ToolLoopRunInput = {
  prompt: string;
  abortSignal?: AbortSignal;
};

export type ToolLoopResult = {
  text: string;
  tokens: number | null;
  imageCallTokens: number | null;
  hasEvidence: boolean;
  budgetExhausted: boolean;
  outcome: ToolLoopOutcome;
  toolTrace: unknown[];
  screenFlags: ScreenFlag[];
  knowledgeMs: number;
  toolsMs: number;
  system: string;
};

export type ToolLoop = {
  system: string;
  tools: Record<string, unknown>;
  run: (input: ToolLoopRunInput) => Promise<ToolLoopResult>;
};

const DEFAULT_FATAL = ["generation switch on", "token budget exceeded"] as const;

/** Same join as Jeb `answer.ts` before the step-10 move. Empty addenda stay empty (extra spaces). */
export function assembleAnswerSystemPrompt(
  identity: Pick<ToolLoopIdentity, "systemPrompt">,
  addenda: ToolLoopAddenda = {},
): string {
  const security = addenda.security ?? "";
  const pubkyOnly = addenda.pubkyOnly ? `${addenda.pubkyOnly} ` : "";
  const knowledge = addenda.knowledge ?? "";
  const scout = addenda.scout ?? "";
  const capability = addenda.capability ?? "";
  const webSearch = addenda.webSearch ?? "";
  const guidance = addenda.guidance ? ` ${addenda.guidance}` : "";
  const extra = addenda.extra ?? "";
  return `${identity.systemPrompt} ${security} ${pubkyOnly}${knowledge} ${scout} ${capability} ${webSearch}${guidance}${extra}`;
}

export function defaultIsAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || name === "TimeoutError" || /abort/i.test(msg);
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function composeReserveMs(timeouts: ToolLoopTimeouts, budgets: ToolLoopBudgets): number {
  const budget = budgets.answerBudgetMs;
  return Math.min(timeouts.modelTimeoutMs, Math.max(500, Math.floor(budget * 0.2)));
}

function stepHasEvidence(out: { text: string; toolCalls?: unknown[]; toolResults?: unknown[] }): boolean {
  if (out.text.trim()) return true;
  if (out.toolCalls && out.toolCalls.length > 0) return true;
  if (out.toolResults && out.toolResults.length > 0) return true;
  return false;
}

function withFlags(trace: unknown[], screenFlags: ScreenFlag[], budgetExhausted: boolean): unknown[] {
  const out = [...trace];
  if (budgetExhausted) out.push({ budget_exhausted: true });
  if (screenFlags.length) out.push({ screening_flags: screenFlags });
  return out;
}

function containsImage(messages: CoreMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part && typeof part === "object" && "type" in part && part.type === "image"));
}

async function runWithStepTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) throw abortError();
  const ac = new AbortController();
  const onParent = () => ac.abort();
  parent?.addEventListener("abort", onParent);
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
    parent?.removeEventListener("abort", onParent);
  }
}

/**
 * Generic generateText step loop: wrap/register tools, per-step timeout,
 * overall answer budget, in-band `{error}` tool results, screening, tokens, trace.
 */
export function createToolLoop(opts: CreateToolLoopOptions): ToolLoop {
  const identity = opts.identity ?? { systemPrompt: "" };
  const addenda = opts.addenda ?? {};
  const system = assembleAnswerSystemPrompt(identity, addenda);
  const isAbort = opts.isAbortError ?? defaultIsAbortError;
  const fatal = new Set(opts.fatalToolMessages ?? DEFAULT_FATAL);
  const state = { screenFlags: [] as ScreenFlag[], knowledgeMs: 0, toolsMs: 0 };

  const wrap = <A, R>(name: string, fn: (args: A) => Promise<R>) => async (args: A): Promise<R> => {
    if (opts.beforeTool) await opts.beforeTool(name);
    const toolStarted = Date.now();
    const recordMs = () => {
      const toolMs = Date.now() - toolStarted;
      if (opts.knowledgeTool?.(name)) state.knowledgeMs += toolMs;
      else state.toolsMs += toolMs;
    };
    try {
      const out = await fn(args);
      recordMs();
      const screened = opts.screen(out, { tool: name });
      if (screened.flags.length) state.screenFlags.push(...screened.flags);
      if (opts.afterTool) await opts.afterTool(name, screened.value);
      return screened.value as R;
    } catch (e) {
      recordMs();
      if (isAbort(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (fatal.has(msg)) throw e;
      const screened = opts.screen({ error: msg }, { tool: name });
      if (screened.flags.length) state.screenFlags.push(...screened.flags);
      if (opts.afterTool) await opts.afterTool(name, screened.value);
      return screened.value as R;
    }
  };

  const registered: Record<string, unknown> = {};
  const toolSchemas: Array<{ name: string; description: string; parameters: unknown }> = [];
  for (const [name, spec] of Object.entries(opts.tools)) {
    const parameters = zodSchema(spec.parameters as never).jsonSchema;
    toolSchemas.push({ name, description: spec.description, parameters });
    registered[name] = tool({
      description: spec.description,
      parameters: spec.parameters as never,
      execute: wrap(name, spec.execute),
    });
  }
  const graphNames = new Set(opts.knowledgeFirst?.graphTools ?? []);
  const modelTools = !opts.knowledgeFirst || opts.knowledgeFirst.allowGraphTools
    ? registered
    : Object.fromEntries(Object.entries(registered).filter(([name]) => !graphNames.has(name)));
  const schemasFor = (stepTools: Record<string, unknown> | undefined): unknown[] => {
    if (!stepTools) return [];
    const names = new Set(Object.keys(stepTools));
    return toolSchemas.filter((schema) => names.has(schema.name));
  };

  const run = async (input: ToolLoopRunInput): Promise<ToolLoopResult> => {
    state.screenFlags = [];
    state.knowledgeMs = 0;
    state.toolsMs = 0;
    const trace: unknown[] = [];
    const deadline = Date.now() + opts.budgets.answerBudgetMs;
    const reserve = composeReserveMs(opts.timeouts, opts.budgets);
    let messages: CoreMessage[] = [
      { role: "system", content: system },
      { role: "user", content: input.prompt },
    ];
    let text = "";
    let tokens = 0;
    let imageCallTokens = 0;
    let imageUsageObserved = false;
    let imageUsageUnknown = false;
    let hasEvidence = false;
    let budgetExhausted = false;
    let outcome: ToolLoopOutcome = "complete";
    const remaining = () => deadline - Date.now();

    const route = opts.knowledgeFirst;
    if (route) {
      if (input.abortSignal?.aborted) throw abortError();
      const spec = opts.tools[route.tool];
      if (!spec) throw new Error(`knowledge route requires registered tool ${route.tool}`);
      const toolCallId = "knowledge-first";
      const value = await wrap(route.tool, spec.execute)(route.args as never);
      hasEvidence = true;
      trace.push({ toolCalls: [{ name: route.tool, args: route.args }] });
      messages = [
        ...messages,
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId, toolName: route.tool, args: route.args }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId, toolName: route.tool, result: value }],
        },
      ];
    }

    const generate = async (stepMessages: CoreMessage[], stepTools: Record<string, unknown> | undefined, signal: AbortSignal) => {
      const boundedMessages = (await opts.beforeModel?.({
        messages: stepMessages,
        toolSchemas: schemasFor(stepTools),
        maxOutputTokens: opts.maxOutputTokens,
      })) ?? stepMessages;
      const imageBearing = containsImage(boundedMessages);
      try {
        const out = await opts.model.generate({
          messages: boundedMessages,
          tools: stepTools,
          temperature: opts.model.temperature,
          abortSignal: signal,
          maxOutputTokens: opts.maxOutputTokens,
        });
        return { out, imageBearing };
      } catch (error) {
        if (imageBearing) imageUsageUnknown = true;
        throw error;
      }
    };

    for (let step = 0; step < opts.budgets.toolMaxSteps; step++) {
      if (input.abortSignal?.aborted) throw abortError();
      if (remaining() <= reserve) {
        budgetExhausted = true;
        outcome = "budget";
        break;
      }
      const stepMs = Math.min(opts.timeouts.modelTimeoutMs, Math.max(1, remaining() - reserve));
      try {
        const additional = opts.takeAdditionalMessages?.() ?? [];
        if (additional.length) messages = [...messages, ...additional];
        const generated = await runWithStepTimeout(stepMs, input.abortSignal, (signal) =>
          generate(messages, modelTools, signal),
        );
        const out = generated.out;
        trace.push({
          toolCalls: out.toolCalls?.map((c) => ({ name: c.toolName, args: c.args })),
        });
        if (stepHasEvidence(out)) hasEvidence = true;
        if (out.text.trim()) text = out.text;
        tokens += out.usage?.totalTokens ?? 0;
        if (generated.imageBearing && out.usage?.totalTokens !== undefined) {
          imageCallTokens += out.usage.totalTokens;
          imageUsageObserved = true;
        }
        messages = [...messages, ...(out.response.messages as CoreMessage[])];
        if (!out.toolCalls?.length) {
          return {
            text,
            tokens: tokens || null,
            imageCallTokens: imageUsageObserved && !imageUsageUnknown ? imageCallTokens : null,
            hasEvidence,
            budgetExhausted,
            outcome,
            toolTrace: withFlags(trace, state.screenFlags, budgetExhausted),
            screenFlags: [...state.screenFlags],
            knowledgeMs: state.knowledgeMs,
            toolsMs: state.toolsMs,
            system,
          };
        }
      } catch (e) {
        if (input.abortSignal?.aborted) throw abortError();
        if (isAbort(e) && hasEvidence) {
          budgetExhausted = true;
          outcome = "deadline";
          break;
        }
        if (isAbort(e)) {
          return {
            text,
            tokens: tokens || null,
            imageCallTokens: imageUsageObserved && !imageUsageUnknown ? imageCallTokens : null,
            hasEvidence,
            budgetExhausted: true,
            outcome: "deadline",
            toolTrace: withFlags(trace, state.screenFlags, true),
            screenFlags: [...state.screenFlags],
            knowledgeMs: state.knowledgeMs,
            toolsMs: state.toolsMs,
            system,
          };
        }
        throw e;
      }
    }

    if (!hasEvidence && !text.trim()) {
      return {
        text: "",
        tokens: tokens || null,
        imageCallTokens: imageUsageObserved && !imageUsageUnknown ? imageCallTokens : null,
        hasEvidence: false,
        budgetExhausted,
        outcome: budgetExhausted ? outcome : "complete",
        toolTrace: withFlags(trace, state.screenFlags, budgetExhausted),
        screenFlags: [...state.screenFlags],
        knowledgeMs: state.knowledgeMs,
        toolsMs: state.toolsMs,
        system,
      };
    }
    const composeMessages: CoreMessage[] = [
      ...messages,
      ...(opts.takeAdditionalMessages?.() ?? []),
      { role: "user", content: opts.compose.fromEvidencePrompt },
    ];
    const composeMs = Math.min(opts.timeouts.modelTimeoutMs, Math.max(1, remaining()));
    try {
      const generated = await runWithStepTimeout(composeMs, input.abortSignal, (signal) =>
        generate(composeMessages, undefined, signal),
      );
      const out = generated.out;
      if (out.text.trim()) text = out.text;
      tokens += out.usage?.totalTokens ?? 0;
      if (generated.imageBearing && out.usage?.totalTokens !== undefined) {
        imageCallTokens += out.usage.totalTokens;
        imageUsageObserved = true;
      }
    } catch (e) {
      if (input.abortSignal?.aborted) throw abortError();
      const msg = e instanceof Error ? e.message : String(e);
      if (fatal.has(msg)) throw e;
      if (!isAbort(e) && !text.trim()) throw e;
      if (!text.trim()) text = opts.compose.deterministicText;
    }
    if (!text.trim()) text = opts.compose.deterministicText;
    return {
      text,
      tokens: tokens || null,
      imageCallTokens: imageUsageObserved && !imageUsageUnknown ? imageCallTokens : null,
      hasEvidence: true,
      budgetExhausted,
      outcome,
      toolTrace: withFlags(trace, state.screenFlags, budgetExhausted),
      screenFlags: [...state.screenFlags],
      knowledgeMs: state.knowledgeMs,
      toolsMs: state.toolsMs,
      system,
    };
  };

  return { system, tools: registered, run };
}
