import { createHostedMoonshotBrain } from "./moonshot.js";
import { createOllamaBrain } from "./ollama.js";
import { createOpenAICompatibleBrain } from "./openai-compatible.js";
import type { Brain, BrainCreateOptions, BrainId } from "./types.js";

export type CreateBrainOptions = BrainCreateOptions & { id: BrainId };

/**
 * Construct exactly one brain. Unknown ids throw. A later generate()
 * failure must not be caught here — there is no fallback between brains.
 */
export function createBrain(opts: CreateBrainOptions): Brain {
  switch (opts.id) {
    case "moonshot":
      return createHostedMoonshotBrain(opts);
    case "openai-compatible":
      return createOpenAICompatibleBrain(opts);
    case "ollama":
      return createOllamaBrain(opts);
    default: {
      const _never: never = opts.id;
      throw new Error(`unknown brain '${String(_never)}'`);
    }
  }
}
