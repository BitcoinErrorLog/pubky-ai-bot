import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { ToolLoopGenerateResult } from "../answer/tool-loop.js";
import { assertBrainEgressAllowed, hostnameFromBaseUrl, isAllowedBrainHost } from "./egress.js";
import type { Brain, BrainCreateOptions } from "./types.js";

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

export type BrainFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Model HTTP that never follows redirects, so Authorization cannot leave the
 * allowlisted host. A 3xx response is treated as an error even when the
 * underlying fetch does not itself follow it.
 */
export function createGuardedBrainFetch(opts?: {
  fetchImpl?: BrainFetch;
  dangerous?: boolean;
}): BrainFetch {
  const impl = opts?.fetchImpl ?? fetch;
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = hostnameFromBaseUrl(url);
    if (!isAllowedBrainHost(host) && !opts?.dangerous) {
      throw new Error(`brain egress refused: host '${host}'`);
    }
    const res = await impl(input, { ...init, redirect: "error" });
    if (res.status >= 300 && res.status < 400) {
      throw new Error("brain egress redirect refused");
    }
    return res;
  };
}

/**
 * Generic OpenAI-compatible adapter (Vercel AI `createOpenAI`).
 * Used by Jeb today against Moonshot and by the swap proof against any
 * allowlisted OpenAI-compatible base URL.
 */
export function createOpenAICompatibleBrain(opts: BrainCreateOptions & { providerId?: string; fetchImpl?: BrainFetch }): Brain {
  const baseUrl = opts.baseUrl?.trim();
  if (!baseUrl) throw new Error("openai-compatible brain requires a base URL");
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) throw new Error("openai-compatible brain requires an API key");
  assertBrainEgressAllowed(baseUrl, { dangerous: opts.egressDangerous });
  const temperature = opts.temperature ?? 1;
  const maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const providerId = opts.providerId ?? "openai-compatible";
  const createProvider = (providerOptions?: Record<string, unknown>) => {
    const providerBody =
      providerId === "moonshot" && providerOptions?.moonshot && typeof providerOptions.moonshot === "object"
        ? providerOptions.moonshot as Record<string, unknown>
        : undefined;
    const fetchImpl: BrainFetch = async (input, init) => {
      if (!providerBody || !init?.body || typeof init.body !== "string") {
        return (opts.fetchImpl ?? fetch)(input, init);
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return (opts.fetchImpl ?? fetch)(input, {
        ...init,
        body: JSON.stringify({ ...body, ...providerBody }),
      });
    };
    return createOpenAI({
      apiKey,
      baseURL: baseUrl,
      fetch: createGuardedBrainFetch({ fetchImpl, dangerous: opts.egressDangerous }),
    });
  };
  return {
    capabilities: {
      name: opts.model,
      providerId,
      supportsTools: true,
      maxContextTokens,
      samplingDefaults: { temperature },
    },
    temperature,
    generate: async ({ messages, tools: stepTools, temperature: stepTemp, abortSignal, maxOutputTokens, providerOptions }) => {
      const openai = createProvider(providerOptions);
      const out = await generateText({
        model: openai(opts.model),
        messages,
        maxSteps: 1,
        maxRetries: 0,
        temperature: stepTemp,
        abortSignal,
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...(stepTools ? { tools: stepTools } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      } as Parameters<typeof generateText>[0]);
      return out as ToolLoopGenerateResult;
    },
  };
}
