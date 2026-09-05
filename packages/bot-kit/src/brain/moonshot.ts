import { MOONSHOT_BASE_URL } from "./egress.js";
import { createOpenAICompatibleBrain } from "./openai-compatible.js";
import type { Brain, BrainCreateOptions } from "./types.js";

/** Moonshot Kimi K3 context window advertised for the hosted API. */
export const MOONSHOT_MAX_CONTEXT_TOKENS = 256_000;

/**
 * Thin Moonshot preset over the OpenAI-compatible adapter.
 * Default base URL and temperature 1 (kimi-k3 rejects other values).
 * Caller-supplied base URL still wins so tests and today's env stay identical.
 */
export function createHostedMoonshotBrain(opts: BrainCreateOptions): Brain {
  const brain = createOpenAICompatibleBrain({
    ...opts,
    baseUrl: opts.baseUrl?.trim() || MOONSHOT_BASE_URL,
    temperature: opts.temperature ?? 1,
    maxContextTokens: opts.maxContextTokens ?? MOONSHOT_MAX_CONTEXT_TOKENS,
    providerId: "moonshot",
  });
  return {
    ...brain,
    capabilities: {
      ...brain.capabilities,
      name: opts.model,
      providerId: "moonshot",
    },
  };
}
