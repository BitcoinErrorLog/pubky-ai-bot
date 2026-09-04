import { tool, type CoreMessage } from "ai";
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
  usage?: { totalTokens?: number };
  response: { messages: CoreMessage[] };
};

export type ToolLoopGenerate = (args: {
  messages: CoreMessage[];
  tools?: Record<string, unknown>;
  temperature: number;
  abortSignal: AbortSignal;
}) => Promise<ToolLoopGenerateResult>;

export type ToolLoopModel = {
  generate: ToolLoopGenerate;
  temperature: number;
};

export type ToolLoopOutcome = "complete" | "deadline" | "budget";

export type CreateToolLoopOptions = {
  model: ToolLoopModel;
  tools: Record<string, ToolLoopSpec>;
  screen: ToolLoopScreen;
  compose: ToolLoopCompose;
  timeouts: ToolLoopTimeouts;
  budgets: ToolLoopBudgets;
  identity?: ToolLoopIdentity;
  addenda?: ToolLoopAddenda;
  beforeTool?: (name: string) => Promise<void>;
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
      return screened.value as R;
    } catch (e) {
      recordMs();
      if (isAbort(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (fatal.has(msg)) throw e;
      const screened = opts.screen({ error: msg }, { tool: name });
      if (screened.flags.length) state.screenFlags.push(...screened.flags);
      return screened.value as R;
    }
  };

  const registered: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(opts.tools)) {
    registered[name] = tool({
      description: spec.description,
      parameters: spec.parameters as never,
      execute: wrap(name, spec.execute),
    });
  }

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
    let hasEvidence = false;
    let budgetExhausted = false;
    let outcome: ToolLoopOutcome = "complete";
    const remaining = () => deadline - Date.now();

    const generate = (stepMessages: CoreMessage[], stepTools: Record<string, unknown> | undefined, signal: AbortSignal) =>
      opts.model.generate({
        messages: stepMessages,
        tools: stepTools,
        temperature: opts.model.temperature,
        abortSignal: signal,
      });

    for (let step = 0; step < opts.budgets.toolMaxSteps; step++) {
      if (input.abortSignal?.aborted) throw abortError();
      if (remaining() <= reserve) {
        budgetExhausted = true;
        outcome = "budget";
        break;
      }
      const stepMs = Math.min(opts.timeouts.modelTimeoutMs, Math.max(1, remaining() - reserve));
      try {
        const out = await runWithStepTimeout(stepMs, input.abortSignal, (signal) =>
          generate(messages, registered, signal),
        );
        trace.push({
          toolCalls: out.toolCalls?.map((c) => ({ name: c.toolName, args: c.args })),
        });
        if (stepHasEvidence(out)) hasEvidence = true;
        if (out.text.trim()) text = out.text;
        tokens += out.usage?.totalTokens ?? 0;
        messages = [...messages, ...(out.response.messages as CoreMessage[])];
        if (!out.toolCalls?.length) {
          return {
            text,
            tokens: tokens || null,
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
      { role: "user", content: opts.compose.fromEvidencePrompt },
    ];
    const composeMs = Math.min(opts.timeouts.modelTimeoutMs, Math.max(1, remaining()));
    try {
      const out = await runWithStepTimeout(composeMs, input.abortSignal, (signal) =>
        generate(composeMessages, undefined, signal),
      );
      if (out.text.trim()) text = out.text;
      tokens += out.usage?.totalTokens ?? 0;
    } catch (e) {
      if (input.abortSignal?.aborted) throw abortError();
      if (!isAbort(e) && !text.trim()) throw e;
      if (!text.trim()) text = opts.compose.deterministicText;
    }
    if (!text.trim()) text = opts.compose.deterministicText;
    return {
      text,
      tokens: tokens || null,
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
