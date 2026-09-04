import type { Store } from "./db.js";
import { log } from "./log.js";
import { lintVoice } from "./voice.js";

export const FALLBACK_CLASSES = ["timeout", "model_error", "tool_unavailable", "budget"] as const;
export type FallbackClass = (typeof FALLBACK_CLASSES)[number];

export const FALLBACK_KIND = "fallback";

const NARROWER_FOLLOWS = "who do my follows follow that I don't?";

export interface FallbackContext {
  /** What Jeb was trying to do, e.g. "your follow graph". */
  task?: string;
  /** Example narrower ask when tools were involved. */
  narrower?: string;
  toolsInvolved?: boolean;
}

const TEMPLATES: Record<FallbackClass, (ctx: Required<Pick<FallbackContext, "task" | "narrower" | "toolsInvolved">>) => string> = {
  timeout: ({ task, narrower, toolsInvolved }) =>
    toolsInvolved
      ? `I couldn't finish pulling ${task} in time. Ask me a narrower cut and I'll get it — for example: ${narrower}`
      : `I ran out of time before I could finish this answer. Ask me a narrower cut and I'll get it — for example: ${narrower}`,
  model_error: ({ narrower }) =>
    `The model didn't complete this turn. Ask again, or give me a narrower cut — for example: ${narrower}`,
  tool_unavailable: ({ narrower }) =>
    `The graph lookup wasn't available just now. Ask again in a bit, or give me a narrower cut — for example: ${narrower}`,
  budget: ({ narrower }) =>
    `I hit the token budget before I could finish. Ask a narrower question and I'll get it — for example: ${narrower}`,
};

export function inferFallbackContext(text: string): FallbackContext {
  const t = text.trim();
  if (/\bfollow/i.test(t)) {
    return { task: "your follow graph", narrower: NARROWER_FOLLOWS, toolsInvolved: true };
  }
  if (/\b(graph|scout|tag|topic)\b/i.test(t)) {
    return { task: "the Pubky graph lookup", narrower: "one account or one tag", toolsInvolved: true };
  }
  return { task: "this answer", narrower: NARROWER_FOLLOWS, toolsInvolved: false };
}

export function fallbackReply(reason: FallbackClass, ctx: FallbackContext = {}): string {
  const filled = {
    task: ctx.task ?? "this answer",
    narrower: ctx.narrower ?? NARROWER_FOLLOWS,
    toolsInvolved: ctx.toolsInvolved ?? false,
  };
  const raw = TEMPLATES[reason](filled);
  const linted = lintVoice(raw);
  if (linted.violations.length) {
    throw new Error(`fallback ${reason} failed voice lint: ${linted.violations.map((v) => v.rule).join(",")}`);
  }
  return linted.text;
}

export function classifyAnswerFailure(err: unknown): FallbackClass {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /abort/i.test(msg) || /timeout/i.test(msg)) {
    return "timeout";
  }
  if (/token budget/i.test(msg) || /budget exceeded/i.test(msg)) return "budget";
  if (
    /unavailable/i.test(msg) ||
    /RATE_LIMITED/i.test(msg) ||
    /graph lookup/i.test(msg) ||
    /\bDISABLED\b/.test(msg) ||
    /\bSWITCH\b/.test(msg)
  ) {
    return "tool_unavailable";
  }
  return "model_error";
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || name === "TimeoutError" || /abort/i.test(msg);
}

/** Insert exactly one fallback publish request. Duplicate active keys are a no-op. */
export async function queueFallbackReply(opts: {
  store: Store;
  mentionKey: string;
  parentUri: string;
  reason: FallbackClass;
  context?: FallbackContext;
}): Promise<boolean> {
  if (await opts.store.hasActivePublish(opts.mentionKey)) return false;
  const content = fallbackReply(opts.reason, opts.context);
  const evidenceId = await opts.store.insertEvidence({
    mentionKey: opts.mentionKey,
    intent: "decline",
    toolTrace: [{ kind: FALLBACK_KIND, fallback_reason: opts.reason }],
    sources: [],
    model: null,
    tokens: 0,
    latencyMs: 0,
    categories: ["declined"],
    kind: FALLBACK_KIND,
    fallbackReason: opts.reason,
  });
  const inserted = await opts.store.insertPublishRequest({
    mentionKey: opts.mentionKey,
    parentUri: opts.parentUri,
    content,
    evidenceId,
    categories: ["declined"],
  });
  if (inserted) {
    await opts.store.mark(opts.mentionKey, "processing", { fallbackReason: opts.reason });
    log.warn({ mention_key: opts.mentionKey, fallback_reason: opts.reason, kind: FALLBACK_KIND }, "fallback reply queued");
  }
  return inserted;
}
