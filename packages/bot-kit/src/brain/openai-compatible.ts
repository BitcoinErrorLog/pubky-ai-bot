import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { ToolLoopGenerateResult } from "../answer/tool-loop.js";
import { assertBrainEgressAllowed } from "./egress.js";
import type { Brain, BrainCreateOptions } from "./types.js";

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

/**
 * Generic OpenAI-compatible adapter (Vercel AI `createOpenAI`).
 * Used by Jeb today against Moonshot and by the swap proof against any
 * allowlisted OpenAI-compatible base URL.
 */
export function createOpenAICompatibleBrain(opts: BrainCreateOptions & { providerId?: string }): Brain {
  const baseUrl = opts.baseUrl?.trim();
  if (!baseUrl) throw new Error("openai-compatible brain requires a base URL");
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) throw new Error("openai-compatible brain requires an API key");
  assertBrainEgressAllowed(baseUrl, { dangerous: opts.egressDangerous });
  const temperature = opts.temperature ?? 1;
  const maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const providerId = opts.providerId ?? "openai-compatible";
  const openai = createOpenAI({ apiKey, baseURL: baseUrl });
  return {
    capabilities: {
      name: opts.model,
      providerId,
      supportsTools: true,
      maxContextTokens,
      samplingDefaults: { temperature },
    },
    temperature,
    generate: async ({ messages, tools: stepTools, temperature: stepTemp, abortSignal }) => {
      const out = await generateText({
        model: openai(opts.model),
        messages,
        maxSteps: 1,
        maxRetries: 0,
        temperature: stepTemp,
        abortSignal,
        ...(stepTools ? { tools: stepTools } : {}),
      } as Parameters<typeof generateText>[0]);
      return out as ToolLoopGenerateResult;
    },
  };
}
