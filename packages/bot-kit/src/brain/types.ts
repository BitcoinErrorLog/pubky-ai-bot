import type { ToolLoopGenerate, ToolLoopModel } from "../answer/tool-loop.js";

/** Phase 0 brain ids. No OpenAI/Anthropic/Groq adapters. */
export type BrainId = "moonshot" | "openai-compatible" | "ollama";

export type BrainSamplingDefaults = {
  temperature: number;
};

/**
 * Negotiation/capabilities descriptor. Phase 0 is the ToolLoopModel seam
 * plus this record. Fuller BrainInput/BrainOutput schemas are Phase 1.
 */
export type BrainCapabilities = {
  name: string;
  providerId: string;
  supportsTools: boolean;
  maxContextTokens: number;
  samplingDefaults: BrainSamplingDefaults;
};

/**
 * Stateless inference adapter. No memory, no per-tenant state, no
 * loadThread/saveThread/remember. A failure is an error the caller sees;
 * nothing in this package falls back to another brain.
 */
export type Brain = ToolLoopModel & {
  readonly capabilities: BrainCapabilities;
  readonly generate: ToolLoopGenerate;
  readonly temperature: number;
};

export type BrainCreateOptions = {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  /** When true, non-allowlisted hosts log a warning instead of throwing. */
  egressDangerous?: boolean;
  maxContextTokens?: number;
};
