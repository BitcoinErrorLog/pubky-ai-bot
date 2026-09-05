import { OLLAMA_BASE_URL } from "./egress.js";
import { createOpenAICompatibleBrain } from "./openai-compatible.js";
import type { Brain, BrainCreateOptions } from "./types.js";

/** qwen2.5:7b / llama3.1:8b typical context. */
export const OLLAMA_MAX_CONTEXT_TOKENS = 32_768;

/**
 * Local Ollama adapter. Same OpenAI-compatible client, pointed at loopback.
 * Supplies a dummy API key because Ollama does not authenticate and the
 * generic adapter requires a key string. Usage/tool-call differences are
 * handled here rather than inside the generic adapter.
 */
export function createOllamaBrain(opts: BrainCreateOptions): Brain {
  const brain = createOpenAICompatibleBrain({
    ...opts,
    baseUrl: opts.baseUrl?.trim() || OLLAMA_BASE_URL,
    apiKey: opts.apiKey?.trim() || "ollama",
    temperature: opts.temperature ?? 0.7,
    maxContextTokens: opts.maxContextTokens ?? OLLAMA_MAX_CONTEXT_TOKENS,
    providerId: "ollama",
  });
  return {
    ...brain,
    capabilities: {
      ...brain.capabilities,
      name: opts.model,
      providerId: "ollama",
    },
    generate: async (args) => {
      const out = await brain.generate(args);
      return {
        ...out,
        usage: out.usage ?? { totalTokens: undefined },
      };
    },
  };
}
