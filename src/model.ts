import type { Brain, BrainId } from "./bot-kit/brain/index.js";
import { createBrain } from "./bot-kit/brain/index.js";
import type { Config } from "./config.js";

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
  "brain" | "model" | "modelApiKey" | "modelBaseUrl" | "modelTemperature" | "brainEgressDangerous"
>;

/** Select exactly one brain. Failures are not retried on another adapter. */
export function createJebBrain(cfg: JebBrainConfig): Brain {
  const id: BrainId = cfg.brain ?? "moonshot";
  return createBrain({
    id,
    model: cfg.model,
    apiKey: cfg.modelApiKey,
    baseUrl: cfg.modelBaseUrl,
    temperature: modelTemperature(cfg),
    egressDangerous: cfg.brainEgressDangerous === true,
  });
}

export async function completeReply(cfg: Config, prompt: string): Promise<{ text: string; tokens: number | null }> {
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    return { text: cfg.cannedReply.slice(0, 2000), tokens: 0 };
  }
  if (cfg.brain !== "ollama" && !cfg.modelApiKey) throw new Error("no model key");
  const brain = createJebBrain(cfg);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.modelTimeoutMs);
  try {
    const out = await brain.generate({
      messages: [{ role: "user", content: prompt }],
      temperature: brain.temperature,
      abortSignal: ac.signal,
    });
    const tokens = out.usage?.totalTokens ?? null;
    return { text: out.text.slice(0, 2000), tokens: tokens ?? null };
  } finally {
    clearTimeout(t);
  }
}
