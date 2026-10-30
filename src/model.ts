import type { Brain, BrainId } from "./bot-kit/brain/index.js";
import {
  createBrain,
  modelRouteSnapshot,
  runWithModelFallback,
  withModelFallback,
  type ModelAttempt,
  type ModelFallbackEvent,
  type ModelRouteSnapshot,
} from "./bot-kit/brain/index.js";
import type { Config } from "./config.js";
import { metrics } from "./metrics.js";

export const DEFAULT_MODEL_FALLBACK_AFTER_MS = 60_000;

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Sampling temperature for every model call. Never rely on SDK/provider
 * defaults: Moonshot's kimi-k3 rejects any temperature other than 1, so the
 * unset fallback is an explicit 1. Override with JEB_MODEL_TEMPERATURE (0..2).
 */
export function modelTemperature(cfg: Pick<Config, "modelTemperature">): number {
  return cfg.modelTemperature ?? 1;
}

export type JebBrainConfig = Pick<
  Config,
  | "brain"
  | "model"
  | "modelApiKey"
  | "modelBaseUrl"
  | "modelTemperature"
  | "brainEgressDangerous"
  | "brainSupportsImages"
  | "modelFallback"
  | "modelFallbackAfterMs"
>;

/** The configured fallback model, or undefined when none is set or it equals the primary. */
export function activeModelFallback(cfg: Pick<Config, "model" | "modelFallback">): string | undefined {
  const fb = cfg.modelFallback?.trim();
  return fb && fb !== cfg.model ? fb : undefined;
}

/**
 * Per-step model time budget. With a fallback configured the primary may use
 * its first-response window before the fallback gets the usual budget.
 */
export function modelStepTimeoutMs(
  cfg: Pick<Config, "model" | "modelFallback" | "modelFallbackAfterMs" | "modelTimeoutMs">,
): number {
  return activeModelFallback(cfg)
    ? cfg.modelTimeoutMs + (cfg.modelFallbackAfterMs ?? DEFAULT_MODEL_FALLBACK_AFTER_MS)
    : cfg.modelTimeoutMs;
}

/** Configured routing plus what has answered so far; safe for /healthz (model names only). */
export function jebModelRouting(
  cfg: Pick<Config, "model" | "modelFallback" | "modelFallbackAfterMs">,
): ModelRouteSnapshot {
  const fallback = activeModelFallback(cfg) ?? null;
  return {
    ...modelRouteSnapshot(),
    primary: cfg.model,
    fallback,
    fallbackAfterMs: fallback ? (cfg.modelFallbackAfterMs ?? DEFAULT_MODEL_FALLBACK_AFTER_MS) : null,
  };
}

function recordModelMetric(event: ModelFallbackEvent): void {
  if (event.kind === "answered") metrics.incrementModelAnswer(event.model, event.role);
  else if (event.kind === "fallback") metrics.incrementModelFallback(event.reason);
}

/**
 * Select the primary brain, plus one same-provider fallback model when
 * JEB_MODEL_FALLBACK is set. The fallback shares the key and base URL and is
 * tried once, only for 429/overload, 5xx, transport errors or a primary that
 * has not answered within JEB_MODEL_FALLBACK_AFTER_MS.
 */
export function createJebBrain(cfg: JebBrainConfig): Brain {
  const id: BrainId = cfg.brain ?? "moonshot";
  const make = (model: string): Brain =>
    createBrain({
      id,
      model,
      apiKey: cfg.modelApiKey,
      baseUrl: cfg.modelBaseUrl,
      temperature: modelTemperature(cfg),
      egressDangerous: cfg.brainEgressDangerous === true,
      supportsImages: cfg.brainSupportsImages ?? id === "moonshot",
    });
  const primary = make(cfg.model);
  const fallbackModel = activeModelFallback(cfg);
  return withModelFallback(primary, fallbackModel ? make(fallbackModel) : null, {
    primaryTimeoutMs: cfg.modelFallbackAfterMs ?? DEFAULT_MODEL_FALLBACK_AFTER_MS,
    onEvent: recordModelMetric,
  });
}

export async function completeReply(cfg: Config, prompt: string): Promise<{ text: string; tokens: number | null }> {
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    return { text: cfg.cannedReply.slice(0, 2000), tokens: 0 };
  }
  if (cfg.brain !== "ollama" && !cfg.modelApiKey) throw new Error("no model key");
  const brain = createJebBrain(cfg);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), modelStepTimeoutMs(cfg));
  try {
    const out = await brain.generate({
      messages: [{ role: "user", content: prompt }],
      temperature: brain.temperature,
      maxOutputTokens: cfg.modelMaxOutputTokens,
      abortSignal: ac.signal,
    });
    const tokens = out.usage?.totalTokens ?? null;
    return { text: out.text.slice(0, 2000), tokens: tokens ?? null };
  } finally {
    clearTimeout(t);
  }
}

export type JebDirectModelConfig = Pick<Config, "model" | "modelFallback" | "modelFallbackAfterMs" | "modelTimeoutMs">;

/**
 * For call sites that use the SDK directly (weekly, drafts): run one request
 * on JEB_MODEL with the same single fallback as createJebBrain, inside the
 * per-step budget from modelStepTimeoutMs.
 */
export async function callJebModel<T>(cfg: JebDirectModelConfig, call: (attempt: ModelAttempt) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), modelStepTimeoutMs(cfg));
  try {
    return await runWithModelFallback(
      {
        primary: cfg.model,
        fallback: activeModelFallback(cfg) ?? null,
        primaryTimeoutMs: cfg.modelFallbackAfterMs ?? DEFAULT_MODEL_FALLBACK_AFTER_MS,
        onEvent: recordModelMetric,
      },
      ac.signal,
      call,
    );
  } finally {
    clearTimeout(t);
  }
}
